import os
import json
import time
import threading
from typing import List, Optional, Dict, Any

import numpy as np


class PoseRecorder:
    """
    Record COCO-17 keypoints sequences normalized to [0,1] into dataset/raw as JSONL.

    Each line schema:
      {
        "ts": <unix_ms>,
        "width": <int>,
        "height": <int>,
        "kpts": [[x_norm, y_norm, score], ... 17 items]
      }
    """

    def __init__(self, root_dir: str = "training/dataset/raw"):
        self.root_dir = root_dir
        self._lock = threading.Lock()
        self._active = False
        self._file = None
        self._path = None
        self._seq_id: Optional[str] = None
        self._frame_id: int = 0

        os.makedirs(self.root_dir, exist_ok=True)

    @staticmethod
    def _normalize_keypoints(kpts: np.ndarray, width: int, height: int) -> List[List[float]]:
        """
        kpts: shape (17, 3) with (x, y, score) in pixel space
        returns: list of 17 [x_norm, y_norm, score] where x_norm,y_norm in [0,1]
        """
        if not isinstance(kpts, np.ndarray):
            kpts = np.array(kpts, dtype=np.float32)
        if kpts.ndim != 2 or kpts.shape[0] < 17 or kpts.shape[1] < 2:
            raise ValueError("kpts must be (17, >=2)")

        w = max(1, int(width))
        h = max(1, int(height))
        out: List[List[float]] = []
        for i in range(17):
            x = float(kpts[i, 0]) / w
            y = float(kpts[i, 1]) / h
            s = float(kpts[i, 2]) if kpts.shape[1] >= 3 else 1.0
            # clamp for safety
            x = 0.0 if not np.isfinite(x) else max(0.0, min(1.0, x))
            y = 0.0 if not np.isfinite(y) else max(0.0, min(1.0, y))
            s = 0.0 if not np.isfinite(s) else max(0.0, min(1.0, s))
            out.append([x, y, s])
        return out

    def start(self) -> str:
        with self._lock:
            if self._active:
                return self._seq_id or ""
            # generate seq_id based on ms timestamp
            ms = int(time.time() * 1000)
            self._seq_id = f"seq-{ms}"
            self._frame_id = 0
            filename = f"{self._seq_id}.jsonl"
            path = os.path.join(self.root_dir, filename)
            self._file = open(path, "a", buffering=1)
            self._path = path
            self._active = True
            return self._seq_id

    def stop(self) -> Optional[str]:
        with self._lock:
            if not self._active:
                return self._seq_id
            try:
                if self._file:
                    self._file.flush()
                    self._file.close()
            finally:
                self._file = None
                self._active = False
                return self._seq_id

    def cancel(self) -> Optional[str]:
        """녹화를 취소하고 파일을 삭제 (저장하지 않음)"""
        with self._lock:
            if not self._active:
                return self._seq_id
            seq_id = self._seq_id
            path = self._path
            try:
                if self._file:
                    self._file.close()
            except Exception:
                pass
            finally:
                self._file = None
                self._active = False
                self._seq_id = None
                self._path = None
                # 파일 삭제 (저장하지 않음)
                if path and os.path.exists(path):
                    try:
                        os.remove(path)
                    except Exception:
                        pass
                return seq_id

    def is_active(self) -> bool:
        with self._lock:
            return self._active

    def append(self, keypoints: np.ndarray, width: int, height: int, fps: Optional[float] = None, extra: Optional[Dict[str, Any]] = None):
        with self._lock:
            if not self._active or self._file is None:
                return
            try:
                kpts_norm = self._normalize_keypoints(keypoints, width, height)
                obj: Dict[str, Any] = {
                    "ts": int(time.time() * 1000),
                    "width": int(width),
                    "height": int(height),
                    "seq_id": self._seq_id,
                    "frame_id": int(self._frame_id),
                    "fps": float(fps) if fps is not None else None,
                    "kpts": kpts_norm,
                }
                if isinstance(extra, dict):
                    obj.update(extra)
                self._file.write(json.dumps(obj, ensure_ascii=False) + "\n")
                self._frame_id += 1
            except Exception:
                # fail silently to not disrupt realtime loop
                pass

    def current_seq_id(self) -> Optional[str]:
        with self._lock:
            return self._seq_id

    def current_path(self) -> Optional[str]:
        with self._lock:
            return self._path


