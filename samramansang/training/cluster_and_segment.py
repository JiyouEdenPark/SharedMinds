import argparse
import json
import os
import numpy as np
from typing import List, Tuple

from sklearn.cluster import KMeans
from sklearn.decomposition import PCA


def parse_args():
    p = argparse.ArgumentParser(description="Cluster embeddings and detect change points")
    p.add_argument("--embeddings", type=str, required=True)
    p.add_argument("--out", type=str, default="runs/segments.json")
    p.add_argument("--algo", type=str, default="hdbscan", choices=["kmeans", "hdbscan"], help="clustering algo")
    p.add_argument("--k", type=int, default=8, help="KMeans clusters (when algo=kmeans)")
    p.add_argument("--hdb_min_cluster", type=int, default=5, help="HDBSCAN min_cluster_size")
    p.add_argument("--hdb_min_samples", type=int, default=3, help="HDBSCAN min_samples")
    p.add_argument("--pca", type=int, default=0, help="Reduce dims with PCA (0=off)")
    p.add_argument("--min_len", type=int, default=5, help="min segment windows")
    p.add_argument("--merge_gap", type=int, default=2, help="merge adjacent small gaps")
    p.add_argument("--window", type=int, default=32)
    p.add_argument("--stride", type=int, default=8)
    p.add_argument("--max_len_windows", type=int, default=10, help="maximum windows per segment (split if longer)")
    # Neutral-aware splitting options (backward compatible)
    p.add_argument("--neutral_mode", type=str, default="global", choices=["global", "label"], help="how to define neutral pose vector")
    p.add_argument("--neutral_radius", type=int, default=3, help="search radius around nominal split point")
    # New generalized criterion
    p.add_argument("--split_criterion", type=str, default="neutral", choices=["neutral", "energy", "var", "jerk", "proto", "rules"], help="how to score candidate cut points")
    p.add_argument("--var_win", type=int, default=3, help="window half-size for variance criterion")
    p.add_argument("--windows_preview", type=str, default="runs/windows_preview.json", help="path to windows preview (mid-frame kpts per window) for rules criterion")
    # Edge trimming to neutral (optional)
    p.add_argument("--trim_edges", action="store_true", help="trim segment edges toward neutral frames")
    p.add_argument("--edge_radius", type=int, default=3, help="search radius near edges when trimming")
    return p.parse_args()


def label_runs(labels: np.ndarray) -> List[Tuple[int, int, int]]:
    """Return list of (start, end, label) for consecutive runs on 0..N-1 inclusive indices."""
    n = len(labels)
    if n == 0:
        return []
    out = []
    s = 0
    cur = int(labels[0])
    for i in range(1, n):
        if int(labels[i]) != cur:
            out.append((s, i - 1, cur))
            s = i
            cur = int(labels[i])
    out.append((s, n - 1, cur))
    return out


def merge_short_segments(segs: List[Tuple[int, int, int]], min_len: int, merge_gap: int) -> List[Tuple[int, int, int]]:
    if not segs:
        return []
    out: List[Tuple[int, int, int]] = []
    for s, e, l in segs:
        if not out:
            out.append((s, e, l))
            continue
        ps, pe, pl = out[-1]
        # if current is too short and close, merge into previous
        if (e - s + 1) < min_len and s - pe <= merge_gap:
            out[-1] = (ps, e, pl)
        else:
            out.append((s, e, l))
    return out


def split_long_segments(segs: List[Tuple[int, int, int]], max_len: int) -> List[Tuple[int, int, int]]:
    if max_len is None or max_len <= 0:
        return segs
    out: List[Tuple[int, int, int]] = []
    for s, e, l in segs:
        length = e - s + 1
        if length <= max_len:
            out.append((s, e, l))
            continue
        cur = s
        while cur <= e:
            nxt = min(e, cur + max_len - 1)
            out.append((cur, nxt, l))
            cur = nxt + 1
    return out


def _cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    an = a / (np.linalg.norm(a) + 1e-9)
    bn = b / (np.linalg.norm(b) + 1e-9)
    return float(1.0 - float(an @ bn))


def _energy(X: np.ndarray, j: int) -> float:
    if j <= 0:
        return 1e9
    return float(np.linalg.norm(X[j] - X[j - 1]))


def _jerk(X: np.ndarray, j: int) -> float:
    if j <= 0 or j >= len(X) - 1:
        return 1e9
    return float(np.linalg.norm(X[j + 1] - 2 * X[j] + X[j - 1]))


