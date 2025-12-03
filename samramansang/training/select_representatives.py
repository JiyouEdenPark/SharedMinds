import argparse
import json
import os
from typing import Dict, List, Tuple

import numpy as np


def parse_args():
    p = argparse.ArgumentParser(description="Select representative segments by deduplicating similar motions")
    p.add_argument("--embeddings", type=str, required=True, help="window-level embeddings (N,D) .npy")
    p.add_argument("--segments", type=str, required=True, help="segments.json from clustering")
    p.add_argument("--out", type=str, default="runs/segments_representative.json")
    p.add_argument("--method", type=str, default="per_label_k", choices=["per_label_k", "threshold"])
    p.add_argument("--per_label_k", type=int, default=5, help="k representatives per label (per_label_k)")
    p.add_argument("--threshold", type=float, default=0.25, help="min cosine distance between picks (threshold)")
    # Optional: exclude segments with large start/end scale change
    p.add_argument("--windows_index", type=str, default="runs/simclr/windows_index.json", help="windows_index.json path (for scale filtering)")
    p.add_argument("--files_glob", type=str, default="dataset/raw/*.jsonl", help="glob for original JSONL files to measure scales")
    p.add_argument("--scale_exclude_thr", type=float, default=1.2, help="exclude if robust scale ratio between first/last frame exceeds this (>1.0). 0 disables")
    return p.parse_args()


def segment_mean_embedding(E: np.ndarray, seg: Dict) -> np.ndarray:
    s = int(seg["start"])
    e = int(seg["end"])
    e = min(e, E.shape[0] - 1)
    s = max(0, min(s, e))
    mean = E[s : e + 1].mean(axis=0)
    return mean


