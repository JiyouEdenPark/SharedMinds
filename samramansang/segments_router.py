"""
Segments 관련 라우터
runs/ 폴더의 세그먼트 파일들 제공 기능
"""

import os
import glob
import json
from aiohttp import web
from aiohttp.web import FileResponse


async def segments_page_handler(request):
    """Segments 페이지 제공"""
    return FileResponse('static/segments.html')


async def auto_files_handler(request):
    """자동으로 필요한 파일들 조회"""
    try:
        # 자동으로 찾을 파일들
        auto_files = {}
        
        # 1. JSONL 파일들 (dataset/raw에서)
        jsonl_patterns = [
            'dataset/raw/*.jsonl',
            'training/dataset/raw/*.jsonl'
        ]
        
        jsonl_files = []
        for pattern in jsonl_patterns:
            files = glob.glob(pattern)
            for file_path in files:
                if os.path.exists(file_path):
                    stat = os.stat(file_path)
                    jsonl_files.append({
                        'path': file_path,
                        'name': os.path.basename(file_path),
                        'size': stat.st_size,
                        'modified': stat.st_mtime
                    })
        
        # 최신 JSONL 파일 선택
        if jsonl_files:
            auto_files['jsonl'] = max(jsonl_files, key=lambda x: x['modified'])
        
        # 2. Windows Index 파일 (training/runs/simclr/windows_index.json)
        windows_path = 'training/runs/simclr/windows_index.json'
        if os.path.exists(windows_path):
            stat = os.stat(windows_path)
            auto_files['windows'] = {
                'path': windows_path,
                'name': 'windows_index.json',
                'size': stat.st_size,
                'modified': stat.st_mtime
            }
        
        # 3. Segments 파일들 (training/runs/에서 segments 관련 파일)
        segments_candidates = []
        for p in [
            'training/runs/segments_final.json',
            'training/runs/segments_representative.json',
            'training/runs/segments.json'
        ]:
            if os.path.exists(p):
                stat = os.stat(p)
                segments_candidates.append({
                    'path': p,
                    'name': os.path.basename(p),
                    'size': stat.st_size,
                    'modified': stat.st_mtime
                })
        # 선호 순서: segments_final.json > 최신 기타
        if segments_candidates:
            preferred = next((x for x in segments_candidates if x['name'] == 'segments_final.json'), None)
            auto_files['segments'] = preferred or max(segments_candidates, key=lambda x: x['modified'])
        
        return web.json_response({
            'status': 'ok',
            'auto_files': auto_files,
            'found': list(auto_files.keys())
        })
        
    except Exception as e:
        print(f"❌ 자동 파일 조회 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def auto_load_files_handler(request):
    """자동으로 모든 필요한 파일들을 로드"""
    try:
        # 자동으로 찾을 파일들
        auto_files = {}
        
        # 1. JSONL 파일들 (dataset/raw에서)
        jsonl_patterns = [
            'dataset/raw/*.jsonl',
            'training/dataset/raw/*.jsonl'
        ]
        
        jsonl_files = []
        for pattern in jsonl_patterns:
            files = glob.glob(pattern)
            for file_path in files:
                if os.path.exists(file_path):
                    stat = os.stat(file_path)
                    jsonl_files.append({
                        'path': file_path,
                        'name': os.path.basename(file_path),
                        'size': stat.st_size,
                        'modified': stat.st_mtime
                    })
        
        # 모든 JSONL 파일 처리 (여러 파일 지원)
        if jsonl_files:
            auto_files['jsonl'] = jsonl_files  # 단일 파일이 아닌 파일 리스트로 변경
        
        # 2. Windows Index 파일 (training/runs/simclr/windows_index.json)
        windows_path = 'training/runs/simclr/windows_index.json'
        if os.path.exists(windows_path):
            stat = os.stat(windows_path)
            auto_files['windows'] = {
                'path': windows_path,
                'name': 'windows_index.json',
                'size': stat.st_size,
                'modified': stat.st_mtime
            }
        
        # 3. Segments 파일들 (training/runs/에서 segments 관련 파일)
        # original: 대표 또는 원본 중 최신(단, final 제외)
        seg_orig_candidates = []
        for p in [
            'training/runs/segments_representative.json',
            'training/runs/segments.json'
        ]:
            if os.path.exists(p):
                stat = os.stat(p)
                seg_orig_candidates.append({
                    'path': p,
                    'name': os.path.basename(p),
                    'size': stat.st_size,
                    'modified': stat.st_mtime
                })
        if seg_orig_candidates:
            auto_files['segments'] = max(seg_orig_candidates, key=lambda x: x['modified'])
        # final: 별도 키로 제공
        final_path = 'training/runs/segments_final.json'
        if os.path.exists(final_path):
            stat = os.stat(final_path)
            auto_files['segments_final'] = {
                'path': final_path,
                'name': os.path.basename(final_path),
                'size': stat.st_size,
                'modified': stat.st_mtime
            }
        
        loaded_data = {}
        
        # JSONL 파일들 로드 (여러 파일 지원)
        if 'jsonl' in auto_files:
            jsonl_files = auto_files['jsonl']
            if isinstance(jsonl_files, list):
                # 여러 파일인 경우
                all_content = []
                all_info = []
                for jsonl_file in jsonl_files:
                    try:
                        with open(jsonl_file['path'], 'r', encoding='utf-8') as f:
                            content = f.read()
                        all_content.append(content)
                        all_info.append(jsonl_file)
                    except Exception as e:
                        print(f"❌ JSONL 파일 로드 오류 ({jsonl_file['path']}): {e}")
                
                # 모든 파일의 내용을 합침
                combined_content = '\n'.join(all_content)
                loaded_data['jsonl'] = {
                    'content': combined_content,
                    'info': all_info,
                    'multiple_files': True
                }
            else:
                # 단일 파일인 경우 (기존 로직)
                try:
                    with open(jsonl_files['path'], 'r', encoding='utf-8') as f:
                        content = f.read()
                    loaded_data['jsonl'] = {
                        'content': content,
                        'info': jsonl_files,
                        'multiple_files': False
                    }
                except Exception as e:
                    print(f"❌ JSONL 파일 로드 오류: {e}")
        
        # Windows 파일 로드
        if 'windows' in auto_files:
            windows_path = auto_files['windows']['path']
            try:
                with open(windows_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                loaded_data['windows'] = {
                    'content': content,
                    'info': auto_files['windows']
                }
            except Exception as e:
                print(f"❌ Windows 파일 로드 오류: {e}")
        
        # Segments 파일 로드 (original)
        if 'segments' in auto_files:
            segments_path = auto_files['segments']['path']
            try:
                with open(segments_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                loaded_data['segments'] = {
                    'content': content,
                    'info': auto_files['segments']
                }
            except Exception as e:
                print(f"❌ Segments 파일 로드 오류: {e}")
        # Segments 파일 로드 (final)
        if 'segments_final' in auto_files:
            segments_final_path = auto_files['segments_final']['path']
            try:
                with open(segments_final_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                loaded_data['segments_final'] = {
                    'content': content,
                    'info': auto_files['segments_final']
                }
            except Exception as e:
                print(f"❌ Segments Final 파일 로드 오류: {e}")
        
        return web.json_response({
            'status': 'ok',
            'loaded_files': loaded_data,
            'found': list(loaded_data.keys())
        })
        
    except Exception as e:
        print(f"❌ 자동 파일 로드 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def segment_distances_handler(request):
    """세그먼트 거리 정보 로드"""
    try:
        # 세그먼트 거리 파일 찾기
        distance_files = []
        distance_patterns = [
            'training/runs/segment_distances.json',
            'segment_distances.json'
        ]
        
        for pattern in distance_patterns:
            if os.path.exists(pattern):
                stat = os.stat(pattern)
                distance_files.append({
                    'path': pattern,
                    'name': os.path.basename(pattern),
                    'size': stat.st_size,
                    'modified': stat.st_mtime
                })
        
        if not distance_files:
            return web.json_response({
                "error": "세그먼트 거리 파일을 찾을 수 없습니다. calculate_segment_distances.py를 먼저 실행해주세요."
            }, status=404)
        
        # 가장 최신 파일 선택
        distance_file = max(distance_files, key=lambda x: x['modified'])
        
        # 파일 내용 로드
        with open(distance_file['path'], 'r', encoding='utf-8') as f:
            distance_data = json.load(f)
        
        return web.json_response({
            'status': 'ok',
            'distance_file': distance_file,
            'data': distance_data
        })
        
    except Exception as e:
        print(f"❌ 세그먼트 거리 로드 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def calculate_distances_handler(request):
    """세그먼트 거리 계산 실행"""
    try:
        data = await request.json()
        
        # 기본 파라미터 설정
        embeddings_path = data.get('embeddings_path', 'training/runs/embeddings.npy')
        segments_path = data.get('segments_path', 'training/runs/segments.json')
        output_path = data.get('output_path', 'training/runs/segment_distances.json')
        top_k = data.get('top_k', 3)
        
        # 파일 존재 확인
        if not os.path.exists(embeddings_path):
            return web.json_response({
                "error": f"임베딩 파일을 찾을 수 없습니다: {embeddings_path}"
            }, status=400)
        
        if not os.path.exists(segments_path):
            return web.json_response({
                "error": f"세그먼트 파일을 찾을 수 없습니다: {segments_path}"
            }, status=400)
        
        # 거리 계산 스크립트 실행
        import subprocess
        cmd = [
            'python', 'training/calculate_segment_distances.py',
            '--embeddings', embeddings_path,
            '--segments', segments_path,
            '--out', output_path,
            '--top_k', str(top_k)
        ]
        
        print(f"[DISTANCE_CALC] {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        return web.json_response({
            'status': 'ok',
            'message': '세그먼트 거리 계산이 완료되었습니다.',
            'output_file': output_path,
            'stdout': result.stdout
        })
        
    except subprocess.CalledProcessError as e:
        return web.json_response({
            "error": f"거리 계산 실패: {e.stderr}"
        }, status=500)
    except Exception as e:
        print(f"❌ 거리 계산 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def save_final_segments_handler(request):
    """선택된 세그먼트로 최종 리스트를 생성하고, 이웃 후보(next_candidates)를 포함해 저장"""
    try:
        data = await request.json()

        base_segments_path = data.get('base_segments_path')
        embeddings_path = data.get('embeddings_path', 'training/runs/embeddings.npy')
        output_path = data.get('output_path', 'training/runs/segments_final.json')
        include_indices = data.get('include_indices') or []
        exclude_indices = data.get('exclude_indices') or []
        top_k = int(data.get('top_k', 3))

        # 기본 세그먼트 경로 추론
        if not base_segments_path:
            if os.path.exists('training/runs/segments_final.json'):
                base_segments_path = 'training/runs/segments_final.json'
            elif os.path.exists('training/runs/segments_representative.json'):
                base_segments_path = 'training/runs/segments_representative.json'
            else:
                base_segments_path = 'training/runs/segments.json'

        if not os.path.exists(base_segments_path):
            return web.json_response({'error': f'세그먼트 파일을 찾을 수 없습니다: {base_segments_path}'}, status=400)
        if not os.path.exists(embeddings_path):
            return web.json_response({'error': f'임베딩 파일을 찾을 수 없습니다: {embeddings_path}'}, status=400)

        with open(base_segments_path, 'r', encoding='utf-8') as f:
            base_data = json.load(f)
        base_segments = base_data.get('segments', base_data)
        if not isinstance(base_segments, list):
            return web.json_response({'error': '세그먼트 파일 포맷이 올바르지 않습니다.'}, status=400)

        total = len(base_segments)
        if include_indices:
            selected_idx = sorted(set(int(i) for i in include_indices if 0 <= int(i) < total))
        else:
            selected_idx = list(range(total))
        if exclude_indices:
            ex = set(int(i) for i in exclude_indices)
            selected_idx = [i for i in selected_idx if i not in ex]

        final_segments = []
        for i in selected_idx:
            seg = dict(base_segments[i])
            seg['base_index'] = i
            final_segments.append(seg)

        import numpy as _np
        E = _np.load(embeddings_path)
        if E.ndim != 2 or E.shape[0] == 0:
            return web.json_response({'error': '임베딩 파일 형식이 올바르지 않습니다.'}, status=400)

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
        ref = _np.asarray(ref, dtype=_np.float32)
        tgt = _np.asarray(tgt, dtype=_np.float32)

        def _norm_rows(X):
            n = _np.linalg.norm(X, axis=1, keepdims=True) + 1e-9
            return X / n

        R = _norm_rows(ref)
        T = _norm_rows(tgt)
        sim = R @ T.T
        dist = 1.0 - sim

        M = dist.shape[0]
        for i in range(M):
            drow = dist[i].copy()
            if 0 <= i < len(drow):
                drow[i] = _np.inf
            order = _np.argsort(drow)[:max(0, int(top_k))]
            candidates = []
            for j in order:
                if _np.isfinite(drow[j]):
                    candidates.append({'segment_index': int(j), 'distance': float(drow[j])})
            final_segments[i]['next_candidates'] = candidates

        os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
        payload = {
            'source': base_segments_path,
            'created_at': __import__('time').strftime('%Y-%m-%dT%H:%M:%SZ', __import__('time').gmtime()),
            'selected_indices': selected_idx,
            'distance_metric': 'cosine-transition',
            'top_k': int(top_k),
            'segments': final_segments
        }
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

        return web.json_response({'status': 'ok', 'saved_path': output_path, 'num_segments': len(final_segments)})
    except Exception as e:
        print(f"❌ 최종 세그먼트 저장 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)
def setup_segments_routes(app):
    """Segments 관련 라우트들을 앱에 등록"""
    # Segments 페이지 라우트
    app.router.add_get('/segments', segments_page_handler)
    
    # 자동 파일 관련 API
    app.router.add_get('/segments/auto-files', auto_files_handler)
    app.router.add_get('/segments/auto-load', auto_load_files_handler)
    
    # 세그먼트 거리 관련 API
    app.router.add_get('/segments/distances', segment_distances_handler)
    app.router.add_post('/segments/calculate-distances', calculate_distances_handler)
    app.router.add_post('/segments/save-final', save_final_segments_handler)