def _var_local(X: np.ndarray, j: int, win: int) -> float:
    n = len(X)
    lo = max(0, j - win)
    hi = min(n - 1, j + win)
    chunk = X[lo : hi + 1]
    # mean variance over dims
    v = np.var(chunk, axis=0)
    return float(np.mean(v))


def _angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """Return angle ABC in radians. If invalid, return np.nan."""
    try:
        ba = a - b
        bc = c - b
        nba = ba / (np.linalg.norm(ba) + 1e-9)
        nbc = bc / (np.linalg.norm(bc) + 1e-9)
        cosv = float(np.clip(nba @ nbc, -1.0, 1.0))
        return float(np.arccos(cosv))
    except Exception:
        return float('nan')


COCO17 = {
    'nose': 0,
    'left_eye': 1,
    'right_eye': 2,
    'left_ear': 3,
    'right_ear': 4,
    'left_shoulder': 5,
    'right_shoulder': 6,
    'left_elbow': 7,
    'right_elbow': 8,
    'left_wrist': 9,
    'right_wrist': 10,
    'left_hip': 11,
    'right_hip': 12,
    'left_knee': 13,
    'right_knee': 14,
    'left_ankle': 15,
    'right_ankle': 16,
}


def _rules_score_from_kpts(item: dict) -> float:
    """Compute a neutral-likeness score from one mid-frame kpts record.

    Lower is more neutral. Uses hardcoded COCO-17 indices.
    Expects item like { 'kpts': [[x,y,v]*17], 'w': int, 'h': int } with x,y normalized.
    """
    k = item.get('kpts')
    if not (isinstance(k, list) and len(k) >= 17 and isinstance(k[0], (list, tuple)) and len(k[0]) >= 2):
        return 1e9

    def get_xy(name: str):
        idx = COCO17[name]
        try:
            x, y = float(k[idx][0]), float(k[idx][1])
            v = float(k[idx][2]) if len(k[idx]) >= 3 else 1.0
            if not np.isfinite(x) or not np.isfinite(y) or v <= 0.0:
                return None
            return np.array([x, y], dtype=np.float32)
        except Exception:
            return None

    ls = get_xy('left_shoulder')
    rs = get_xy('right_shoulder')
    lh = get_xy('left_hip')
    rh = get_xy('right_hip')
    lw = get_xy('left_wrist')
    rw = get_xy('right_wrist')
    le = get_xy('left_elbow')
    re = get_xy('right_elbow')
    lk = get_xy('left_knee')
    rk = get_xy('right_knee')
    la = get_xy('left_ankle')
    ra = get_xy('right_ankle')
    nose = get_xy('nose')

    score = 0.0
    count = 0

    # Shoulder and hip horizontality (slope ~ 0)
    if ls is not None and rs is not None:
        shoulder_width = np.linalg.norm(rs - ls) + 1e-6
        slope_s = abs((rs[1] - ls[1]) / shoulder_width)
        score += 1.0 * slope_s
        count += 1
    if lh is not None and rh is not None:
        hip_width = np.linalg.norm(rh - lh) + 1e-6
        slope_h = abs((rh[1] - lh[1]) / hip_width)
        score += 1.0 * slope_h
        count += 1

    # Torso uprightness (vector hip-center -> shoulder-center vertical)
    if ls is not None and rs is not None and lh is not None and rh is not None:
        sc = (ls + rs) * 0.5
        hc = (lh + rh) * 0.5
        v = sc - hc
        vnorm = np.linalg.norm(v) + 1e-6
        cos_with_vertical = abs(v[1] / vnorm)  # vertical axis ~ y direction
        ang_from_vertical = float(np.arccos(np.clip(cos_with_vertical, 0.0, 1.0)))
        score += 2.0 * (ang_from_vertical / np.pi)
        count += 1

    # Wrist close to hips (arms down)
    if lw is not None and lh is not None:
        score += 0.5 * np.linalg.norm(lw - lh)
        count += 1
    if rw is not None and rh is not None:
        score += 0.5 * np.linalg.norm(rw - rh)
        count += 1

    # Symmetry around torso center using wrists
    if ls is not None and rs is not None and lw is not None and rw is not None:
        scx = float(((ls[0] + rs[0]) * 0.5))
        dev = abs((lw[0] - scx) + (rw[0] - scx))
        score += 1.0 * dev
        count += 1

    # Knee straightness (angles near pi)
    if lh is not None and lk is not None and la is not None:
        ang_l = _angle(lh, lk, la)
        if np.isfinite(ang_l):
            score += 0.5 * abs(np.pi - ang_l) / np.pi
            count += 1
    if rh is not None and rk is not None and ra is not None:
        ang_r = _angle(rh, rk, ra)
        if np.isfinite(ang_r):
            score += 0.5 * abs(np.pi - ang_r) / np.pi
            count += 1

    # Head centered over torso
    if nose is not None and ls is not None and rs is not None:
        scx = float(((ls[0] + rs[0]) * 0.5))
        score += 0.5 * abs(nose[0] - scx)
        count += 1

    if count == 0:
        return 1e9
    return float(score / count)


