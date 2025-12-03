import argparse
import os
import json
import numpy as np
import torch
from torch.utils.data import DataLoader

from window_dataset import PoseWindowDataset
from models.temporal_encoder import TemporalEncoder


def parse_args():
    p = argparse.ArgumentParser(description="Extract embeddings from trained encoder")
    p.add_argument("--data_glob", type=str, default="dataset/raw/*.jsonl")
    p.add_argument("--ckpt", type=str, required=True)
    p.add_argument("--window", type=int, default=32)
    p.add_argument("--stride", type=int, default=8)
    p.add_argument("--batch_size", type=int, default=256)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--device", type=str, default="cuda" if torch.cuda.is_available() else "cpu")
    p.add_argument("--out", type=str, default="runs/embeddings.npy")
    p.add_argument("--preview_json", type=str, default="runs/windows_preview.json")
    p.add_argument("--windows_index_json", type=str, default="runs/windows_index.json")
    return p.parse_args()


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)

    ds = PoseWindowDataset(paths=[args.data_glob], window_size=args.window, stride=args.stride, simclr=False)
    dl = DataLoader(ds, batch_size=args.batch_size, shuffle=False, num_workers=args.workers, pin_memory=True)

    device = args.device
    # load checkpoint and build encoder
    ckpt = torch.load(args.ckpt, map_location='cpu')
    enc = TemporalEncoder(in_channels=3, num_joints=17, hidden_dim=128, emb_dim=128)
    state = ckpt.get('model', ckpt)
    # if checkpoint is MotionEncoder, extract encoder.* keys
    new_state = {}
    for k, v in state.items():
        if k.startswith('encoder.'):
            new_state[k[len('encoder.'):]] = v
        elif k.startswith('module.encoder.'):
            new_state[k[len('module.encoder.'):]] = v
        elif k in enc.state_dict():
            new_state[k] = v
    enc.load_state_dict(new_state, strict=False)
    enc.to(device)
    enc.eval()

    embs = []
    with torch.no_grad():
        for x in dl:
            x = x.to(device, non_blocking=True)
            e = enc(x).float().cpu().numpy()
            embs.append(e)
    embs = np.concatenate(embs, axis=0)
    np.save(args.out, embs)
    print(f"Saved embeddings: {embs.shape} -> {args.out}")

    # Build preview JSON aligned to dataset indices: mid-frame per window
    try:
        previews = []
        mid_off = args.window // 2
        for (si, s) in ds._index:  # type: ignore[attr-defined]
            seq = ds._seqs[si]
            mi = min(len(seq) - 1, s + mid_off)
            item = seq[mi]
            k = item.get('kpts') or item.get('keypoints')
            w = int(item.get('width', 0))
            h = int(item.get('height', 0))
            if not (isinstance(k, list) and len(k) >= 17):
                k = [[0.0, 0.0, 0.0] for _ in range(17)]
            else:
                k = (k + [[0.0, 0.0, 0.0]] * 17)[:17]
            previews.append({ 'w': w, 'h': h, 'kpts': k })
        os.makedirs(os.path.dirname(args.preview_json) or '.', exist_ok=True)
        with open(args.preview_json, 'w') as f:
            json.dump(previews, f)
        print(f"Saved previews: {len(previews)} -> {args.preview_json}")
    except Exception as e:
        print(f"[warn] preview build failed: {e}")

    # Build windows_index mapping windows -> (file basename, start frame)
    try:
        files = getattr(ds, 'files', None)
        if isinstance(files, list) and len(files) > 0:
            files_base = [os.path.basename(f) for f in files]
            mapping = {
                'window': int(args.window),
                'stride': int(args.stride),
                'files': files_base,
                'windows': []
            }
            for (si, s) in ds._index:  # type: ignore[attr-defined]
                mapping['windows'].append({
                    'file_index': int(si),
                    'file': files_base[si] if si < len(files_base) else str(si),
                    'start': int(s)
                })
            outp = args.windows_index_json
            os.makedirs(os.path.dirname(outp) or '.', exist_ok=True)
            with open(outp, 'w') as f:
                json.dump(mapping, f)
            print(f"Saved windows index: {len(mapping['windows'])} -> {outp}")
    except Exception as e:
        print(f"[warn] windows index build failed: {e}")


if __name__ == "__main__":
    main()


