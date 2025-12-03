"""
Record 관련 라우터
포즈 데이터 녹화 기능 제공
"""

from aiohttp import web
from aiohttp.web import FileResponse


async def record_page_handler(request):
    """Record 페이지 제공"""
    return FileResponse('static/record.html')


async def websocket_toggle_recording_handler(request, recorder):
    """WebSocket용 녹화 시작/중지 토글"""
    try:
        # 현재 녹화 상태 확인
        is_recording = recorder.is_active()
        
        if is_recording:
            # 녹화 중지
            seq_id = recorder.stop()
            message = "녹화가 중지되었습니다."
            print(f"📹 WebSocket 녹화 중지됨 (seq_id: {seq_id})")
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
    
    app.router.add_post("/websocket/toggle-recording", toggle_handler)
    app.router.add_get("/websocket/recording-status", status_handler)

