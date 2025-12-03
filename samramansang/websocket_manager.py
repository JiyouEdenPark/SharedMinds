import json
import asyncio
import logging
from typing import Dict, Set
from aiohttp import web

logger = logging.getLogger(__name__)


class WebSocketManager:
    """WebSocket 연결 관리자"""
    
    def __init__(self):
        self.connections: Set[web.WebSocketResponse] = set()
        self.connection_info: Dict[web.WebSocketResponse, dict] = {}
        self._lock = asyncio.Lock()  # 동시성 제어를 위한 락
    
    async def register(self, ws: web.WebSocketResponse, remote_addr: str):
        """WebSocket 연결 등록"""
        async with self._lock:
            self.connections.add(ws)
            self.connection_info[ws] = {
                'remote_addr': remote_addr,
                'connected_at': asyncio.get_event_loop().time()
            }
            logger.info(f"📡 WebSocket 연결 등록: {remote_addr} (총 연결 수: {len(self.connections)})")
    
    async def unregister(self, ws: web.WebSocketResponse):
        """WebSocket 연결 해제"""
        async with self._lock:
            if ws in self.connections:
                self.connections.discard(ws)
                info = self.connection_info.pop(ws, {})
                logger.info(f"📡 WebSocket 연결 해제: {info.get('remote_addr', 'unknown')} (남은 연결 수: {len(self.connections)})")
    
    async def broadcast(self, message: dict, exclude: web.WebSocketResponse = None):
        """모든 연결에 메시지 브로드캐스트"""
        async with self._lock:
            if not self.connections:
                return
            
            # Set의 복사본을 만들어 반복 (동시 수정 방지)
            connections_copy = list(self.connections)
        
        message_str = json.dumps(message)
        disconnected = []
        
        # 락을 해제한 상태에서 메시지 전송 (블로킹 방지)
        for ws in connections_copy:
            if ws == exclude:
                continue
            
            # 연결이 이미 제거되었을 수 있으므로 확인
            async with self._lock:
                if ws not in self.connections:
                    continue
            
            try:
                if ws.closed:
                    disconnected.append(ws)
                else:
                    await ws.send_str(message_str)
            except Exception as e:
                logger.warning(f"⚠️ WebSocket 메시지 전송 실패: {e}")
                disconnected.append(ws)
        
        # 끊어진 연결 정리
        for ws in disconnected:
            await self.unregister(ws)
    
    def get_connection_count(self):
        """현재 연결 수 반환"""
        return len(self.connections)
    
    async def close_all(self):
        """모든 연결 종료"""
        async with self._lock:
            connections_copy = list(self.connections)
        
        for ws in connections_copy:
            try:
                await ws.close()
            except:
                pass
            await self.unregister(ws)


# 전역 WebSocket 관리자
websocket_manager = WebSocketManager()


async def websocket_handler(request):
    """WebSocket 핸들러 - 클라이언트 연결만 받고, 서버에서 포즈 데이터를 브로드캐스트"""
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    
    remote_addr = request.remote
    await websocket_manager.register(ws, remote_addr)
    
    try:
        # 연결 유지 (서버에서 클라이언트로 포즈 데이터 전송만 함)
        async for msg in ws:
            if msg.type == web.WSMsgType.ERROR:
                break
    
    except Exception as e:
        logger.error(f"❌ WebSocket 핸들러 오류 ({remote_addr}): {e}")
    
    finally:
        await websocket_manager.unregister(ws)
    
    return ws

