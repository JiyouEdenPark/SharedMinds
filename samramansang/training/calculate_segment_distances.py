#!/usr/bin/env python3
"""
세그먼트들 사이의 거리를 계산하고 가장 가까운 3개 세그먼트를 찾는 스크립트
"""

import json
import numpy as np
import argparse
from typing import List, Dict, Tuple
from scipy.spatial.distance import cdist
from sklearn.metrics.pairwise import cosine_distances, euclidean_distances


def parse_args():
    parser = argparse.ArgumentParser(description='Calculate distances between segments')
    parser.add_argument('--embeddings', type=str, required=True, help='Path to embeddings.npy file')
    parser.add_argument('--segments', type=str, required=True, help='Path to segments.json file')
    parser.add_argument('--out', type=str, default='segment_distances.json', help='Output file path')
    # distance_metric 파라미터 제거 (코사인 거리만 사용)
    parser.add_argument('--top_k', type=int, default=3, help='Number of nearest segments to find')
    # segment_representation 파라미터 제거 (transition 방법만 사용)
    
    return parser.parse_args()


def load_embeddings(embeddings_path: str) -> np.ndarray:
    """임베딩 파일 로드"""
    embeddings = np.load(embeddings_path)
    print(f"Loaded embeddings: {embeddings.shape}")
    return embeddings


def load_segments(segments_path: str) -> Dict:
    """세그먼트 파일 로드"""
    with open(segments_path, 'r', encoding='utf-8') as f:
        segments_data = json.load(f)
    print(f"Loaded segments: {len(segments_data['segments'])} segments")
    return segments_data


def get_segment_transition_representation(embeddings: np.ndarray, segment: Dict, is_reference: bool = True) -> np.ndarray:
    """세그먼트 전환점 표현: 기준 세그먼트는 마지막, 비교 대상은 첫 번째"""
    start = segment['start']
    end = segment['end']
    
    if is_reference:
        # 기준 세그먼트: 마지막 윈도우 사용
        return embeddings[end]
    else:
        # 비교 대상 세그먼트: 첫 번째 윈도우 사용
        return embeddings[start]


def calculate_segment_distances(embeddings: np.ndarray, segments: List[Dict]) -> np.ndarray:
    """세그먼트들 사이의 거리 계산 (전환점 방법 + 코사인 거리만 사용)"""
    print("Calculating segment distances using transition method (reference: last, target: first) with cosine distance...")
    return calculate_transition_distances(embeddings, segments)


def calculate_transition_distances(embeddings: np.ndarray, segments: List[Dict]) -> np.ndarray:
    """세그먼트 전환점 거리 계산: 기준 세그먼트의 마지막 vs 비교 대상의 첫 번째 (코사인 거리만 사용)"""
    n_segments = len(segments)
    distance_matrix = np.zeros((n_segments, n_segments))
    
    for i in range(n_segments):
        # 기준 세그먼트의 마지막 윈도우 임베딩
        reference_vector = get_segment_transition_representation(embeddings, segments[i], is_reference=True)
        
        for j in range(n_segments):
            if i == j:
                distance_matrix[i, j] = 0.0  # 자기 자신과의 거리는 0
            else:
                # 비교 대상 세그먼트의 첫 번째 윈도우 임베딩
                target_vector = get_segment_transition_representation(embeddings, segments[j], is_reference=False)
                
                # 코사인 거리 계산 = 1 - 코사인 유사도
                cos_sim = np.dot(reference_vector, target_vector) / (
                    np.linalg.norm(reference_vector) * np.linalg.norm(target_vector)
                )
                distance = 1 - cos_sim
                distance_matrix[i, j] = distance
                
                # 디버깅: 거리가 매우 큰 경우 로그 출력
                if distance > 0.8:
                    print(f"⚠️ 큰 거리 발견: 세그먼트 {i} → {j}, 거리: {distance:.4f}")
                    print(f"   세그먼트 {i}: 윈도우 {segments[i]['start']}-{segments[i]['end']}, 라벨: {segments[i]['label']}")
                    print(f"   세그먼트 {j}: 윈도우 {segments[j]['start']}-{segments[j]['end']}, 라벨: {segments[j]['label']}")
                    print(f"   기준 벡터 크기: {np.linalg.norm(reference_vector):.4f}")
                    print(f"   대상 벡터 크기: {np.linalg.norm(target_vector):.4f}")
                    print(f"   코사인 유사도: {cos_sim:.4f}")
                    print()
    
    print(f"Transition distance matrix shape: {distance_matrix.shape}")
    
    # 거리 통계 분석
    distances = distance_matrix[distance_matrix > 0]  # 자기 자신과의 거리(0) 제외
    print(f"거리 통계:")
    print(f"  평균: {np.mean(distances):.4f}")
    print(f"  표준편차: {np.std(distances):.4f}")
    print(f"  최소값: {np.min(distances):.4f}")
    print(f"  최대값: {np.max(distances):.4f}")
    print(f"  거리 > 0.8인 쌍: {np.sum(distances > 0.8)}개")
    print(f"  거리 < 0.2인 쌍: {np.sum(distances < 0.2)}개")
    
    return distance_matrix


