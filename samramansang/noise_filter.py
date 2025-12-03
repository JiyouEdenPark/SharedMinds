"""
서버 측 노이즈 필터
One-Euro Filter를 사용한 포즈 키포인트 안정화
"""

import numpy as np
import time
from typing import Optional, Dict, Any
from collections import deque
from lib.one_euro_filter import OneEuroFilter


class NoiseFilter:
    """서버 측 노이즈 필터 - One-Euro Filter 기반"""
    
    def __init__(self, freq: float = 30.0, mincutoff: float = 1.0, 
                 beta: float = 0.007, dcutoff: float = 1.0, window_size: int = 3):
        """
        서버 노이즈 필터 초기화
        
        Args:
            freq: 샘플링 주파수 (Hz)
            mincutoff: 최소 컷오프 주파수 (Hz)
            beta: 베타 값 (민감도)
            dcutoff: 미분 컷오프 주파수 (Hz)
            window_size: 이동 평균 윈도우 크기
        """
        self.freq = freq
        self.mincutoff = mincutoff
        self.beta = beta
        self.dcutoff = dcutoff
        self.window_size = window_size
        
        # 각 키포인트별로 X, Y 좌표에 대한 One-Euro 필터
        self.one_euro_filters = {}  # keypoint_index -> {x_filter, y_filter}
        
        # 이동 평균 필터 (추가 안정화)
        self.moving_avg_history = deque(maxlen=window_size)
        
        # 마지막 타임스탬프
        self.last_timestamp = None
    
    def _initialize_filters_for_keypoint(self, keypoint_index: int):
        """특정 키포인트에 대한 필터 초기화"""
        if keypoint_index not in self.one_euro_filters:
            x_filter = OneEuroFilter(
                freq=self.freq,
                mincutoff=self.mincutoff,
                beta=self.beta,
                dcutoff=self.dcutoff
            )
            y_filter = OneEuroFilter(
                freq=self.freq,
                mincutoff=self.mincutoff,
                beta=self.beta,
                dcutoff=self.dcutoff
            )
            self.one_euro_filters[keypoint_index] = {
                'x_filter': x_filter,
                'y_filter': y_filter
            }
    
    def filter(self, keypoints: np.ndarray, timestamp: Optional[float] = None) -> Optional[np.ndarray]:
        """
        키포인트에 노이즈 필터 적용
        
        Args:
            keypoints: 키포인트 배열 (17, 3) - [x, y, confidence]
            timestamp: 타임스탬프 (선택사항)
            
        Returns:
            필터링된 키포인트 배열 또는 None
        """
        if keypoints is None or keypoints.shape[0] < 17:
            return None
        
        # 타임스탬프 설정
        if timestamp is None:
            timestamp = time.time()
        
        # 필터링된 키포인트 배열 생성
        filtered_keypoints = np.zeros_like(keypoints)
        
        # 각 키포인트에 대해 필터 적용
        for i in range(min(17, keypoints.shape[0])):
            if keypoints[i, 2] > 0:  # confidence > 0인 경우만 필터링
                # 필터 초기화 (필요시)
                self._initialize_filters_for_keypoint(i)
                
                # One-Euro 필터 적용
                filters = self.one_euro_filters[i]
                filtered_x = filters['x_filter'](keypoints[i, 0], timestamp)
                filtered_y = filters['y_filter'](keypoints[i, 1], timestamp)
                
                filtered_keypoints[i, 0] = filtered_x
                filtered_keypoints[i, 1] = filtered_y
                filtered_keypoints[i, 2] = keypoints[i, 2]  # confidence는 그대로 유지
            else:
                # confidence가 0인 경우 원본 그대로
                filtered_keypoints[i] = keypoints[i]
        
        # 이동 평균 필터 추가 적용 (선택적)
        self.moving_avg_history.append(filtered_keypoints.copy())
        
        if len(self.moving_avg_history) >= 2:
            # 이동 평균 계산
            avg_keypoints = np.zeros_like(filtered_keypoints)
            for kpts in self.moving_avg_history:
                avg_keypoints += kpts
            avg_keypoints /= len(self.moving_avg_history)
            
            # 원본과 이동 평균의 가중 평균 (70% 필터링, 30% 이동평균)
            final_keypoints = 0.7 * filtered_keypoints + 0.3 * avg_keypoints
            final_keypoints[:, 2] = filtered_keypoints[:, 2]  # confidence는 필터링된 값 유지
            
            return final_keypoints
        
        return filtered_keypoints
    
    def reset(self):
        """필터 상태 초기화"""
        self.one_euro_filters.clear()
        self.moving_avg_history.clear()
        self.last_timestamp = None
    
    def get_stats(self) -> Dict[str, Any]:
        """필터 통계 정보 반환"""
        return {
            'freq': self.freq,
            'mincutoff': self.mincutoff,
            'beta': self.beta,
            'dcutoff': self.dcutoff,
            'window_size': self.window_size,
            'active_filters': len(self.one_euro_filters),
            'history_size': len(self.moving_avg_history)
        }


# 전역 서버 노이즈 필터 인스턴스
server_noise_filter = NoiseFilter(
    freq=30.0,      # 30 FPS
    mincutoff=0.001,  # 최소 컷오프 주파수
    beta=0.01,     # 베타 값 (민감도)
    dcutoff=1.0,    # 미분 컷오프 주파수
    window_size=3   # 이동 평균 윈도우 크기
)