def split_long_segments_criterion(
    segs: List[Tuple[int, int, int]],
    max_len: int,
    X: np.ndarray,
    labels_arr: np.ndarray,
    criterion: str = "neutral",
    neutral_mode: str = "global",
    radius: int = 3,
    var_win: int = 3,
    previews: List[dict] = None,
) -> List[Tuple[int, int, int]]:
    if max_len is None or max_len <= 0:
        return segs

    # Prepare per-label prototypes if needed
    proto_per_label = {}
    if criterion in ("proto", "neutral") and neutral_mode == "label":
        for lab in np.unique(labels_arr):
            idx = np.where(labels_arr == lab)[0]
            if idx.size > 0:
                proto_per_label[int(lab)] = np.mean(X[idx], axis=0)

    neutral_global = np.mean(X, axis=0) if criterion == "neutral" else None

    out: List[Tuple[int, int, int]] = []
    for s, e, l in segs:
        length = e - s + 1
        if length <= max_len:
            out.append((s, e, l))
            continue

        cuts_needed = (length - 1) // max_len
        refined_cuts: List[int] = []
        for k in range(1, cuts_needed + 1):
            nominal = s + k * max_len
            lo = max(s + 1, nominal - radius)
            hi = min(e - 1, nominal + radius)

            best_j = lo
            best_score = 1e18

            for j in range(lo, hi + 1):
                if criterion == "neutral":
                    neutral_vec = (proto_per_label.get(int(l), neutral_global) if neutral_mode == "label" else neutral_global)
                    score = _cosine_distance(X[j], neutral_vec)
                elif criterion == "energy":
                    score = _energy(X, j)
                elif criterion == "jerk":
                    score = _jerk(X, j)
                elif criterion == "var":
                    score = _var_local(X, j, var_win)
                elif criterion == "proto":
                    # distance to label prototype (closer is better)
                    proto = proto_per_label.get(int(l))
                    if proto is None:
                        # fallback to global mean
                        proto = np.mean(X, axis=0)
                    score = float(np.linalg.norm(X[j] - proto))
                elif criterion == "rules":
                    if previews is None or j >= len(previews):
                        score = 1e9
                    else:
                        score = _rules_score_from_kpts(previews[j])
                else:
                    score = 0.0

                if score < best_score:
                    best_score = score
                    best_j = j

            refined_cuts.append(best_j)

        refined_cuts = sorted(set([j for j in refined_cuts if s < j < e]))
        prev = s
        for j in refined_cuts:
            out.append((prev, j - 1, l))
            prev = j
        out.append((prev, e, l))

    return out