def find_nearest_segments(distance_matrix: np.ndarray, top_k: int = 3) -> List[List[Dict]]:
    """각 세그먼트에 대해 가장 가까운 k개 세그먼트 찾기"""
    n_segments = distance_matrix.shape[0]
    nearest_segments = []
    
    for i in range(n_segments):
        # 자기 자신과의 거리는 무한대로 설정 (제외하기 위해)
        distances = distance_matrix[i].copy()
        distances[i] = np.inf
        
        # 가장 가까운 k개 인덱스 찾기
        nearest_indices = np.argsort(distances)[:top_k]
        nearest_distances = distances[nearest_indices]
        
        # 결과 저장
        nearest_info = []
        for j, (idx, dist) in enumerate(zip(nearest_indices, nearest_distances)):
            nearest_info.append({
                'segment_index': int(idx),
                'distance': float(dist),
                'rank': j + 1
            })
        
        nearest_segments.append(nearest_info)
    
    return nearest_segments


def main():
    args = parse_args()
    
    print("=== 세그먼트 거리 계산 시작 ===")
    print(f"임베딩 파일: {args.embeddings}")
    print(f"세그먼트 파일: {args.segments}")
    print(f"거리 메트릭: cosine")
    print(f"세그먼트 표현 방법: transition (기준: 마지막, 대상: 첫 번째)")
    print(f"상위 K개: {args.top_k}")
    
    # 데이터 로드
    embeddings = load_embeddings(args.embeddings)
    segments_data = load_segments(args.segments)
    segments = segments_data['segments']
    
    # 거리 계산
    distance_matrix = calculate_segment_distances(embeddings, segments)
    
    # 가장 가까운 세그먼트 찾기
    nearest_segments = find_nearest_segments(distance_matrix, args.top_k)
    
    # 결과 저장
    result = {
        'metadata': {
            'num_segments': len(segments),
            'distance_metric': 'cosine',
            'segment_representation': 'transition',
            'top_k': args.top_k,
            'embeddings_shape': list(embeddings.shape)
        },
        'segments': segments,
        'nearest_segments': nearest_segments,
        'distance_matrix': distance_matrix.tolist()  # 전체 거리 행렬도 저장
    }
    
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    
    print(f"=== 결과 저장 완료: {args.out} ===")
    print(f"총 {len(segments)}개 세그먼트의 거리 정보 계산 완료")
    
    # 통계 정보 출력
    distances = distance_matrix[np.triu_indices_from(distance_matrix, k=1)]
    print(f"거리 통계:")
    print(f"  평균: {np.mean(distances):.4f}")
    print(f"  표준편차: {np.std(distances):.4f}")
    print(f"  최소값: {np.min(distances):.4f}")
    print(f"  최대값: {np.max(distances):.4f}")


if __name__ == '__main__':
    main()
