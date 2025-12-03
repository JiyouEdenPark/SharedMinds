import os
import glob
import json
from typing import List, Tuple, Dict, Any, Optional

import numpy as np

try:
    import torch
    from torch.utils.data import Dataset
except Exception:
    torch = None
    Dataset = object
try:
    import pyarrow as pa  # type: ignore
    import pyarrow.parquet as pq  # type: ignore
except Exception:
    pa = None
    pq = None


COCO_LEFT_RIGHT_MAP = {
    5: 6,   # L_SHO <-> R_SHO
    6: 5,
    7: 8,   # L_ELB <-> R_ELB
    8: 7,
    9: 10,  # L_WR  <-> R_WR
    10: 9,
    11: 12, # L_HIP <-> R_HIP
    12: 11,
    13: 14, # L_KNE <-> R_KNE
    14: 13,
    15: 16, # L_ANK <-> R_ANK
    16: 15,
}


def read_jsonl(path: str) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    with open(path, 'r') as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                obj = json.loads(s)
                if isinstance(obj, dict) and ('kpts' in obj or 'keypoints' in obj):
                    if 'kpts' not in obj and 'keypoints' in obj:
                        obj['kpts'] = obj['keypoints']
                    items.append(obj)
            except Exception:
                continue
    return items


def read_parquet(path: str) -> List[Dict[str, Any]]:
    if pq is None:
        raise RuntimeError('pyarrow is required to read parquet. Install with: pip install pyarrow')
    table = pq.read_table(path)
    cols = {name: table[name].to_pylist() for name in table.column_names}
    n = len(next(iter(cols.values()))) if cols else 0
    out: List[Dict[str, Any]] = []
    for i in range(n):
        obj: Dict[str, Any] = {}
        # copy known fields if present
        for key in ('ts','width','height','seq_id','frame_id','fps'):
            if key in cols:
                obj[key] = cols[key][i]
        if 'kpts' in cols:
            obj['kpts'] = cols['kpts'][i]
        elif 'keypoints' in cols:
            obj['kpts'] = cols['keypoints'][i]
        out.append(obj)
    return out


def read_any(path: str) -> List[Dict[str, Any]]:
    if path.lower().endswith('.parquet'):
        return read_parquet(path)
    return read_jsonl(path)


def to_numpy_window(seq: List[Dict[str, Any]], start: int, T: int) -> np.ndarray:
    window = seq[start:start+T]
    kseq = []
    for it in window:
        k = it.get('kpts', [])
        if not isinstance(k, list) or len(k) < 17:
            k = [[0.0, 0.0, 0.0] for _ in range(17)]
        k = (k + [[0.0, 0.0, 0.0]] * 17)[:17]
        kseq.append(k)
    arr = np.asarray(kseq, dtype=np.float32)  # (T, 17, 3), normalized [0,1] expected
    return arr


def validity_ok(arr: np.ndarray, min_visible_per_frame: int = 10, conf_thr: float = 0.2) -> bool:
    # arr: (T, 17, 3)
    scores = arr[..., 2]
    vis = (scores >= conf_thr).astype(np.int32)
    # at least some threshold per frame on average
    return int(vis.sum()) >= (min_visible_per_frame * max(1, arr.shape[0]))


def center_and_scale(arr: np.ndarray, eps: float = 1e-6) -> np.ndarray:
    out = arr.copy()
    xy = out[..., :2]
    scores = out[..., 2:3]
    weight = (scores >= 0.2).astype(np.float32)
    wsum = weight.sum(axis=(1, 2), keepdims=True) + eps
    mean_xy = (xy * weight).sum(axis=(1, 2), keepdims=True) / wsum
    xy = xy - mean_xy
    # scale by median shoulder width across frames
    L_SHO, R_SHO = 5, 6
    shoulder = xy[:, [L_SHO, R_SHO], :]
    shoulder_w = np.linalg.norm(shoulder[:, 0, :] - shoulder[:, 1, :], axis=-1)
    scale = np.median(shoulder_w[shoulder_w > 0]) if np.any(shoulder_w > 0) else np.std(xy.reshape(xy.shape[0], -1), axis=1).mean()
    if not np.isfinite(scale) or scale < eps:
        scale = 1.0
    xy = xy / float(scale)
    out[..., 0:2] = xy
    return out


