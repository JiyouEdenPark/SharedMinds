"""
Playback 관련 라우터
데이터셋 파일 목록 조회 및 파일 제공 기능
"""

import os
import glob
import json
from aiohttp import web
from aiohttp.web import FileResponse


async def playback_page_handler(request):
    """Playback 페이지 제공"""
    return FileResponse('static/playback.html')

async def dataset_files_handler(request):
    """데이터셋 파일 목록 조회"""
    try:
        # 여러 경로에서 JSONL 파일 검색
        search_paths = [
            'dataset/raw/*.jsonl',
            'training/dataset/raw/*.jsonl',
            'dataset/*.jsonl',
            'training/dataset/*.jsonl'
        ]
        
        all_files = []
        for pattern in search_paths:
            files = glob.glob(pattern)
            for file_path in files:
                if os.path.exists(file_path):
                    stat = os.stat(file_path)
                    all_files.append({
                        'path': file_path,
                        'name': os.path.basename(file_path),
                        'size': stat.st_size,
                        'modified': stat.st_mtime,
                        'relative_path': file_path
                    })
        
        # 중복 제거 (같은 파일명이 여러 경로에 있을 수 있음)
        unique_files = {}
        for file_info in all_files:
            name = file_info['name']
            if name not in unique_files or file_info['size'] > unique_files[name]['size']:
                unique_files[name] = file_info
        
        # 수정 시간순으로 정렬 (최신순)
        sorted_files = sorted(unique_files.values(), key=lambda x: x['modified'], reverse=True)
        
        return web.json_response({
            'status': 'ok',
            'files': sorted_files,
            'count': len(sorted_files)
        })
        
    except Exception as e:
        print(f"❌ 데이터셋 파일 목록 조회 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def dataset_file_handler(request):
    """특정 데이터셋 파일 내용 조회"""
    try:
        file_path = request.query.get('path')
        if not file_path:
            return web.json_response({"error": "파일 경로가 필요합니다"}, status=400)
        
        # 보안을 위해 경로 검증
        if not os.path.exists(file_path):
            return web.json_response({"error": "파일을 찾을 수 없습니다"}, status=404)
        
        # JSONL 파일인지 확인
        if not file_path.endswith('.jsonl'):
            return web.json_response({"error": "JSONL 파일만 지원됩니다"}, status=400)
        
        # 파일 크기 제한 (10MB)
        file_size = os.path.getsize(file_path)
        if file_size > 10 * 1024 * 1024:
            return web.json_response({"error": "파일이 너무 큽니다 (10MB 제한)"}, status=413)
        
        # 파일 내용 읽기
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        return web.Response(
            text=content,
            content_type='application/jsonl',
            headers={
                'Content-Disposition': f'attachment; filename="{os.path.basename(file_path)}"'
            }
        )
        
    except Exception as e:
        print(f"❌ 데이터셋 파일 조회 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def dataset_file_info_handler(request):
    """데이터셋 파일 정보 조회 (프레임 수, 메타데이터 등)"""
    try:
        file_path = request.query.get('path')
        if not file_path:
            return web.json_response({"error": "파일 경로가 필요합니다"}, status=400)
        
        if not os.path.exists(file_path):
            return web.json_response({"error": "파일을 찾을 수 없습니다"}, status=404)
        
        if not file_path.endswith('.jsonl'):
            return web.json_response({"error": "JSONL 파일만 지원됩니다"}, status=400)
        
        # 파일 정보 수집
        frame_count = 0
        first_frame = None
        last_frame = None
        metadata = {}
        
        with open(file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f):
                if line.strip():
                    try:
                        data = json.loads(line.strip())
                        frame_count += 1
                        
                        if first_frame is None:
                            first_frame = data
                            # 메타데이터 추출
                            metadata = {
                                'width': data.get('width', 0),
                                'height': data.get('height', 0),
                                'fps': data.get('fps', 0),
                                'seq_id': data.get('seq_id', ''),
                                'has_keypoints': 'kpts' in data,
                                'keypoint_count': len(data.get('kpts', [])) if 'kpts' in data else 0
                            }
                        
                        last_frame = data
                        
                        # 너무 큰 파일은 샘플링
                        if frame_count > 10000:
                            break
                            
                    except json.JSONDecodeError:
                        continue
        
        return web.json_response({
            'status': 'ok',
            'file_path': file_path,
            'frame_count': frame_count,
            'metadata': metadata,
            'first_frame': first_frame,
            'last_frame': last_frame
        })
        
    except Exception as e:
        print(f"❌ 데이터셋 파일 정보 조회 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)


def setup_playback_routes(app):
    """Playback 관련 라우트들을 앱에 등록"""
    # Playback 페이지 라우트
    app.router.add_get('/playback', playback_page_handler)
    
    # 데이터셋 파일 관련 API
    app.router.add_get('/playback/dataset-files', dataset_files_handler)
    app.router.add_get('/playback/dataset-file', dataset_file_handler)
    app.router.add_get('/playback/dataset-file-info', dataset_file_info_handler)
