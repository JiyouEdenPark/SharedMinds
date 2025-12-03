## 개요

이 디렉토리는 포즈 기반 동작 임베딩의 사전학습(SimCLR)부터 임베딩 시각화, 클러스터링, 세그먼트 생성, 대표 샘플 선택, 경량 결과물 내보내기까지의 전체 파이프라인을 포함합니다.

- 입력: JSONL/Parquet 포맷의 포즈 시퀀스(`kpts` 또는 `keypoints`)
- 출력: 학습 체크포인트, 임베딩(npy), 2D 임베딩, 세그먼트 JSON, 대표 샘플 JSON/Parquet


## 데이터 전처리(윈도우 단위)

윈도우 단위(T 프레임, 기본 32)로 포즈 데이터를 슬라이싱하고, 유효성 검증과 정규화, 선택적으로 증강을 수행합니다. 구현은 `training/window_dataset.py`에 있습니다.

- 윈도우 생성: `stride` 간격으로 길이 `T` 윈도우 생성 → 배열 `(T, 17, 3)`
- 유효성 필터: 각 프레임에서 confidence가 `conf_thr` 이상인 포인트 개수를 합산하여 `min_visible_per_frame * T` 이상인 경우만 통과
- 센터/스케일 정규화(`center_and_scale`):
  - 프레임별 가중 중심(신뢰도 0.2 이상)에 맞춰 좌표를 원점으로 이동
  - 윈도우 전체에서 좌/우 어깨(조인트 5–6) 거리의 중앙값(양수만 대상)을 스케일로 사용해 좌표를 나눔
  - 어깨폭이 불안정한 경우 전체 좌표 표준편차 대체 → 크기-불변 표현에 가까워짐
- 증강(SimCLR 모드):
  - Gaussian jitter, 전역 스케일, 소각 회전, 시간 마스킹(일부 프레임 confidence 0), 좌/우 플립(+조인트 스왑)
- 텐서 형식: `(C=3, J=17, T)`로 변환하여 모델 입력으로 사용


## 모델 및 임베딩

- 인코더: `TemporalEncoder`
  - 입력 `(B, C, J, T)`를 TCN으로 처리한 뒤 시간 평균(GAP) → 임베딩 `(B, emb_dim)`
  - 선택적 `JointMixer`로 관절 축 혼합
- SimCLR 학습: `MotionEncoder = TemporalEncoder + ProjectionHead`
  - 투영 헤드에서 정규화된 투영 벡터 `z`를 만들어 InfoNCE(대조 학습) 손실 계산
- 임베딩 단위: 프레임이 아닌 윈도우 단위로 1개 임베딩을 생성 (겹치는 윈도우는 유사 임베딩)


## 학습(SimCLR)

엔트리: `training/train_simclr.py`

- 손실: InfoNCE(NT-Xent)
- 옵티마/스케줄러: AdamW, CosineAnnealingLR
- AMP: 선택적(`--amp`)
- 출력 체크포인트: `runs/simclr/last.pt`, `runs/simclr/best.pt`

주요 인자:
- `--data_glob`: 입력 파일 글롭 경로 (예: `dataset/raw/*.jsonl`)
- `--window`, `--stride`: 윈도우/스트라이드
- `--epochs`, `--batch_size`, `--lr`, `--weight_decay`, `--temperature`, `--workers`, `--device`, `--save_dir`, `--amp`

실행 예시:

```bash
python training/train_simclr.py \
  --data_glob 'dataset/raw/*.jsonl' \
  --window 32 --stride 8 \
  --epochs 100 --batch_size 128 \
  --lr 1e-3 --weight_decay 1e-4 \
  --temperature 0.1 --workers 4 \
  --device cuda --save_dir runs/simclr
```


## 엔드투엔드 파이프라인

엔트리: `training/run_pipeline.py`

순서:
1) SimCLR 학습 → `best.pt`
2) 임베딩 추출 → `runs/embeddings.npy`(+ 미리보기/인덱스 JSON)
3) 2D 임베딩 시각화(UMAP/TSNE) → `runs/embeddings_2d.npy`
4) 클러스터링 및 세그먼트 생성 → `runs/segments.json`
5) 대표 세그먼트 선택 → `runs/segments_representative.json`
6) 대표 구간 경량 Parquet 내보내기 → `runs/segments_representative.parquet`

