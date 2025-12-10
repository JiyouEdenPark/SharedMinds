import json
import cv2
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from aiohttp import web
import aiohttp_cors

from pose_websocket_sender import PoseWebSocketSender
from websocket_manager import websocket_handler, websocket_manager

# aiohttp access 로그 비활성화
logging.getLogger('aiohttp.access').setLevel(logging.WARNING)
from frame_processor import SharedState, start_capture_thread
from ultralytics.utils import np

from infer_runner import InferRunner
from pose_recorder import PoseRecorder
from training_router import setup_training_routes
from playback_router import setup_playback_routes
from segments_router import setup_segments_routes
from embeddings_router import setup_embeddings_routes
from record_router import setup_record_routes

# 전역 스레드 풀 (프레임 처리용)
frame_executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="FrameProcessor")
state = SharedState()
infer = InferRunner(state,model_path="yolo11m-pose.pt")
infer_hand = None  # 손 인식은 현재 사용하지 않음
recorder = PoseRecorder(root_dir="training/dataset/raw")

pose_ws_sender = PoseWebSocketSender(state, infer, infer_hand=None, fps=30, send_video=True, video_quality=85, recorder=recorder)

# 서버 종료 시 정리
async def cleanup(app):
    """서버 종료 시 리소스 정리"""
    print("🧹 리소스 정리 중...")

    try:
        state.stop = True
        
        # Stop recorder if active
        try:
            if recorder.is_active():
                recorder.stop()
        except Exception:
            pass

        # 포즈 데이터 WebSocket 전송 태스크 정지
        try:
            pose_ws_sender.stop()
        except Exception as e:
            print(f"⚠️ 포즈 데이터 전송 태스크 정지 중 오류 (무시됨): {e}")
        
        # 모든 WebSocket 연결 종료
        try:
            await websocket_manager.close_all()
        except Exception as e:
            print(f"⚠️ WebSocket 연결 종료 중 오류 (무시됨): {e}")
        
        # 스레드 풀 종료
        try:
            if frame_executor:
                frame_executor.shutdown(wait=True)
        except Exception as e:
            print(f"⚠️ 스레드 풀 종료 중 오류 (무시됨): {e}")
        
        print("✅ 리소스 정리 완료")
    except Exception as e:
        print(f"⚠️ 정리 과정에서 오류 발생 (무시됨): {e}")

# 메인 서버 설정
async def main():
    app = web.Application()
    
    # CORS 설정
    cors = aiohttp_cors.setup(app, defaults={
        "*": aiohttp_cors.ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
            allow_methods="*"
        )
    })
    
    # 정적 파일 서빙 설정
    app.router.add_static('/static', path='static', name='static')

    
    # 메인 페이지 라우트
    async def index_handler(request):
        return web.FileResponse('static/index.html')
    
    app.router.add_get('/', index_handler)
    app.router.add_get('/index.html', index_handler)
    
    # WebSocket 라우트
    app.router.add_get('/ws', websocket_handler)
    
    # Training 라우트 등록
    setup_training_routes(app)
    
    # Playback 라우트 등록
    setup_playback_routes(app)
    
    # Segments 라우트 등록
    setup_segments_routes(app)
    
    # Embeddings 라우트 등록
    setup_embeddings_routes(app)
    
    # Record 라우트 등록
    setup_record_routes(app, recorder)
  
    # CORS 적용 - 모든 라우트에 적용 (더 안전한 방법)
    for route in list(app.router.routes()):
        cors.add(route)
    
    # 종료 시 정리
    app.on_shutdown.append(cleanup)

    # 카메라 캡처 스레드 시작
    print("🎥 카메라 캡처 스레드 시작...")
    start_capture_thread(state)
    
    # 추론 엔진 시작
    print("🤖 추론 엔진 시작...")
    infer.start()
    
    # 포즈 데이터 WebSocket 전송 태스크 시작
    print("📡 포즈 데이터 WebSocket 전송 태스크 시작...")
    pose_ws_sender.start()
    
    print("✅ 서버 초기화 완료")
    return app

if __name__ == "__main__":
    import signal
    import sys
    
    def signal_handler(sig, frame):
        print("\n🛑 종료 신호 수신. 서버를 안전하게 종료합니다...")
        sys.exit(0)
    
    # SIGINT (Ctrl+C) 시그널 핸들러 등록
    signal.signal(signal.SIGINT, signal_handler)
    
    try:
        web.run_app(main(), host="0.0.0.0", port=3000)
    except KeyboardInterrupt:
        print("\n🛑 사용자에 의해 종료되었습니다.")
        sys.exit(0)
    except Exception as e:
        print(f"❌ 서버 실행 중 오류 발생: {e}")
        sys.exit(1)
