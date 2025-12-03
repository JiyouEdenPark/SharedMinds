import os
import glob
import json
from aiohttp import web
from aiohttp.web import FileResponse

async def embeddings_page_handler(request):
    """Embeddings 페이지 제공"""
    return FileResponse('static/embeddings.html')

async def auto_load_files_handler(request):
    """자동으로 모든 필요한 파일들을 로드"""
    try:
        # Automatically find files
        auto_files = {}
        
        # 1. embeddings_2d.npy file (from training/runs/simclr/)
        embeddings_patterns = [
            'training/runs/simclr/embeddings_2d.npy',
            'training/runs/embeddings_2d.npy',
            'embeddings_2d.npy'
        ]
        embeddings_files = []
        for pattern in embeddings_patterns:
            if os.path.exists(pattern):
                stat = os.stat(pattern)
                embeddings_files.append({
                    'path': pattern,
                    'name': 'embeddings_2d.npy',
                    'size': stat.st_size,
                    'modified': stat.st_mtime
                })
        if embeddings_files:
            auto_files['embeddings'] = max(embeddings_files, key=lambda x: x['modified'])
        
        # 2. segments.json file (from training/runs/) - 전체 클러스터링 결과
        segments_path = 'training/runs/segments.json'
        if os.path.exists(segments_path):
            stat = os.stat(segments_path)
            auto_files['segments'] = {
                'path': segments_path,
                'name': 'segments.json',
                'size': stat.st_size,
                'modified': stat.st_mtime
            }
        
        # 3. windows_preview.json file (from training/runs/simclr/)
        preview_patterns = [
            'training/runs/simclr/windows_preview.json',
            'training/runs/windows_preview.json'
        ]
        preview_files = []
        for pattern in preview_patterns:
            if os.path.exists(pattern):
                stat = os.stat(pattern)
                preview_files.append({
                    'path': pattern,
                    'name': 'windows_preview.json',
                    'size': stat.st_size,
                    'modified': stat.st_mtime
                })
        if preview_files:
            auto_files['preview'] = max(preview_files, key=lambda x: x['modified'])
        
        loaded_data = {}
        
        # Load embeddings file content (binary)
        if 'embeddings' in auto_files:
            embeddings_path = auto_files['embeddings']['path']
            try:
                with open(embeddings_path, 'rb') as f:
                    content = f.read()
                loaded_data['embeddings'] = {
                    'content': content.hex(),  # Convert binary to hex string for JSON
                    'info': auto_files['embeddings']
                }
            except Exception as e:
                print(f"❌ Embeddings 파일 로드 오류: {e}")
        
        # Load segments file content
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
        
        # Load preview file content
        if 'preview' in auto_files:
            preview_path = auto_files['preview']['path']
            try:
                with open(preview_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                loaded_data['preview'] = {
                    'content': content,
                    'info': auto_files['preview']
                }
            except Exception as e:
                print(f"❌ Preview 파일 로드 오류: {e}")
        
        return web.json_response({
            'status': 'ok',
            'loaded_files': loaded_data,
            'found': list(loaded_data.keys())
        })
        
    except Exception as e:
        print(f"❌ 자동 파일 로드 오류: {e}")
        return web.json_response({"error": str(e)}, status=500)

def setup_embeddings_routes(app):
    """Embeddings 관련 라우트들을 앱에 등록"""
    app.router.add_get('/embeddings', embeddings_page_handler)
    app.router.add_get('/embeddings/auto-load', auto_load_files_handler)