핵심 인자:
- 공통: `--data_glob --window --stride --device --save_dir`
- 학습: `--epochs --batch_size --lr --weight_decay --temperature --workers --amp`
- 임베딩: `--emb_out --emb_2d_out --viz_method --perplexity`
- 클러스터링: `--algo {kmeans,hdbscan} --k --pca --hdb_min_cluster --hdb_min_samples`
- 세그먼트 후처리: `--min_len --merge_gap --max_len_windows`
- 컷 정밀화: `--split_criterion {neutral,energy,var,jerk,proto,rules}`
  - `neutral_mode {global,label}`, `neutral_radius`, `var_win`, `windows_preview`
- 엣지 트리밍(옵션): `--trim_edges` `--edge_radius`
- 대표 선택: `--rep_method {per_label_k,threshold} --rep_k --rep_thr --rep_out`
- 경량 내보내기: `--files_glob --reduced_parquet_out`

실행 예시:

```bash
python training/run_pipeline.py \
  --data_glob 'dataset/raw/*.jsonl' \
  --window 32 --stride 8 --device cuda \
  --epochs 100 --batch_size 128 --lr 1e-3 --weight_decay 1e-4 \
  --temperature 0.1 --workers 4 --save_dir runs/simclr \
  --algo hdbscan --hdb_min_cluster 5 --hdb_min_samples 3 \
  --min_len 5 --merge_gap 2 --max_len_windows 10 \
  --split_criterion rules --neutral_mode global --neutral_radius 3 --var_win 3
```


## 클러스터링 → 세그먼트 생성

엔트리: `training/cluster_and_segment.py`

절차:
1) 라벨 예측: KMeans 또는 HDBSCAN으로 윈도우 임베딩에 대한 라벨 시퀀스 생성(-1은 노이즈)
2) 연속 라벨 병합: 같은 라벨이 연속된 구간을 `(start, end, label)`로 묶음
3) 짧은 구간 병합: 길이 `< min_len`이고, 앞 구간과의 간격 `≤ merge_gap`이면 앞 구간으로 흡수
4) 긴 구간 분할: `max_len_windows` 초과 구간을 나누는데, 균등 분할 또는 `split_criterion`으로 경계 후보(반경 `neutral_radius`)에서 가장 좋은 컷을 선택
   - neutral: 중립 벡터(전역/라벨별 프로토타입)와의 거리 최소
   - energy/jerk/var: 변화량/2차 차분/국소 분산 최소
   - proto: 라벨 프로토타입과의 거리 최소
   - rules: 중간 프레임 keypoints 프리뷰로 계산한 휴리스틱 점수 최소

5) 엣지 트리밍(옵션): `--trim_edges` 사용 시 세그먼트의 시작/끝을 동일한 기준(`split_criterion`)으로 평가하여, 각 엣지 인근(`--edge_radius`)에서 점수가 가장 좋은 프레임으로 미세 조정합니다. 최소 길이(`min_len`) 미만이 되면 원 구간을 유지합니다.

노이즈 처리 팁:
- HDBSCAN에서 -1 라벨은 밀도 낮은 전환/이상치인 경우가 많습니다. 필요 시 후처리에서 제거·흡수 규칙을 추가할 수 있습니다.


## 대표 세그먼트 선택

엔트리: `training/select_representatives.py`

세그먼트 임베딩: 각 세그먼트 `[start,end]` 구간의 윈도우 임베딩 평균

방식:
- per_label_k(기본): 라벨별 코사인 정규화 센트로이드에 가장 가까운 k개 선택 → 라벨 균형 보장
- threshold: 모든 세그먼트를 코사인 정규화 후 그리디로 선택, 기존 선택들과의 최소 코사인 거리(`1-유사도`)가 임계값 이상인 것만 채택 → 다양성 보장

확장 팁:
- per_label_k 내부에 다양성 임계값을 추가하거나, threshold 방식의 선택 순서를 중요도(길이, 스코어) 기준으로 정렬하여 품질을 높일 수 있습니다.


## 산출물

- 체크포인트: `runs/simclr/last.pt`, `runs/simclr/best.pt`
- 임베딩: `runs/embeddings.npy`, 2D 임베딩 `runs/embeddings_2d.npy`
- 세그먼트: `runs/segments.json`
- 대표: `runs/segments_representative.json`, `runs/segments_representative.parquet`
- 미리보기/인덱스: `runs/windows_preview.json`, `runs/windows_index.json`

