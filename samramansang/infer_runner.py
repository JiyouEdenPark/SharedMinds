from ultralytics import YOLO
from collections import deque
import threading
import os
from shared_state import SharedState
import torch

MODEL_POSE = os.getenv("MODEL_POSE", "yolo11n-pose.pt")
MODEL_SEG = os.getenv("MODEL_SEG", "yolo11n-seg.pt")
CONF = float(os.getenv("CONF", "0.25"))
POSE_MODE = os.getenv("POSE_MODE", "track").strip().lower()  # 'track' | 'predict'
TRACKER_CFG = os.getenv("TRACKER_CFG", "bytetrack.yaml")

class InferRunner:
    def __init__(self, state: SharedState, model_path=MODEL_POSE, imgsz=640, conf=CONF, mode: str = POSE_MODE, tracker_cfg: str = TRACKER_CFG):
        self.state = state
        self.model = YOLO(model_path)
        self.imgsz = imgsz
        self.conf = conf
        self.mode = (mode or "track").strip().lower()
        self.tracker_cfg = tracker_cfg
        self.results_q = deque(maxlen=2)  # 최신 결과만 유지
        self.thread = None
        # 디바이스 자동 선택 (cuda -> mps -> cpu)
        if torch.cuda.is_available():
            self.device = 0  # ultralytics는 정수 인덱스 허용
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            self.device = "mps"
        else:
            self.device = "cpu"

    def start(self):
        def _loop():
            while not self.state.stop:
                frame, seq = self.state.get_latest()
                if frame is None:
                    continue

                # 선택 가능한 모드: 'track' 또는 'predict'
                if self.mode == "track":
                    # 프레임 간 ID 유지를 위해 persist=True, ByteTrack 기본값 사용
                    r = self.model.track(
                        source=frame,
                        device=self.device,
                        imgsz=self.imgsz,
                        conf=self.conf,
                        iou=0.5,
                        max_det=50,
                        tracker=self.tracker_cfg,
                        persist=True,
                        verbose=False
                    )
                else:
                    r = self.model.predict(
                        source=frame,
                        device=self.device,
                        imgsz=self.imgsz,
                        conf=self.conf,
                        iou=0.5,
                        max_det=50,
                        verbose=False
                    )

                self.results_q.append(r[0])

        self.thread = threading.Thread(target=_loop, daemon=True)
        self.thread.start()

    def get_latest_result(self):
        try:
            # 가장 최신 결과를 제거하지 않고 반환 (멀티 소비자 안전)
            return self.results_q[-1]
        except IndexError:
            return None
