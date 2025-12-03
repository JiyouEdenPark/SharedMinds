import threading


class SharedState:
    def __init__(self):
        self.lock = threading.Lock()
        self.latest_frame = None   # 가장 최신 프레임 (BGR np.ndarray)
        self.latest_seq = 0        # 증가하는 시퀀스 번호
        self.stop = False

    def update_frame(self, frame):
        with self.lock:
            self.latest_frame = frame
            self.latest_seq += 1

    def get_latest(self):
        with self.lock:
            return self.latest_frame, self.latest_seq
