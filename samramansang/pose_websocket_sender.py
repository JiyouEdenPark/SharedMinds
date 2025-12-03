"""
WebSocket을 통한 포즈 데이터 및 비디오 프레임 전송 모듈
WebRTC와 완전히 독립적으로 작동
"""
import time
import asyncio
import cv2
import base64
import numpy as np
from infer_runner import InferRunner
from pose_processor import PoseProcessor
from websocket_manager import websocket_manager


class PoseWebSocketSender:
    """포즈 데이터와 비디오 프레임을 WebSocket으로 전송하는 독립적인 태스크"""
    
    def __init__(self, state, infer_pose: InferRunner, infer_hand: InferRunner = None, fps=30, send_video=True, video_quality=85, recorder=None):
        self.state = state
        self.infer_pose = infer_pose
        self.infer_hand = infer_hand
        self.fps = fps
        self.target_dt = 1.0 / self.fps
        self.last_send_time = 0
        self._is_running = False
        self._task = None
        self.send_video = send_video  # 비디오 전송 여부
        self.video_quality = video_quality  # JPEG 품질 (1-100)
        self.recorder = recorder  # 포즈 데이터 레코더 (optional)
        
        # 포즈 데이터 프로세서 (공통 로직)
        self.pose_processor = PoseProcessor()
    
    def start(self):
        """포즈 데이터 전송 태스크 시작"""
        if self._is_running:
            return
        
        self._is_running = True
        self._task = asyncio.create_task(self._send_loop())
        print(f"📡 포즈 데이터 WebSocket 전송 태스크 시작 (FPS: {self.fps})")
    
    def stop(self):
        """포즈 데이터 전송 태스크 정지"""
        if not self._is_running:
            return
        
        self._is_running = False
        if self._task:
            self._task.cancel()
        print("📡 포즈 데이터 WebSocket 전송 태스크 정지")
    
    def _encode_frame(self, frame):
        """프레임을 JPEG base64로 인코딩"""
        if frame is None:
            return None
        
        try:
            # JPEG 압축 (품질 설정)
            encode_params = [cv2.IMWRITE_JPEG_QUALITY, self.video_quality]
            _, buffer = cv2.imencode('.jpg', frame, encode_params)
            
            # base64 인코딩
            frame_base64 = base64.b64encode(buffer).decode('utf-8')
            return frame_base64
        except Exception as e:
            print(f"⚠️ 프레임 인코딩 오류: {e}")
            return None
    
    async def _send_loop(self):
        """포즈 데이터 및 비디오 프레임 전송 루프"""
        while self._is_running:
            try:
                t0 = time.perf_counter()
                
                # 최신 프레임 가져오기
                frame, frame_seq = self.state.get_latest()
                
                # 포즈 결과 가져오기
                result_pose = self.infer_pose.get_latest_result()
                result_hand = self.infer_hand.get_latest_result() if self.infer_hand else None
                
                # FPS 제한 확인
                current_time = time.perf_counter()
                if current_time - self.last_send_time >= self.target_dt:
                    payload = {}
                    
                    # 포즈 데이터 처리
                    if result_pose is not None:
                        # 메타데이터 후처리 파이프라인 (공통 프로세서 사용)
                        result_pose = self.pose_processor.postprocess_meta(result_pose)
                        result_pose = self.pose_processor.add_hand_results(result_pose, result_hand)
                        
                        # 포즈 데이터 추출 (공통 프로세서 사용)
                        kpts, hands = self.pose_processor.extract_pose_data(result_pose)
                        
                        payload.update({
                            "type": "kpts",
                            "kpts": kpts,
                            "W": result_pose.orig_shape[1],
                            "H": result_pose.orig_shape[0]
                        })
                        
                        if hands:
                            payload["hands"] = hands
                    
                    # 비디오 프레임 처리
                    if self.send_video and frame is not None:
                        frame_base64 = self._encode_frame(frame)
                        if frame_base64:
                            payload.update({
                                "type": "frame" if "type" not in payload else "frame_kpts",
                                "frame": frame_base64,
                                "frameSeq": frame_seq
                            })
                            # 포즈 데이터가 없어도 프레임 크기 정보는 포함
                            if "W" not in payload:
                                h, w = frame.shape[:2]
                                payload["W"] = w
                                payload["H"] = h
                    
                    # WebSocket 매니저로 브로드캐스트
                    if payload:
                        await websocket_manager.broadcast(payload)
                        self.last_send_time = current_time
                        
                        # Recorder에 포즈 데이터 추가 (활성 상태일 때만)
                        if self.recorder is not None and result_pose is not None:
                            try:
                                if hasattr(self.recorder, 'is_active') and self.recorder.is_active():
                                    if hasattr(result_pose, 'keypoints') and result_pose.keypoints is not None:
                                        pts_np = result_pose.keypoints.data[0].cpu().numpy()  # (17,3)
                                        W = int(result_pose.orig_shape[1])
                                        H = int(result_pose.orig_shape[0])
                                        if hasattr(self.recorder, 'append'):
                                            self.recorder.append(pts_np, W, H, fps=self.fps)
                            except Exception:
                                pass
                
                # FPS 유지를 위한 대기
                elapsed = time.perf_counter() - t0
                sleep_time = self.target_dt - elapsed
                if sleep_time > 0:
                    await asyncio.sleep(sleep_time)
                else:
                    await asyncio.sleep(0)  # CPU 양보
                    
            except asyncio.CancelledError:
                print("📡 포즈 데이터 WebSocket 전송 태스크 취소됨")
                raise
            except Exception as e:
                print(f"❌ 포즈 데이터 WebSocket 전송 오류: {e}")
                await asyncio.sleep(0.1)  # 오류 시 잠시 대기

