"""
포즈 데이터 처리 공통 모듈
webrtc_manager와 pose_websocket_sender에서 공통으로 사용
"""
from noise_filter import server_noise_filter


class PoseProcessor:
    """포즈 데이터 후처리 프로세서"""
    
    def __init__(self):
        # 트래킹 ID 유지 상태 (YOLO track 모드일 때 사용)
        self._primary_track_id = None
        self._missing_id_frames = 0
        self._missing_id_reset_threshold = 15  # N 프레임 연속 미탐지 시 재선택
    
    def postprocess_meta(self, meta):
        """메타데이터 후처리 파이프라인"""
        if not hasattr(meta, "keypoints") or meta.keypoints is None:
            return meta
        
        try:
            # 선택할 대상 인덱스 결정 (track 모드라면 동일 ID 우선)
            idx_sel = 0
            try:
                boxes = getattr(meta, 'boxes', None)
                if boxes is not None and len(boxes) > 0:
                    ids_t = getattr(boxes, 'id', None)
                    xyxy_t = getattr(boxes, 'xyxy', None)
                    cls_t = getattr(boxes, 'cls', None)
                    
                    if ids_t is not None:
                        ids_arr = ids_t.cpu().numpy().reshape(-1)
                        # 1) 기존 primary ID가 없으면 가장 큰 사람을 primary로 선택
                        if self._primary_track_id is None:
                            # 후보 인덱스 (사람 클래스=0 우선)
                            idxs = list(range(len(ids_arr)))
                            if cls_t is not None:
                                cls_arr = cls_t.cpu().numpy().astype('int32')
                                idxs = [i for i in idxs if cls_arr[i] == 0]
                                if not idxs:
                                    idxs = list(range(len(ids_arr)))
                            # 면적 기반 선택
                            best = 0
                            if xyxy_t is not None:
                                xyxy = xyxy_t.cpu().numpy()
                                areas = (xyxy[:, 2] - xyxy[:, 0]) * (xyxy[:, 3] - xyxy[:, 1])
                                if idxs:
                                    best = max(idxs, key=lambda i: float(areas[i]))
                            else:
                                if idxs:
                                    best = idxs[0]
                            try:
                                pid = int(ids_arr[best])
                                self._primary_track_id = pid
                                self._missing_id_frames = 0
                                idx_sel = best
                            except Exception:
                                pass
                        else:
                            # 2) 기존 primary ID가 있으면 해당 ID의 인덱스를 찾는다
                            try:
                                import numpy as _np  # 보조 (ultralytics.utils의 np 대신 안전)
                                matches = _np.where(ids_arr.astype('int64') == int(self._primary_track_id))[0]
                            except Exception:
                                matches = []
                            if matches is not None and len(matches) > 0:
                                idx_sel = int(matches[0])
                                self._missing_id_frames = 0
                            else:
                                # 못 찾으면 누락 카운트 증가 후 임계 초과 시 재선택
                                self._missing_id_frames += 1
                                if self._missing_id_frames >= self._missing_id_reset_threshold:
                                    self._primary_track_id = None
                                    self._missing_id_frames = 0
                                    # 즉시 재선택 시도 (가장 큰 사람)
                                    try:
                                        if xyxy_t is not None:
                                            xyxy = xyxy_t.cpu().numpy()
                                            areas = (xyxy[:, 2] - xyxy[:, 0]) * (xyxy[:, 3] - xyxy[:, 1])
                                            idxs = list(range(len(ids_arr)))
                                            if cls_t is not None:
                                                cls_arr = cls_t.cpu().numpy().astype('int32')
                                                idxs = [i for i in idxs if cls_arr[i] == 0]
                                                if not idxs:
                                                    idxs = list(range(len(ids_arr)))
                                            if idxs:
                                                idx_sel = max(idxs, key=lambda i: float(areas[i]))
                                    except Exception:
                                        pass
            except Exception:
                idx_sel = 0
            
            # 원시 키포인트 데이터 (선택한 인덱스)
            original_keypoints = meta.keypoints.data[idx_sel].cpu().numpy()  # (17,3)
            
            # 서버 측 노이즈 필터 적용
            filtered_keypoints = server_noise_filter.filter(original_keypoints)
            
            # 필터링된 키포인트를 메타데이터에 추가
            if filtered_keypoints is not None:
                # 새로운 메타데이터 객체 생성 (원본 보존)
                import copy
                processed_meta = copy.deepcopy(meta)
                
                # 필터링된 키포인트를 CPU 텐서로 변환
                import torch
                filtered_tensor = torch.from_numpy(filtered_keypoints).float()
                processed_meta.keypoints.data = filtered_tensor.unsqueeze(0)  # (1, 17, 3)
                
                # 원본과 필터링된 데이터 모두 저장
                processed_meta.original_keypoints = meta.keypoints  # 원본 보존
                
                return processed_meta
            else:
                return meta
                
        except Exception as e:
            print(f"⚠️ 메타데이터 후처리 오류: {e}")
            return meta
    
    def add_hand_results(self, result_pose, result_hand):
        """손 인식 결과를 메타데이터에 추가"""
        if result_hand is None:
            return result_pose
        
        if not hasattr(result_pose, 'hands'):
            result_pose.hands = []
        
        try:
            # handpose 결과 처리 (YOLO 또는 MediaPipe 결과 형식)
            if hasattr(result_hand, 'keypoints') and result_hand.keypoints is not None:
                # 손 키포인트를 리스트로 변환
                hand_kpts = []
                hand_handedness = []
                # numpy array인 경우 (MediaPipe)
                if hasattr(result_hand.keypoints.data, 'shape') and not hasattr(result_hand.keypoints.data, 'cpu'):
                    import numpy as np
                    for i in range(result_hand.keypoints.data.shape[0]):
                        hand_data = result_hand.keypoints.data[i]  # (K,3)
                        hand_kpts.append([[float(p[0]), float(p[1]), float(p[2])] for p in hand_data])
                    
                    # MediaPipe handedness 정보 추출
                    if hasattr(result_hand, 'handedness') and result_hand.handedness:
                        hand_handedness = result_hand.handedness
                # torch tensor인 경우 (YOLO)
                elif hasattr(result_hand.keypoints.data, 'cpu'):
                    for i in range(result_hand.keypoints.data.shape[0]):
                        hand_data = result_hand.keypoints.data[i].cpu().numpy()  # (K,3)
                        hand_kpts.append([[float(p[0]), float(p[1]), float(p[2])] for p in hand_data])
                
                result_pose.hands = hand_kpts
                # handedness 정보가 있으면 추가
                if hand_handedness:
                    result_pose.hand_handedness = hand_handedness
            elif hasattr(result_hand, 'boxes') and result_hand.boxes is not None:
                # 박스 정보만 있는 경우
                result_pose.hand_boxes = result_hand.boxes
        except Exception as e:
            print(f"⚠️ 손 인식 결과 처리 오류: {e}")
        
        return result_pose
    
    def extract_pose_data(self, result_pose):
        """포즈 데이터 추출 (키포인트와 손 정보)"""
        kpts = []
        hands = None
        
        if result_pose is None:
            return kpts, hands
        
        # 키포인트 추출
        if hasattr(result_pose, "keypoints") and result_pose.keypoints is not None:
            pts = result_pose.keypoints.data[0].cpu().numpy()  # (K,3) = x,y,score
            kpts = [[int(p[0]), int(p[1]), float(p[2])] for p in pts]
        
        # 손 인식 결과 추출
        if hasattr(result_pose, 'hands') and result_pose.hands:
            hands = result_pose.hands
        
        return kpts, hands

