"""
Record 관련 라우터
포즈 데이터 녹화 기능 제공
"""

import os
import sys
import subprocess
import threading
import logging
import shutil
import json
import numpy as np
import time
from datetime import datetime
from aiohttp import web
from aiohttp.web import FileResponse

logger = logging.getLogger(__name__)


async def record_page_handler(request):
    """Record 페이지 제공"""
    return FileResponse('static/record.html')


def auto_add_to_cluster(recorder_path, seq_id):
    """녹화 완료 후 자동으로 클러스터에 추가하고 세그먼트 생성"""
    try:
        logger.info(f"🔄 자동 클러스터 추가 시작: {seq_id}")
        
        # 기본 경로 설정 (현재 작업 디렉토리 기준 절대 경로로 변환)
        original_cwd = os.getcwd()
        training_dir = "training"
        training_abs = os.path.abspath(training_dir)
        
        # 절대 경로로 변환 (os.chdir 전에)
        existing_embeddings = os.path.abspath(os.path.join(training_dir, "runs", "embeddings.npy"))
        existing_windows_index = os.path.abspath(os.path.join(training_dir, "runs", "simclr", "windows_index.json"))
        existing_segments = os.path.abspath(os.path.join(training_dir, "runs", "segments.json"))
        existing_reps = os.path.abspath(os.path.join(training_dir, "runs", "segments_representative.json"))
        existing_final = os.path.abspath(os.path.join(training_dir, "runs", "segments_final.json"))
        ckpt_path = os.path.abspath(os.path.join(training_dir, "runs", "simclr", "best.pt"))
        new_jsonl = os.path.abspath(recorder_path)
        
        # 임시 출력 파일 (나중에 기존 파일로 대체)
        temp_embeddings = os.path.abspath(os.path.join(training_dir, "runs", "embeddings_updated.npy"))
        temp_windows_index = os.path.abspath(os.path.join(training_dir, "runs", "simclr", "windows_index_updated.json"))
        temp_segments = os.path.abspath(os.path.join(training_dir, "runs", "segments_updated.json"))
        temp_reps = os.path.abspath(os.path.join(training_dir, "runs", "segments_representative_updated.json"))
        temp_final = os.path.abspath(os.path.join(training_dir, "runs", "segments_final_updated.json"))
        
        # 파일 존재 확인
        if not os.path.exists(existing_embeddings):
            logger.warning(f"⚠️ 기존 임베딩 파일이 없습니다: {existing_embeddings}")
            logger.info("💡 전체 파이프라인을 먼저 실행해주세요.")
            return
        
        if not os.path.exists(existing_windows_index):
            logger.warning(f"⚠️ 기존 windows_index 파일이 없습니다: {existing_windows_index}")
            logger.info("💡 전체 파이프라인을 먼저 실행해주세요.")
            return
        
        if not os.path.exists(ckpt_path):
            logger.warning(f"⚠️ 모델 체크포인트가 없습니다: {ckpt_path}")
            logger.info("💡 모델을 먼저 학습해주세요.")
            return
        
        try:
            # 작업 디렉토리를 training으로 변경
            os.chdir(training_abs)
            
            # 경로를 training 디렉토리 기준 상대 경로로 변환
            existing_embeddings_rel = os.path.relpath(existing_embeddings, training_abs)
            existing_windows_index_rel = os.path.relpath(existing_windows_index, training_abs)
            new_jsonl_rel = os.path.relpath(new_jsonl, training_abs)
            ckpt_path_rel = os.path.relpath(ckpt_path, training_abs)
            temp_embeddings_rel = os.path.relpath(temp_embeddings, training_abs)
            temp_windows_index_rel = os.path.relpath(temp_windows_index, training_abs)
            temp_segments_rel = os.path.relpath(temp_segments, training_abs)
            temp_reps_rel = os.path.relpath(temp_reps, training_abs)
            
            # 1. add_to_cluster.py 실행
            logger.info("📊 1단계: 새 데이터를 클러스터에 추가 중...")
            add_cmd = [
                sys.executable, "-u", "add_to_cluster.py",
                "--existing_embeddings", existing_embeddings_rel,
                "--existing_windows_index", existing_windows_index_rel,
                "--new_jsonl", new_jsonl_rel,
                "--ckpt", ckpt_path_rel,
                "--window", "32",
                "--stride", "8",
                "--out_embeddings", temp_embeddings_rel,
                "--out_windows_index", temp_windows_index_rel,
            ]
            
            logger.info(f"🔧 실행 명령어: {' '.join(add_cmd)}")
            result = subprocess.run(add_cmd, capture_output=True, text=True, timeout=300)
            
            if result.returncode != 0:
                logger.error(f"❌ 클러스터 추가 실패: {result.stderr}")
                return
            
            logger.info("✅ 클러스터 추가 완료")
            
            # 2. cluster_and_segment.py 실행
            logger.info("📊 2단계: 세그먼트 생성 중...")
            cluster_cmd = [
                sys.executable, "-u", "cluster_and_segment.py",
                "--embeddings", temp_embeddings_rel,
                "--out", temp_segments_rel,
                "--algo", "hdbscan",
                "--hdb_min_cluster", "10",
                "--hdb_min_samples", "3",
                "--min_len", "5",
                "--merge_gap", "2",
                "--max_len_windows", "10",
                "--window", "32",
                "--stride", "8",
                "--split_criterion", "neutral",
            ]
            
            logger.info(f"🔧 실행 명령어: {' '.join(cluster_cmd)}")
            result = subprocess.run(cluster_cmd, capture_output=True, text=True, timeout=300)
            
            if result.returncode != 0:
                logger.error(f"❌ 세그먼트 생성 실패: {result.stderr}")
                return
            
            logger.info("✅ 세그먼트 생성 완료")
            
            # 3. select_representatives.py 실행 (선택적)
            logger.info("📊 3단계: 대표 세그먼트 선택 중...")
            reps_cmd = [
                sys.executable, "-u", "select_representatives.py",
                "--embeddings", temp_embeddings_rel,
                "--segments", temp_segments_rel,
                "--method", "per_label_k",
                "--per_label_k", "5",
                "--threshold", "0.25",
                "--windows_index", temp_windows_index_rel,
                "--files_glob", f"dataset/raw/*.jsonl",
                "--scale_exclude_thr", "1.4",
                "--out", temp_reps_rel,
            ]
            
            logger.info(f"🔧 실행 명령어: {' '.join(reps_cmd)}")
            result = subprocess.run(reps_cmd, capture_output=True, text=True, timeout=300)
            
            if result.returncode != 0:
                logger.warning(f"⚠️ 대표 세그먼트 선택 실패 (무시됨): {result.stderr}")
            else:
                logger.info("✅ 대표 세그먼트 선택 완료")
            
            # 4. segments_final.json 생성 (representative 세그먼트 기반, next_candidates 포함)
            logger.info("📊 4단계: segments_final 생성 중...")
            try:
                # representative 세그먼트 파일 로드
                reps_path = temp_reps if os.path.exists(temp_reps) else existing_reps
                if os.path.exists(reps_path):
                    with open(reps_path, 'r', encoding='utf-8') as f:
                        reps_data = json.load(f)
                    base_segments = reps_data.get('segments', reps_data)
                    if not isinstance(base_segments, list):
                        base_segments = []
                    
                    # noise 클러스터(-1) 제외하고 모든 세그먼트 포함
                    final_segments = []
                    for i, seg in enumerate(base_segments):
                        # label이 -1인 noise 클러스터는 제외
                        label = seg.get('label', None)
                        if label == -1:
                            continue
                        seg_copy = dict(seg)
                        seg_copy['base_index'] = i
                        final_segments.append(seg_copy)
                    
                    # 임베딩 로드
                    E = np.load(temp_embeddings if os.path.exists(temp_embeddings) else existing_embeddings)
                    if E.ndim == 2 and E.shape[0] > 0:
                        def _clamp(idx, n):
                            return max(0, min(int(idx), n - 1))
                        
                        N = E.shape[0]
                        ref = []
                        tgt = []
                        for seg in final_segments:
                            s = _clamp(seg.get('start', 0), N)
                            e = _clamp(seg.get('end', s), N)
                            ref.append(E[e])
                            tgt.append(E[s])
                        ref = np.asarray(ref, dtype=np.float32)
                        tgt = np.asarray(tgt, dtype=np.float32)
                        
                        def _norm_rows(X):
                            n = np.linalg.norm(X, axis=1, keepdims=True) + 1e-9
                            return X / n
                        
                        R = _norm_rows(ref)
                        T = _norm_rows(tgt)
                        sim = R @ T.T
                        dist = 1.0 - sim
                        
                        M = dist.shape[0]
                        top_k = 5  # top 5로 변경
                        for i in range(M):
                            drow = dist[i].copy()
                            if 0 <= i < len(drow):
                                drow[i] = np.inf  # 자기 자신 제외
                            # 거리 순으로 정렬하여 top_k 선택 (final_segments는 이미 noise 제외됨)
                            order = np.argsort(drow)[:max(0, int(top_k))]
                            candidates = []
                            for j in order:
                                if np.isfinite(drow[j]):
                                    candidates.append({'segment_index': int(j), 'distance': float(drow[j])})
                            final_segments[i]['next_candidates'] = candidates
                        
                        # segments_final.json 저장
                        os.makedirs(os.path.dirname(temp_final) or '.', exist_ok=True)
                        payload = {
                            'source': reps_path,
                            'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                            'selected_indices': list(range(len(final_segments))),
                            'distance_metric': 'cosine-transition',
                            'top_k': int(top_k),
                            'segments': final_segments
                        }
                        with open(temp_final, 'w', encoding='utf-8') as f:
                            json.dump(payload, f, ensure_ascii=False, indent=2)
                        logger.info(f"✅ segments_final 생성 완료: {len(final_segments)} 세그먼트")
                    else:
                        logger.warning("⚠️ 임베딩 파일 형식이 올바르지 않습니다.")
                else:
                    logger.warning(f"⚠️ Representative 세그먼트 파일이 없습니다: {reps_path}")
            except Exception as e:
                logger.warning(f"⚠️ segments_final 생성 실패 (무시됨): {e}")
            
            # 5. 기존 파일 백업 및 새 파일로 대체
            logger.info("📊 4단계: 기존 파일 백업 및 새 파일로 대체 중...")
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            
            def backup_and_replace(old_path, new_path, file_desc):
                """기존 파일을 백업하고 새 파일로 대체"""
                if not os.path.exists(new_path):
                    logger.warning(f"⚠️ {file_desc} 새 파일이 없습니다: {new_path}")
                    return False
                
                if os.path.exists(old_path):
                    # 백업 파일명 생성
                    backup_path = f"{old_path}.backup_{timestamp}"
                    try:
                        shutil.copy2(old_path, backup_path)
                        logger.info(f"💾 {file_desc} 백업 완료: {backup_path}")
                    except Exception as e:
                        logger.error(f"❌ {file_desc} 백업 실패: {e}")
                        return False
                
                # 새 파일로 대체
                try:
                    shutil.move(new_path, old_path)
                    logger.info(f"✅ {file_desc} 업데이트 완료: {old_path}")
                    return True
                except Exception as e:
                    logger.error(f"❌ {file_desc} 대체 실패: {e}")
                    return False
            
            # 각 파일 백업 및 대체
            backup_and_replace(existing_embeddings, temp_embeddings, "임베딩")
            backup_and_replace(existing_windows_index, temp_windows_index, "Windows Index")
            backup_and_replace(existing_segments, temp_segments, "Segments")
            if os.path.exists(temp_reps):
                backup_and_replace(existing_reps, temp_reps, "Representative Segments")
            if os.path.exists(temp_final):
                backup_and_replace(existing_final, temp_final, "Segments Final")
            
            logger.info(f"🎉 자동 클러스터 추가 완료! (seq_id: {seq_id})")
            logger.info(f"📁 업데이트된 파일 (백업: .backup_{timestamp}):")
            logger.info(f"   - 임베딩: {existing_embeddings}")
            logger.info(f"   - Windows Index: {existing_windows_index}")
            logger.info(f"   - Segments: {existing_segments}")
            logger.info(f"   - Representative Segments: {existing_reps}")
            logger.info(f"   - Segments Final: {existing_final}")
            
        finally:
            os.chdir(original_cwd)
            
    except subprocess.TimeoutExpired:
        logger.error(f"❌ 타임아웃: 클러스터 추가 작업이 너무 오래 걸렸습니다.")
    except Exception as e:
        logger.error(f"❌ 자동 클러스터 추가 중 오류 발생: {e}", exc_info=True)


