import threading
import time
import cv2
import os

from shared_state import SharedState

SENSOR_ID = int(os.getenv("SENSOR_ID", "0"))
SENSOR_MODE = int(os.getenv("SENSOR_MODE", "2"))
STREAM_SIZE = os.getenv("STREAM_SIZE", "1280x720")
WIDTH, HEIGHT = map(int, STREAM_SIZE.lower().split("x"))
FLIP_METHOD = int(os.getenv("FLIP_METHOD", "0"))

GST = (
    f"nvarguscamerasrc sensor-id={SENSOR_ID} sensor-mode={SENSOR_MODE} ! "
    "video/x-raw(memory:NVMM), framerate=30/1, format=NV12 ! "
    f"nvvidconv flip-method={FLIP_METHOD} ! video/x-raw, format=BGRx, width={WIDTH}, height={HEIGHT} ! "
    "videoconvert ! video/x-raw, format=BGR ! "
    "appsink drop=true max-buffers=1 sync=false"
)

def start_capture_thread(state: SharedState):
    def _loop():
        cap = None
        camera_initialized = False
        
        # 여러 카메라 소스 시도
        camera_sources = [
            # CSI 카메라 (NVIDIA Jetson)
            GST,
            # V4L2 소스들 (Linux)
            "v4l2src device=/dev/video0 ! video/x-raw, format=YUY2, width=640, height=480 ! videoconvert ! video/x-raw, format=BGR ! appsink",
            "v4l2src device=/dev/video1 ! video/x-raw, format=YUY2, width=640, height=480 ! videoconvert ! video/x-raw, format=BGR ! appsink",
            # macOS 전용: AVFoundation 백엔드 장치 0/1
            (0, 'avfoundation'),
            (1, 'avfoundation'),
            # 기본 웹캠 장치 인덱스 (백엔드 자동)
            0,
            1,
        ]
        
        for i, source in enumerate(camera_sources):
            try:
                if isinstance(source, tuple):
                    src_desc = f"{source[0]}/{source[1]}"
                else:
                    src_desc = str(source) if isinstance(source, int) else source
                print(f"🎥 카메라 소스 {i+1} 시도 중: {src_desc[:50]}...")
                if isinstance(source, tuple):
                    # (index, backend_name)
                    idx, backend_name = source
                    backend = None
                    try:
                        name = (backend_name or '').lower()
                        if name == 'avfoundation':
                            backend = getattr(cv2, 'CAP_AVFOUNDATION', 120)
                        elif name == 'gstreamer':
                            backend = cv2.CAP_GSTREAMER
                    except Exception:
                        backend = None
                    if backend is not None:
                        cap = cv2.VideoCapture(idx, backend)
                    else:
                        cap = cv2.VideoCapture(idx)
                elif isinstance(source, int):
                    # OpenCV 기본 장치 인덱스 (macOS/Windows 호환)
                    cap = cv2.VideoCapture(source)
                else:
                    # GStreamer 파이프라인
                    cap = cv2.VideoCapture(source, cv2.CAP_GSTREAMER)
                
                if cap.isOpened():
                    # 기본 해상도/프레임레이트 설정 시도 (가능한 경우)
                    try:
                        cap.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
                        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)
                        cap.set(cv2.CAP_PROP_FPS, 30)
                    except Exception:
                        pass

                    # 워밍업: 여러 프레임을 읽어 안정화
                    warm_ok = False
                    test_frame = None
                    for _ in range(12):
                        ret, test_frame = cap.read()
                        if ret and test_frame is not None and getattr(test_frame, 'size', 0) > 0:
                            warm_ok = True
                            break
                        time.sleep(0.05)

                    if warm_ok:
                        print(f"✅ 카메라 소스 {i+1} 성공: {test_frame.shape}")
                        camera_initialized = True
                        break
                    else:
                        print(f"❌ 카메라 소스 {i+1} 테스트 프레임 실패")
                        cap.release()
                        cap = None
                else:
                    print(f"❌ 카메라 소스 {i+1} 열기 실패")
                    if cap:
                        cap.release()
                        cap = None
            except Exception as e:
                print(f"❌ 카메라 소스 {i+1} 오류: {e}")
                if cap:
                    cap.release()
                    cap = None
        
        if not camera_initialized:
            print("⚠️ 모든 카메라 소스 실패. 더미 프레임으로 대체합니다.")
            # 더미 프레임 생성
            dummy_frame = create_dummy_frame()
            while not state.stop:
                state.update_frame(dummy_frame)
                time.sleep(1.0/30.0)  # 30 FPS
            return
        
        try:
            while not state.stop:
                ok, frame = cap.read()
                if not ok:
                    time.sleep(0.005)
                    continue
                # 여기서 바로 최신 프레임만 갱신
                state.update_frame(frame)
        finally:
            if cap:
                cap.release()

    th = threading.Thread(target=_loop, daemon=True)
    th.start()
    return th

def create_dummy_frame():
    """더미 프레임 생성 (카메라가 없을 때 사용)"""
    import numpy as np
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.putText(frame, "Camera Not Available", (50, 200), 
                cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    cv2.putText(frame, "Using Dummy Frame", (50, 250), 
                cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 255), 2)
    return frame


def frame_gen_latest(state: SharedState, poll_sleep=0.001):
    last = -1
    while not state.stop:
        frame, seq = state.get_latest()
        if frame is not None and seq != last:
            last = seq
            yield frame
        else:
            time.sleep(poll_sleep)


if __name__ == "__main__":
    state = SharedState()
    start_capture_thread(state)
    while True:
        continue