def normalize_rows(X: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(X, axis=1, keepdims=True) + 1e-9
    return X / n


def per_label_topk(seg_embs: np.ndarray, labels: np.ndarray, segments: List[Dict], k: int) -> List[int]:
    reps: List[int] = []
    for lab in np.unique(labels):
        idx = np.where(labels == lab)[0]
        if idx.size == 0:
            continue
        # label centroid
        c = normalize_rows(seg_embs[idx]).mean(axis=0)
        c = c / (np.linalg.norm(c) + 1e-9)
        sims = (normalize_rows(seg_embs[idx]) @ c)
        order = idx[np.argsort(-sims)]  # nearest to centroid first
        reps.extend(order[:k].tolist())
    return reps


def threshold_greedy(seg_embs: np.ndarray, labels: np.ndarray, thr: float) -> List[int]:
    # cosine distance threshold (1 - cosine similarity)
    Z = normalize_rows(seg_embs)
    order = list(range(Z.shape[0]))
    selected: List[int] = []
    for i in order:
        if not selected:
            selected.append(i)
            continue
        dmin = 1.0
        for j in selected:
            sim = float(Z[i] @ Z[j])
            d = 1.0 - sim
            if d < dmin:
                dmin = d
        if dmin >= thr:
            selected.append(i)
    return selected


def _read_jsonl(path: str):
    out = []
    with open(path, 'r') as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                out.append(json.loads(s))
            except Exception:
                pass
    return out


def _get_kpts(item):
    k = item.get('kpts') or item.get('keypoints') or []
    if isinstance(k, list) and len(k) >= 17 and isinstance(k[0], (list, tuple)):
        return (k + [[0.0, 0.0, 0.0]] * 17)[:17]
    return [[0.0, 0.0, 0.0] for _ in range(17)]


def _shoulder_width(k):
    L, R = 5, 6
    ax, ay = float(k[L][0]), float(k[L][1])
    bx, by = float(k[R][0]), float(k[R][1])
    return float(np.hypot(ax - bx, ay - by))


def _hip_width(k):
    L, R = 11, 12
    ax, ay = float(k[L][0]), float(k[L][1])
    bx, by = float(k[R][0]), float(k[R][1])
    return float(np.hypot(ax - bx, ay - by))


def _anchor(k):
    # shoulder center fallback to mean
    L, R = 5, 6
    if k and len(k) > R:
        try:
            ax, ay = float(k[L][0]), float(k[L][1])
            bx, by = float(k[R][0]), float(k[R][1])
            return (ax + bx) * 0.5, (ay + by) * 0.5
        except Exception:
            pass
    cx, cy, cnt = 0.0, 0.0, 0
    for p in k:
        cx += float(p[0]); cy += float(p[1]); cnt += 1
    if cnt > 0:
        cx /= cnt; cy /= cnt
    return cx, cy


def _torso_height(k):
    L, R = 11, 12
    cx, cy = _anchor(k)
    hx = (float(k[L][0]) + float(k[R][0])) * 0.5
    hy = (float(k[L][1]) + float(k[R][1])) * 0.5
    return float(np.hypot(cx - hx, cy - hy))


def _spread(k):
    cx, cy = _anchor(k)
    acc = 0.0; cnt = 0
    for p in k:
        acc += float(np.hypot(float(p[0]) - cx, float(p[1]) - cy))
        cnt += 1
    return acc / max(1, cnt)


def _robust_ratio(kA, kB) -> float:
    eps = 1e-6
    ratios = []
    a, b = float(_shoulder_width(kA)), float(_shoulder_width(kB))
    if a > eps and b > eps: ratios.append(a / b)
    a, b = float(_hip_width(kA)), float(_hip_width(kB))
    if a > eps and b > eps: ratios.append(a / b)
    a, b = float(_torso_height(kA)), float(_torso_height(kB))
    if a > eps and b > eps: ratios.append(a / b)
    a, b = float(_spread(kA)), float(_spread(kB))
    if a > eps and b > eps: ratios.append(a / b)
    if not ratios:
        return 1.0
    # minimal change in log-space
    best = ratios[0]
    best_cost = abs(np.log(max(eps, best)))
    for r in ratios[1:]:
        c = abs(np.log(max(eps, r)))
        if c < best_cost:
            best = r; best_cost = c
    return float(max(0.5, min(2.0, best)))


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)

    E = np.load(args.embeddings)  # (N,D) window-level
    with open(args.segments, 'r') as f:
        S = json.load(f)
    segments = S.get('segments', [])
    labels = np.array([int(s['label']) for s in segments], dtype=np.int32) if segments else np.array([], dtype=np.int32)

    if len(segments) == 0:
        with open(args.out, 'w') as f:
            json.dump({ 'segments': [], 'method': args.method }, f)
        print("No segments to select representatives from.")
        return

    # compute segment embeddings as mean over windows
    seg_embs = np.stack([segment_mean_embedding(E, seg) for seg in segments], axis=0)

    # Optional: filter segments by start/end scale change
    valid_mask = np.ones(len(segments), dtype=bool)
    print(args.scale_exclude_thr, args.windows_index, args.files_glob)
    if args.scale_exclude_thr and args.scale_exclude_thr > 1.0 and args.windows_index and args.files_glob:
        try:
            import glob as _glob
            with open(args.windows_index, 'r') as f:
                W = json.load(f)
            files = sorted(_glob.glob(args.files_glob))
            base_to_path = { os.path.basename(p): p for p in files }
            stride = int(W.get('stride', 8))
            T = int(W.get('window', 32))
            windows = W.get('windows', [])

            def window_to_item(win_idx: int, from_end: bool):
                if win_idx < 0 or win_idx >= len(windows):
                    return None
                wrec = windows[win_idx]
                base = wrec.get('file')
                start = int(wrec.get('start', 0))
                frame_idx = start + (T - 1 if from_end else 0)
                path = base_to_path.get(base)
                if not path:
                    return None
                arr = _read_jsonl(path)
                if frame_idx < 0 or frame_idx >= len(arr):
                    return None
                return arr[frame_idx]

            for i, seg in enumerate(segments):
                ws, we = int(seg['start']), int(seg['end'])
                if we < ws:
                    valid_mask[i] = False
                    continue
                itA = window_to_item(ws, from_end=False)
                itB = window_to_item(we, from_end=True)
                if itA is None or itB is None:
                    continue
                kA = _get_kpts(itA)
                kB = _get_kpts(itB)
                ratio = _robust_ratio(kB, kA)  # compare end vs start
                print(ratio, i)
                if ratio > float(args.scale_exclude_thr) or ratio < 1.0 / float(args.scale_exclude_thr):
                    valid_mask[i] = False
            # apply mask
            seg_embs = seg_embs[valid_mask]
            labels = labels[valid_mask]
            segments = [seg for (seg, ok) in zip(segments, valid_mask) if ok]
        except Exception as e:
            print(f"[warn] scale filter skipped: {e}")

    if args.method == 'per_label_k':
        idx = per_label_topk(seg_embs, labels, segments, args.per_label_k)
    else:
        idx = threshold_greedy(seg_embs, labels, args.threshold)

    idx = sorted(set(idx))
    reps = [ segments[i] for i in idx ]
    payload = {
        'method': args.method,
        'per_label_k': args.per_label_k,
        'threshold': args.threshold,
        'selected_indices': idx,
        'segments': reps,
    }
    with open(args.out, 'w') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Saved representative segments: {len(reps)} -> {args.out}")


if __name__ == '__main__':
    main()