async def websocket_toggle_recording_handler(request, recorder):
    """WebSocket용 녹화 시작/중지 토글"""
    try:
        # 현재 녹화 상태 확인
        is_recording = recorder.is_active()
        
        if is_recording:
            # 녹화 중지
            seq_id = recorder.stop()
            recording_path = recorder.current_path()
            message = "녹화가 중지되었습니다."
            print(f"📹 WebSocket 녹화 중지됨 (seq_id: {seq_id})")
            
            # # 녹화 완료 후 자동으로 클러스터에 추가 (백그라운드 스레드)
            # if recording_path and os.path.exists(recording_path):
            #     thread = threading.Thread(
            #         target=auto_add_to_cluster,
            #         args=(recording_path, seq_id),
            #         daemon=True
            #     )
            #     thread.start()
            #     print(f"🔄 백그라운드에서 클러스터 추가 작업 시작됨")
        else:
            # 녹화 시작
            seq_id = recorder.start()
            message = "녹화가 시작되었습니다."
            print(f"📹 WebSocket 녹화 시작됨 (seq_id: {seq_id})")
        
        return web.json_response({
            "status": "ok",
            "is_recording": not is_recording,  # 토글된 상태
            "seq_id": seq_id,
            "path": recorder.current_path(),
            "message": message
        })
        
    except Exception as e:
        print(f"❌ WebSocket 녹화 제어 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def websocket_recording_status_handler(request, recorder):
    """WebSocket용 녹화 상태 조회"""
    try:
        return web.json_response({
            "status": "ok",
            "is_recording": recorder.is_active(),
            "seq_id": recorder.current_seq_id(),
            "path": recorder.current_path()
        })
    except Exception as e:
        print(f"❌ WebSocket 녹화 상태 조회 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def websocket_cancel_recording_handler(request, recorder):
    """WebSocket용 녹화 취소 (저장하지 않고 중지)"""
    try:
        if not recorder.is_active():
            return web.json_response({
                "status": "ok",
                "is_recording": False,
                "message": "녹화가 진행 중이 아닙니다."
            })
        
        # 녹화 취소 (파일 삭제)
        seq_id = recorder.cancel()
        message = "녹화가 취소되었습니다 (저장되지 않음)."
        print(f"📹 WebSocket 녹화 취소됨 (seq_id: {seq_id}, 파일 삭제됨)")
        
        return web.json_response({
            "status": "ok",
            "is_recording": False,
            "seq_id": seq_id,
            "message": message
        })
        
    except Exception as e:
        print(f"❌ WebSocket 녹화 취소 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


def setup_record_routes(app, recorder):
    """Record 관련 라우트들을 앱에 등록
    
    Args:
        app: aiohttp web.Application 인스턴스
        recorder: PoseRecorder 인스턴스
    """
    # Record 페이지 라우트
    app.router.add_get('/record', record_page_handler)
    app.router.add_get('/record.html', record_page_handler)
    
    # WebSocket용 녹화 API 라우트 (recorder를 클로저로 전달)
    async def toggle_handler(request):
        return await websocket_toggle_recording_handler(request, recorder)
    
    async def status_handler(request):
        return await websocket_recording_status_handler(request, recorder)
    
    async def cancel_handler(request):
        return await websocket_cancel_recording_handler(request, recorder)
    
    app.router.add_post("/websocket/toggle-recording", toggle_handler)
    app.router.add_get("/websocket/recording-status", status_handler)
    app.router.add_post("/websocket/cancel-recording", cancel_handler)

