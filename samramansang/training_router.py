"""
Training Router Module
학습 관련 API 엔드포인트들을 관리하는 모듈
"""

import subprocess
import threading
import json
import os
import glob
import time
import re
import logging
from aiohttp import web

# 로깅 설정
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('training.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('training')


# 전역 학습 관리자
training_process = None
training_status = {
    'state': 'idle',
    'is_running': False,
    'is_complete': False,
    'current_step': '',
    'progress': 0,
    'current_epoch': 0,
    'total_epochs': 0,
    'current_loss': 0,
    'best_loss': None,
    'start_time': None,
    'log_entries': []
}
training_lock = threading.Lock()


def run_clustering_only_pipeline(config):
    """클러스터링만 실행하는 파이프라인"""
    global training_status
    
    logger.info(f"🚀 클러스터링 전용 파이프라인 시작: {config}")
    
    # 클러스터링 전용 모드에서도 is_running 상태 설정
    with training_lock:
        training_status['is_running'] = True
        training_status['state'] = 'running'
        training_status['is_complete'] = False
        logger.info("✅ 클러스터링 모드에서 is_running = True 설정")
    
    try:
        # 1. 클러스터링 및 세그먼트화
        with training_lock:
            training_status['current_step'] = '클러스터링 시작'
            training_status['progress'] = 60
            logger.info("📊 클러스터링 단계 시작")
        
        # 절대 경로로 변환
        embeddings_path = config.get('embeddings_path', 'runs/embeddings.npy')
        if not os.path.isabs(embeddings_path):
            embeddings_path = os.path.abspath(embeddings_path)
        
        logger.info(f"📁 임베딩 파일 경로: {embeddings_path}")
        logger.info(f"📁 임베딩 파일 존재 여부: {os.path.exists(embeddings_path)}")
        
        cluster_cmd = [
            'python', 'cluster_and_segment.py',
            '--embeddings', embeddings_path,
            '--out', 'runs/segments.json',
            '--algo', config.get('algorithm', 'hdbscan'),
            '--k', str(config.get('clusters', 8)),
            '--min_len', str(config.get('min_length', 5)),
            '--merge_gap', str(config.get('merge_gap', 2)),
            '--split_criterion', config.get('split_criterion', 'neutral'),
            '--max_len_windows', str(config.get('max_len_windows', 10)),
            '--window', str(config['window']),
            '--stride', str(config['stride'])
        ]
        # Optional edge trimming towards neutral
        if config.get('trim_edges'):
            cluster_cmd += ['--trim_edges']
        cluster_cmd += ['--edge_radius', str(config.get('edge_radius', 3))]
        
        # HDBSCAN 전용 파라미터
        if config.get('algorithm') == 'hdbscan':
            cluster_cmd.extend([
                '--hdb_min_cluster', str(config.get('hdb_min_cluster', 5)),
                '--hdb_min_samples', str(config.get('hdb_min_samples', 3))
            ])
        
        # Ensure unbuffered python for real-time logs
        if cluster_cmd and cluster_cmd[0] == 'python':
            cluster_cmd.insert(1, '-u')
        logger.info(f"🔧 클러스터링 명령어: {' '.join(cluster_cmd)}")
        print(f"[CLUSTERING] {' '.join(cluster_cmd)}")
        # Stream logs line-by-line
        process = subprocess.Popen(
            cluster_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1
        )
        for line in iter(process.stdout.readline, ''):
            if not training_status['is_running']:
                try:
                    process.terminate()
                except Exception:
                    pass
                break
            s = line.rstrip('\n')
            if s:
                print(f"[CLUSTERING] {s}")
                with training_lock:
                    training_status['log_entries'].append({
                        'message': s,
                        'level': 'info',
                        'timestamp': time.time(),
                        'epoch': 0,
                        'step': training_status.get('current_step', '')
                    })
                    if len(training_status['log_entries']) > 200:
                        training_status['log_entries'] = training_status['log_entries'][-200:]
        rc = process.wait()
        if rc != 0:
            raise subprocess.CalledProcessError(rc, cluster_cmd)
        
        with training_lock:
            training_status['current_step'] = '클러스터링 완료'
            training_status['progress'] = 75
            logger.info("✅ 클러스터링 단계 완료")
        
        # 2. 대표 샘플 선택
        with training_lock:
            training_status['current_step'] = '대표 샘플 선택 중'
            training_status['progress'] = 85
            logger.info("🎯 대표 샘플 선택 단계 시작")
        
        reps_cmd = [
            'python', 'select_representatives.py',
            '--embeddings', embeddings_path,
            '--segments', 'runs/segments.json',
            '--method', str(config.get('rep_method', 'per_label_k')),
            '--per_label_k', str(config.get('rep_k', 5)),
            '--threshold', str(config.get('rep_thr', 0.25)),
            '--out', 'runs/segments_representative.json'
        ]
        # Ensure unbuffered python for real-time logs
        if reps_cmd and reps_cmd[0] == 'python':
            reps_cmd.insert(1, '-u')
        logger.info(f"🔧 대표 샘플 선택 명령어: {' '.join(reps_cmd)}")
        print(f"[REPRESENTATIVES] {' '.join(reps_cmd)}")
        reps_proc = subprocess.Popen(
            reps_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1
        )
        for line in iter(reps_proc.stdout.readline, ''):
            if not training_status['is_running']:
                try:
                    reps_proc.terminate()
                except Exception:
                    pass
                break
            s = line.rstrip('\n')
            if s:
                print(f"[REPRESENTATIVES] {s}")
                with training_lock:
                    training_status['log_entries'].append({
                        'message': s,
                        'level': 'info',
                        'timestamp': time.time(),
                        'epoch': 0,
                        'step': training_status.get('current_step', '')
                    })
                    if len(training_status['log_entries']) > 200:
                        training_status['log_entries'] = training_status['log_entries'][-200:]
        rc = reps_proc.wait()
        if rc != 0:
            raise subprocess.CalledProcessError(rc, reps_cmd)
        
        with training_lock:
            training_status['current_step'] = '클러스터링 파이프라인 완료'
            training_status['progress'] = 100
            training_status['is_running'] = False
            training_status['state'] = 'completed'
            training_status['is_complete'] = True
            logger.info("🎉 클러스터링 파이프라인 완료!")
            
            # 완료 메시지가 이미 있는지 확인
            completion_message = '🎉 클러스터링이 성공적으로 완료되었습니다!'
            existing_messages = [entry['message'] for entry in training_status['log_entries']]
            
            if completion_message not in existing_messages:
                training_status['log_entries'].append({
                    'message': completion_message,
                    'level': 'success',
                    'timestamp': time.time(),
                    'epoch': 0,
                    'step': '완료'
                })
    
    except subprocess.CalledProcessError as e:
        logger.error(f"❌ 클러스터링 subprocess 실패: {e}")
        logger.error(f"❌ stderr: {e.stderr}")
        logger.error(f"❌ stdout: {e.stdout}")
        with training_lock:
            training_status['current_step'] = '클러스터링 실패'
            training_status['is_running'] = False
            training_status['state'] = 'failed'
            training_status['is_complete'] = False
            training_status['log_entries'].append({
                'message': f'❌ 클러스터링이 실패했습니다: {e.stderr}',
                'level': 'error',
                'timestamp': time.time(),
                'epoch': 0,
                'step': '실패'
            })
    except Exception as e:
        logger.error(f"❌ 클러스터링 일반 오류: {str(e)}", exc_info=True)
        with training_lock:
            training_status['current_step'] = '클러스터링 오류'
            training_status['is_running'] = False
            training_status['state'] = 'failed'
            training_status['is_complete'] = False
            training_status['log_entries'].append({
                'message': f'❌ 클러스터링 중 오류 발생: {str(e)}',
                'level': 'error',
                'timestamp': time.time(),
                'epoch': 0,
                'step': '오류'
            })


def run_training_pipeline(config):
    """학습 파이프라인 실행"""
    global training_status
    
    logger.info(f"🚀 전체 학습 파이프라인 시작: {config}")
    
    try:
        training_mode = config.get('training_mode', 'full')
        logger.info(f"📋 학습 모드: {training_mode}")
        
        with training_lock:
            training_status['is_running'] = True  # 파이프라인 시작 시 is_running 설정
            training_status['state'] = 'running'
            training_status['is_complete'] = False
            if training_mode == 'full':
                training_status['current_step'] = '전체 파이프라인 시작'
                training_status['progress'] = 5
            else:
                training_status['current_step'] = '클러스터링만 시작'
                training_status['progress'] = 60  # 클러스터링 단계부터 시작
        
        # training 폴더로 이동
        training_dir = os.path.join(os.getcwd(), 'training')
        logger.info(f"📁 작업 디렉토리 변경: {training_dir}")
        os.chdir(training_dir)
        logger.info(f"📁 현재 디렉토리: {os.getcwd()}")
        
        if training_mode == 'full':
            # 전체 파이프라인 실행
            logger.info("🔄 전체 파이프라인 모드 실행")
            cmd = [
                'python', 'run_pipeline.py',
                '--data_glob', config['data_glob'],
                '--window', str(config['window']),
                '--stride', str(config['stride']),
                '--epochs', str(config['epochs']),
                '--batch_size', str(config['batch_size']),
                '--lr', str(config['lr']),
                '--weight_decay', str(config.get('weight_decay', 1e-4)),
                '--temperature', str(config.get('temperature', 0.1)),
                '--workers', str(config.get('workers', 4)),
                '--device', 'cuda' if os.system('nvidia-smi > /dev/null 2>&1') == 0 else 'cpu',
                '--algo', config.get('algorithm', 'hdbscan'),
                '--k', str(config.get('clusters', 8)),
                '--min_len', str(config.get('min_length', 5)),
                '--merge_gap', str(config.get('merge_gap', 2)),
                '--split_criterion', config.get('split_criterion', 'neutral'),
                '--max_len_windows', str(config.get('max_len_windows', 10)),
                # edge trimming
                *(['--trim_edges'] if config.get('trim_edges') else []),
                '--edge_radius', str(config.get('edge_radius', 3)),
                '--rep_method', config.get('rep_method', 'per_label_k'),
                '--rep_k', str(config.get('rep_k', 5)),
                '--rep_thr', str(config.get('rep_thr', 0.25))
            ]
            
            # HDBSCAN 전용 파라미터
            if config.get('algorithm') == 'hdbscan':
                cmd.extend([
                    '--hdb_min_cluster', str(config.get('hdb_min_cluster', 5)),
                    '--hdb_min_samples', str(config.get('hdb_min_samples', 3))
                ])
        
        else:  # training_mode == 'clustering'
            # 클러스터링만 실행 (여러 단계로 나누어 실행)
            logger.info("🎯 클러스터링 전용 모드 실행")
            run_clustering_only_pipeline(config)
            return
        
        with training_lock:
            if training_mode == 'full':
                training_status['current_step'] = 'SimCLR 학습 시작'
                training_status['progress'] = 10
            else:
                training_status['current_step'] = '클러스터링 시작'
                training_status['progress'] = 60
        
        # 프로세스 실행
        logger.info(f"🔧 전체 파이프라인 명령어: {' '.join(cmd)}")
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1
        )
        logger.info(f"🚀 프로세스 시작: PID={process.pid}")
        
        # 실시간 출력 처리
        logger.info("📊 실시간 출력 처리 시작")
        for line in iter(process.stdout.readline, ''):
            if not training_status['is_running']:
                logger.warning("⚠️ 학습 중지 요청됨")
                process.terminate()
                break
                
            line = line.strip()
            if line:
                print(f"[TRAINING] {line}")
                
                # 진행 상황 파싱 - 새로운 형식: [Ep 001] loss=7.3521 lr=0.001000 time=3.0s
                if '[Ep' in line and ']' in line:
                    try:
                        # "[Ep 001]" 형태에서 현재 에포크 추출
                        import re
                        epoch_match = re.search(r'\[Ep\s+(\d+)\]', line)
                        if epoch_match:
                            current_epoch = int(epoch_match.group(1))
                            with training_lock:
                                training_status['current_epoch'] = current_epoch
                                # 총 에포크 수는 설정에서 가져옴 (기본값 100)
                                total_epochs = training_status.get('total_epochs', 100)
                                training_status['progress'] = 10 + (current_epoch / total_epochs) * 60
                    except:
                        pass
                
                # 손실 값 파싱 - 새로운 형식: loss=7.3521
                if 'loss=' in line.lower():
                    try:
                        # "loss=7.3521" 형태에서 손실 값 추출
                        loss_match = re.search(r'loss=([\d.]+)', line.lower())
                        if loss_match:
                            loss = float(loss_match.group(1))
                            with training_lock:
                                training_status['current_loss'] = loss
                                if training_status['best_loss'] is None or loss < training_status['best_loss']:
                                    training_status['best_loss'] = loss
                    except:
                        pass
                
                # 단계별 진행 상황 업데이트
                if training_mode == 'full':
                    # 전체 파이프라인 진행 상황
                    if 'Done.' in line:
                        with training_lock:
                            training_status['current_step'] = 'SimCLR 학습 완료'
                            training_status['progress'] = 30
                    elif 'extract_embeddings.py' in line:
                        with training_lock:
                            training_status['current_step'] = '임베딩 추출 중'
                            training_status['progress'] = 60
                    elif 'viz_embeddings.py' in line:
                        with training_lock:
                            training_status['current_step'] = '2D 임베딩 시각화 중'
                            training_status['progress'] = 70
                    elif 'cluster_and_segment.py' in line:
                        with training_lock:
                            training_status['current_step'] = '클러스터링 중'
                            training_status['progress'] = 75
                    elif 'select_representatives.py' in line:
                        with training_lock:
                            training_status['current_step'] = '대표 샘플 선택 중'
                            training_status['progress'] = 85
                    elif 'export_representative_parquet.py' in line:
                        with training_lock:
                            training_status['current_step'] = 'Parquet 파일 생성 중'
                            training_status['progress'] = 90
                    elif 'Pipeline done.' in line:
                        with training_lock:
                            training_status['current_step'] = '전체 파이프라인 완료'
                            training_status['progress'] = 100
                else:
                    # 클러스터링만 모드 진행 상황
                    if 'labels:' in line:
                        with training_lock:
                            training_status['current_step'] = '클러스터링 완료'
                            training_status['progress'] = 80
                    elif 'Saved segments:' in line:
                        with training_lock:
                            training_status['current_step'] = '세그먼트화 완료'
                            training_status['progress'] = 100
                
                # 로그 레벨 결정
                log_level = 'info'
                if any(keyword in line.lower() for keyword in ['error', 'failed', 'exception', 'traceback']):
                    log_level = 'error'
                elif any(keyword in line.lower() for keyword in ['warning', 'warn', 'deprecated', 'futurewarning']):
                    log_level = 'warning'
                elif any(keyword in line.lower() for keyword in ['success', 'completed', 'finished', 'done', 'saved', 'wrote']):
                    log_level = 'success'
                elif any(keyword in line.lower() for keyword in ['[ep', 'loss=', 'lr=', 'time=']):
                    log_level = 'training'
                
                # 로그 엔트리 추가
                with training_lock:
                    training_status['log_entries'].append({
                        'message': line,
                        'level': log_level,
                        'timestamp': time.time(),
                        'epoch': training_status.get('current_epoch', 0),
                        'step': training_status.get('current_step', '')
                    })
                    # 최대 200개 로그 엔트리만 유지
                    if len(training_status['log_entries']) > 200:
                        training_status['log_entries'] = training_status['log_entries'][-200:]
        
        # 프로세스 완료 대기
        logger.info("⏳ 프로세스 완료 대기 중...")
        return_code = process.wait()
        logger.info(f"🏁 프로세스 완료: 종료 코드={return_code}")
        
        with training_lock:
            if return_code == 0:
                logger.info("✅ 프로세스 성공적으로 완료")
                if training_mode == 'full':
                    training_status['current_step'] = '전체 파이프라인 완료'
                    completion_message = '🎉 전체 학습 파이프라인이 성공적으로 완료되었습니다!'
                else:
                    training_status['current_step'] = '클러스터링 완료'
                    completion_message = '🎉 클러스터링이 성공적으로 완료되었습니다!'
                
                training_status['progress'] = 100
                training_status['is_running'] = False
                training_status['state'] = 'completed'
                training_status['is_complete'] = True
                
                # 완료 메시지가 이미 있는지 확인
                existing_messages = [entry['message'] for entry in training_status['log_entries']]
                if completion_message not in existing_messages:
                    training_status['log_entries'].append({
                        'message': completion_message,
                        'level': 'success',
                        'timestamp': time.time(),
                        'epoch': training_status.get('current_epoch', 0),
                        'step': '완료'
                    })
            else:
                logger.error(f"❌ 프로세스 실패: 종료 코드={return_code}")
                training_status['current_step'] = '실패'
                training_status['is_running'] = False
                training_status['state'] = 'failed'
                training_status['is_complete'] = False
                training_status['log_entries'].append({
                    'message': f'❌ 작업이 실패했습니다 (종료 코드: {return_code})',
                    'level': 'error',
                    'timestamp': time.time(),
                    'epoch': training_status.get('current_epoch', 0),
                    'step': '실패'
                })
    
    except Exception as e:
        logger.error(f"❌ 학습 파이프라인 일반 오류: {str(e)}", exc_info=True)
        with training_lock:
            training_status['current_step'] = '학습 오류'
            training_status['is_running'] = False
            training_status['state'] = 'failed'
            training_status['is_complete'] = False
            training_status['log_entries'].append({
                'message': f'❌ 학습 중 오류 발생: {str(e)}',
                'level': 'error',
                'timestamp': time.time()
            })
        print(f"❌ 학습 파이프라인 오류: {e}")
    
    finally:
        # 원래 디렉토리로 복귀
        logger.info("🔄 원래 디렉토리로 복귀")
        os.chdir('..')
        logger.info(f"📁 현재 디렉토리: {os.getcwd()}")