def augment_window(arr: np.ndarray,
                   jitter_std: float = 0.01,
                   scale_std: float = 0.05,
                   rot_deg_std: float = 5.0,
                   time_mask_prob: float = 0.3,
                   flip_prob: float = 0.5) -> np.ndarray:
    """
    SimCLR-style light augmentations for pose windows.
    arr: (T, 17, 3) after center_and_scale
    returns augmented array with same shape
    """
    x = arr.copy()
    T = x.shape[0]

    # 1) Gaussian jitter on (x,y)
    if jitter_std > 0:
        x[..., :2] += np.random.normal(scale=jitter_std, size=x[..., :2].shape).astype(np.float32)

    # 2) Random global scale
    if scale_std > 0:
        s = float(np.exp(np.random.normal(scale=scale_std)))
        x[..., :2] *= s

    # 3) Small rotation around origin (since centered)
    if rot_deg_std > 0:
        theta = float(np.random.normal(scale=rot_deg_std)) * (np.pi / 180.0)
        c, sn = np.cos(theta), np.sin(theta)
        R = np.array([[c, -sn], [sn, c]], dtype=np.float32)
        xy = x[..., :2].reshape(T * 17, 2) @ R.T
        x[..., :2] = xy.reshape(T, 17, 2)

    # 4) Temporal masking (drop confidence on a short segment)
    if T >= 8 and np.random.rand() < time_mask_prob:
        t0 = np.random.randint(0, max(1, T // 2))
        t1 = min(T, t0 + np.random.randint(1, max(2, T // 3)))
        x[t0:t1, :, 2] *= 0.0

    # 5) Horizontal flip with L/R swap
    if np.random.rand() < flip_prob:
        x[..., 0] *= -1.0
        # swap left/right joints once
        for l, r in list(COCO_LEFT_RIGHT_MAP.items()):
            if l < r:
                tmp = x[:, l, :].copy()
                x[:, l, :] = x[:, r, :]
                x[:, r, :] = tmp

    return x


def make_windows(
    paths: List[str],
    T: int = 32,
    stride: int = 8,
    min_visible_per_frame: int = 10,
    conf_thr: float = 0.2,
) -> List[np.ndarray]:
    files: List[str] = []
    for p in paths:
        files.extend(glob.glob(p) if any(ch in p for ch in '*?[') else [p])
    files = [f for f in files if os.path.isfile(f)]
    out: List[np.ndarray] = []
    for f in files:
        seq = read_jsonl(f)
        if not seq:
            continue
        N = len(seq)
        for s in range(0, max(1, N - T + 1), stride):
            arr = to_numpy_window(seq, s, T)
            if validity_ok(arr, min_visible_per_frame, conf_thr):
                out.append(center_and_scale(arr))
    return out


class PoseWindowDataset(Dataset):
    def __init__(
        self,
        paths: List[str],
        window_size: int = 32,
        stride: int = 8,
        min_visible: int = 10,
        conf_thr: float = 0.2,
        simclr: bool = False,
        aug_cfg: Optional[Dict[str, float]] = None,
    ):
        if torch is None:
            raise RuntimeError('PyTorch is required for PoseWindowDataset')
        self.window_size = int(window_size)
        self.stride = int(stride)
        self.min_visible = int(min_visible)
        self.conf_thr = float(conf_thr)
        self.simclr = bool(simclr)
        self.aug_cfg = aug_cfg or {}

        files: List[str] = []
        for p in paths:
            files.extend(glob.glob(p) if any(ch in p for ch in '*?[') else [p])
        self.files = [f for f in files if os.path.isfile(f)]
        if not self.files:
            raise FileNotFoundError('No JSONL files matched')

        self._seqs: List[List[Dict[str, Any]]] = []
        self._index: List[Tuple[int, int]] = []
        for si, f in enumerate(self.files):
            seq = read_any(f)
            if not seq:
                continue
            self._seqs.append(seq)
            T = self.window_size
            for s in range(0, max(1, len(seq) - T + 1), self.stride):
                arr = to_numpy_window(seq, s, T)
                if validity_ok(arr, self.min_visible, self.conf_thr):
                    self._index.append((si, s))
        if not self._index:
            raise RuntimeError('No valid windows after filtering')

    def __len__(self) -> int:
        return len(self._index)

    def __getitem__(self, i: int):
        si, s = self._index[i]
        seq = self._seqs[si]
        arr = to_numpy_window(seq, s, self.window_size)
        arr = center_and_scale(arr)
        if self.simclr:
            a = augment_window(arr,
                               jitter_std=self.aug_cfg.get('jitter_std', 0.01),
                               scale_std=self.aug_cfg.get('scale_std', 0.05),
                               rot_deg_std=self.aug_cfg.get('rot_deg_std', 5.0),
                               time_mask_prob=self.aug_cfg.get('time_mask_prob', 0.3),
                               flip_prob=self.aug_cfg.get('flip_prob', 0.5))
            b = augment_window(arr,
                               jitter_std=self.aug_cfg.get('jitter_std', 0.01),
                               scale_std=self.aug_cfg.get('scale_std', 0.05),
                               rot_deg_std=self.aug_cfg.get('rot_deg_std', 5.0),
                               time_mask_prob=self.aug_cfg.get('time_mask_prob', 0.3),
                               flip_prob=self.aug_cfg.get('flip_prob', 0.5))
            x1 = torch.from_numpy(a).permute(2, 1, 0).contiguous()
            x2 = torch.from_numpy(b).permute(2, 1, 0).contiguous()
            return x1, x2
        else:
            x = torch.from_numpy(arr).permute(2, 1, 0).contiguous()  # (C=3, J=17, T)
            return x