def trim_segment_edges_criterion(
    segs: List[Tuple[int, int, int]],
    X: np.ndarray,
    labels_arr: np.ndarray,
    criterion: str = "neutral",
    neutral_mode: str = "global",
    radius: int = 3,
    var_win: int = 3,
    previews: List[dict] = None,
    min_len: int = 1,
) -> List[Tuple[int, int, int]]:
    if not segs:
        return []

    # Prepare per-label prototypes if needed
    proto_per_label = {}
    if criterion in ("proto", "neutral") and neutral_mode == "label":
        for lab in np.unique(labels_arr):
            idx = np.where(labels_arr == lab)[0]
            if idx.size > 0:
                proto_per_label[int(lab)] = np.mean(X[idx], axis=0)

    neutral_global = np.mean(X, axis=0) if criterion == "neutral" else None

    def score_at(j: int, lab: int) -> float:
        if criterion == "neutral":
            neutral_vec = (proto_per_label.get(int(lab), neutral_global) if neutral_mode == "label" else neutral_global)
            return _cosine_distance(X[j], neutral_vec)
        elif criterion == "energy":
            return _energy(X, j)
        elif criterion == "jerk":
            return _jerk(X, j)
        elif criterion == "var":
            return _var_local(X, j, var_win)
        elif criterion == "proto":
            proto = proto_per_label.get(int(lab))
            if proto is None:
                proto = np.mean(X, axis=0)
            return float(np.linalg.norm(X[j] - proto))
        elif criterion == "rules":
            if previews is None or j >= len(previews):
                return 1e9
            return _rules_score_from_kpts(previews[j])
        return 0.0

    out: List[Tuple[int, int, int]] = []
    changed_count = 0
    for s, e, l in segs:
        if e <= s:
            out.append((s, e, l))
            continue

        # Optimize start within [s, min(e-1, s+radius)]
        lo_s = s
        hi_s = min(e - 1, s + max(1, radius))
        best_js = lo_s
        best_ss = 1e18
        for j in range(lo_s, hi_s + 1):
            sc = score_at(j, l)
            if sc < best_ss:
                best_ss = sc
                best_js = j

        s2 = best_js

        # Optimize end within [max(s2+1, e-radius), e]
        lo_e = max(s2 + 1, e - max(1, radius))
        hi_e = e
        best_je = hi_e
        best_se = 1e18
        for j in range(lo_e, hi_e + 1):
            sc = score_at(j, l)
            if sc < best_se:
                best_se = sc
                best_je = j

        e2 = best_je

        if (e2 - s2 + 1) >= max(1, min_len):
            if s2 != s or e2 != e:
                changed_count += 1
                try:
                    print(f"[trim] seg {s}-{e} (lab {int(l)}) -> {s2}-{e2} (dStart={s2 - s}, dEnd={e2 - e}) startScore={best_ss:.6f} endScore={best_se:.6f}")
                except Exception:
                    pass
            out.append((s2, e2, l))
        else:
            # fallback without trimming if too short
            out.append((s, e, l))

    try:
        print(f"[trim] changed {changed_count}/{len(segs)} segments (radius={radius}, criterion={criterion})")
    except Exception:
        pass
    return out


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)

    E = np.load(args.embeddings)
    X = E
    if args.pca and args.pca > 0:
        X = PCA(n_components=args.pca).fit_transform(E)

    if args.algo == "kmeans":
        km = KMeans(n_clusters=args.k, n_init='auto')
        labels = km.fit_predict(X)
    else:
        try:
            import hdbscan  # type: ignore
        except Exception:
            raise RuntimeError("hdbscan is not installed. Try: pip install hdbscan")
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=args.hdb_min_cluster,
            min_samples=args.hdb_min_samples
        )
        labels = clusterer.fit_predict(X)
    print(f"labels: {labels}")

    segs = label_runs(labels)
    segs = merge_short_segments(segs, min_len=args.min_len, merge_gap=args.merge_gap)

    # Determine splitting criterion (backward compatibility)
    criterion = args.split_criterion

    previews = None
    if criterion in ("neutral", "energy", "var", "jerk", "proto", "rules"):
        if criterion == "rules":
            try:
                with open(args.windows_preview, 'r') as f:
                    previews = json.load(f)
            except Exception as e:
                print(f"[warn] failed to load windows_preview: {e}")
        segs = split_long_segments_criterion(
            segs,
            max_len=args.max_len_windows,
            X=X,
            labels_arr=labels,
            criterion=criterion,
            neutral_mode=args.neutral_mode,
            radius=args.neutral_radius,
            var_win=args.var_win,
            previews=previews,
        )
    else:
        segs = split_long_segments(segs, max_len=args.max_len_windows)

    # Optional: trim segment edges toward neutral according to the same criterion
    if args.trim_edges:
        segs = trim_segment_edges_criterion(
            segs=segs,
            X=X,
            labels_arr=labels,
            criterion=criterion,
            neutral_mode=args.neutral_mode,
            radius=args.edge_radius,
            var_win=args.var_win,
            previews=previews,
            min_len=args.min_len,
        )

    payload = {
        'num_windows': int(len(labels)),
        'window': int(args.window),
        'stride': int(args.stride),
        'algo': args.algo,
        'segments': [
            {'start': int(s), 'end': int(e), 'label': int(l)} for (s, e, l) in segs
        ],
        'labels': labels.tolist(),
    }
    with open(args.out, 'w') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Saved segments: {args.out}")


if __name__ == '__main__':
    main()