async def training_page_handler(request):
    """Training 페이지 핸들러"""
    return web.FileResponse('static/training.html')


async def dataset_info_handler(request):
    """데이터셋 정보 조회"""
    try:
        data_glob = request.query.get('data_glob', 'training/dataset/raw/*.jsonl')
        files = glob.glob(data_glob)
        
        total_size = 0
        file_info = []
        
        for file_path in files:
            if os.path.exists(file_path):
                size = os.path.getsize(file_path)
                total_size += size
                file_info.append({
                    'name': os.path.basename(file_path),
                    'size': size,
                    'path': file_path
                })
        
        return web.json_response({
            'status': 'ok',
            'total_files': len(files),
            'total_size': total_size,
            'files': file_info
        })
        
    except Exception as e:
        print(f"❌ 데이터셋 정보 조회 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def training_start_handler(request):
    """학습 시작"""
    global training_process, training_status
    
    logger.info("🎯 학습 시작 요청 수신")
    
    try:
        with training_lock:
            if training_status['is_running']:
                logger.warning("⚠️ 학습이 이미 진행 중")
                return web.json_response({"error": "학습이 이미 진행 중입니다."}, status=400)
            
            data = await request.json()
            logger.info(f"📋 학습 설정: {data}")
            
            # 학습 설정 검증
            training_mode = data.get('training_mode', 'full')
            logger.info(f"📋 학습 모드: {training_mode}")
            
            if training_mode == 'full':
                # 전체 파이프라인: 학습 파라미터 필수
                required_fields = ['data_glob', 'window', 'stride', 'epochs', 'batch_size', 'lr']
                logger.info("🔧 전체 파이프라인 모드 - 학습 파라미터 검증")
            else:
                # 클러스터링만: 기본 파라미터와 임베딩 파일 경로 필수
                required_fields = ['data_glob', 'window', 'stride', 'embeddings_path']
                logger.info("🎯 클러스터링 전용 모드 - 임베딩 파일 경로 검증")
            
            for field in required_fields:
                if field not in data:
                    logger.error(f"❌ 필수 필드 누락: {field}")
                    return web.json_response({"error": f"필수 필드가 누락되었습니다: {field}"}, status=400)
            
            # 클러스터링만 모드에서 임베딩 파일 존재 확인
            if training_mode == 'clustering':
                embeddings_path = data.get('embeddings_path', 'runs/embeddings.npy')
                logger.info(f"📁 임베딩 파일 경로 확인: {embeddings_path}")
                
                # 여러 가능한 경로에서 파일 찾기
                possible_paths = [
                    embeddings_path,  # 원본 경로
                    os.path.join(os.getcwd(), embeddings_path),  # 현재 디렉토리 기준
                    os.path.join(os.getcwd(), 'training', embeddings_path),  # training 폴더 기준
                    os.path.join(os.getcwd(), '..', embeddings_path),  # 상위 디렉토리 기준
                ]
                
                found_path = None
                for path in possible_paths:
                    if os.path.exists(path):
                        found_path = path
                        break
                
                if not found_path:
                    # 디버깅 정보 추가
                    current_dir = os.getcwd()
                    debug_info = f"""
현재 작업 디렉토리: {current_dir}
원본 경로: {embeddings_path}
확인한 경로들:
{chr(10).join([f"  - {path} (존재: {os.path.exists(path)})" for path in possible_paths])}
"""
                    return web.json_response({
                        "error": f"임베딩 파일을 찾을 수 없습니다: {embeddings_path}{debug_info}"
                    }, status=400)
                
                # 찾은 경로를 절대 경로로 업데이트
                data['embeddings_path'] = os.path.abspath(found_path)
            
                # 학습 상태 초기화
                training_status.update({
                'state': 'running',
                    'is_running': True,
                    'current_step': '학습 준비 중...',
                    'progress': 0,
                    'current_epoch': 0,
                    'total_epochs': data.get('epochs', 0) if training_mode == 'full' else 0,
                    'current_loss': 0,
                    'best_loss': None,
                    'start_time': time.time(),
                'log_entries': [],
                'is_complete': False
                })
            
            # 학습 프로세스 시작
            training_process = threading.Thread(
                target=run_training_pipeline,
                args=(data,),
                daemon=True
            )
            training_process.start()
            
            print(f"🚀 학습 시작: {data}")
            return web.json_response({
                'status': 'ok',
                'message': '학습이 시작되었습니다.'
            })
            
    except Exception as e:
        print(f"❌ 학습 시작 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def training_stop_handler(request):
    """학습 중지"""
    global training_process, training_status
    
    try:
        with training_lock:
            if not training_status['is_running']:
                return web.json_response({"error": "실행 중인 학습이 없습니다."}, status=400)
            
            # 학습 프로세스 중지
            if training_process and training_process.is_alive():
                # 프로세스 종료는 run_training_pipeline에서 처리
                pass
            
            training_status['is_running'] = False
            training_status['state'] = 'stopped'
            training_status['is_complete'] = False
            training_status['current_step'] = '학습 중지됨'
            
            print("⏹️ 학습 중지 요청됨")
            return web.json_response({
                'status': 'ok',
                'message': '학습 중지 요청이 처리되었습니다.'
            })
            
    except Exception as e:
        print(f"❌ 학습 중지 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def training_status_handler(request):
    """학습 상태 조회"""
    global training_status
    
    try:
        with training_lock:
            elapsed_time = 0
            if training_status['start_time']:
                elapsed_time = time.time() - training_status['start_time']
            
            status_data = training_status.copy()
            status_data['elapsed_time'] = elapsed_time
            # 호환성: 완료 여부가 없으면 is_running으로 유추
            if 'is_complete' not in status_data:
                status_data['is_complete'] = (not status_data.get('is_running', False)) and status_data.get('progress', 0) >= 100
            # 호환성: is_running/is_complete를 state로부터 보정
            state = status_data.get('state')
            if state:
                status_data['is_running'] = (state == 'running')
                status_data['is_complete'] = (state == 'completed')
            
            # JSON에서 유효하지 않은 값들을 처리
            if status_data['best_loss'] == float('inf'):
                status_data['best_loss'] = None
            
            return web.json_response({
                'status': 'ok',
                **status_data
            })
            
    except Exception as e:
        print(f"❌ 학습 상태 조회 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


def setup_training_routes(app):
    """학습 관련 라우트들을 앱에 등록"""
    # Training 페이지 라우트
    app.router.add_get('/training', training_page_handler)
    
    # Training API 라우트
    app.router.add_get("/training/dataset-info", dataset_info_handler)
    app.router.add_post("/training/start", training_start_handler)
    app.router.add_post("/training/stop", training_stop_handler)
    app.router.add_get("/training/status", training_status_handler)
    
    print("✅ Training routes registered successfully")


def get_training_status():
    """학습 상태 조회 (외부에서 사용)"""
    global training_status
    with training_lock:
        return training_status.copy()


def is_training_running():
    """학습 실행 여부 확인 (외부에서 사용)"""
    global training_status
    with training_lock:
        return training_status['is_running']
