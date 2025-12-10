"""
새로 녹화한 jsonl 파일을 기존 클러스터에 추가하는 스크립트

사용법:
    python add_to_cluster.py \
        --existing_embeddings runs/embeddings.npy \
        --existing_windows_index runs/simclr/windows_index.json \
        --new_jsonl training/dataset/raw/new_recording.jsonl \
        --ckpt runs/simclr/best.pt \
        --window 32 --stride 8 \
        --out_embeddings runs/embeddings_updated.npy \
        --out_windows_index runs/simclr/windows_index_updated.json
"""

import argparse
import os
import json
import numpy as np
import torch
from torch.utils.data import DataLoader

from window_dataset import PoseWindowDataset
from models.temporal_encoder import TemporalEncoder


def parse_args():
    p = argparse.ArgumentParser(description="Add new jsonl recordings to existing cluster")
    p.add_argument("--existing_embeddings", type=str, required=True, help="Path to existing embeddings.npy")
    p.add_argument("--existing_windows_index", type=str, required=True, help="Path to existing windows_index.json")
    p.add_argument("--new_jsonl", type=str, required=True, help="Path to new jsonl file(s) - can use glob pattern")
    p.add_argument("--ckpt", type=str, required=True, help="Path to model checkpoint")
    p.add_argument("--window", type=int, default=32)
    p.add_argument("--stride", type=int, default=8)
    p.add_argument("--batch_size", type=int, default=256)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--device", type=str, default="cuda" if torch.cuda.is_available() else "cpu")
    p.add_argument("--out_embeddings", type=str, default="runs/embeddings_updated.npy", help="Output path for combined embeddings")
    p.add_argument("--out_windows_index", type=str, default="runs/simclr/windows_index_updated.json", help="Output path for updated windows index")
    p.add_argument("--out_preview_json", type=str, default="runs/windows_preview_updated.json", help="Output path for updated preview JSON")
    return p.parse_args()


def main():
    args = parse_args()
    
    # 1. Load existing embeddings and windows index
    print(f"Loading existing embeddings from {args.existing_embeddings}")
    existing_embs = np.load(args.existing_embeddings)
    print(f"Existing embeddings shape: {existing_embs.shape}")
    
    print(f"Loading existing windows index from {args.existing_windows_index}")
    with open(args.existing_windows_index, 'r') as f:
        existing_windows = json.load(f)
    print(f"Existing windows: {existing_windows.get('num_windows', len(existing_windows.get('windows', [])))}")
    
    # 2. Extract embeddings from new jsonl file(s)
    print(f"\nExtracting embeddings from new data: {args.new_jsonl}")
    ds = PoseWindowDataset(paths=[args.new_jsonl], window_size=args.window, stride=args.stride, simclr=False)
    dl = DataLoader(ds, batch_size=args.batch_size, shuffle=False, num_workers=args.workers, pin_memory=True)
    
    device = args.device
    # Load checkpoint and build encoder
    ckpt = torch.load(args.ckpt, map_location='cpu')
    enc = TemporalEncoder(in_channels=3, num_joints=17, hidden_dim=128, emb_dim=128)
    state = ckpt.get('model', ckpt)
    # Extract encoder.* keys
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
    
    new_embs = []
    with torch.no_grad():
        for x in dl:
            x = x.to(device, non_blocking=True)
            e = enc(x).float().cpu().numpy()
            new_embs.append(e)
    new_embs = np.concatenate(new_embs, axis=0)
    print(f"New embeddings shape: {new_embs.shape}")
    
    # 3. Combine embeddings
    print("\nCombining embeddings...")
    combined_embs = np.concatenate([existing_embs, new_embs], axis=0)
    print(f"Combined embeddings shape: {combined_embs.shape}")
    
    # Save combined embeddings
    os.makedirs(os.path.dirname(args.out_embeddings) or '.', exist_ok=True)
    np.save(args.out_embeddings, combined_embs)
    print(f"Saved combined embeddings to {args.out_embeddings}")
    
    # 4. Update windows index
    print("\nUpdating windows index...")
    files = getattr(ds, 'files', None)
    if isinstance(files, list) and len(files) > 0:
        files_base = [os.path.basename(f) for f in files]
        existing_files = existing_windows.get('files', [])
        
        # Add new files to the files list
        updated_files = existing_files + files_base
        
        # Get starting window index for new data
        existing_num_windows = len(existing_windows.get('windows', []))
        
        # Build windows for new data
        new_windows = []
        for (si, s) in ds._index:  # type: ignore[attr-defined]
            # Calculate file index in combined files list
            file_index = len(existing_files) + si
            new_windows.append({
                'file_index': int(file_index),
                'file': files_base[si] if si < len(files_base) else str(si),
                'start': int(s)
            })
        
        # Combine windows
        updated_windows = {
            'window': int(args.window),
            'stride': int(args.stride),
            'files': updated_files,
            'windows': existing_windows.get('windows', []) + new_windows
        }
        
        updated_windows['num_windows'] = len(updated_windows['windows'])
        
        # Save updated windows index
        os.makedirs(os.path.dirname(args.out_windows_index) or '.', exist_ok=True)
        with open(args.out_windows_index, 'w') as f:
            json.dump(updated_windows, f, indent=2)
        print(f"Saved updated windows index to {args.out_windows_index}")
        print(f"Total windows: {updated_windows['num_windows']} (existing: {existing_num_windows}, new: {len(new_windows)})")
    
    # 5. Build preview JSON for new data (optional, for visualization)
    try:
        print("\nBuilding preview JSON...")
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
            previews.append({'w': w, 'h': h, 'kpts': k})
        
        # Load existing previews if available
        existing_preview_path = args.existing_windows_index.replace('windows_index.json', 'windows_preview.json')
        combined_previews = []
        if os.path.exists(existing_preview_path):
            with open(existing_preview_path, 'r') as f:
                existing_previews = json.load(f)
                combined_previews = existing_previews + previews
        else:
            combined_previews = previews
        
        os.makedirs(os.path.dirname(args.out_preview_json) or '.', exist_ok=True)
        with open(args.out_preview_json, 'w') as f:
            json.dump(combined_previews, f)
        print(f"Saved preview JSON to {args.out_preview_json}")
    except Exception as e:
        print(f"[warn] Preview build failed: {e}")
    
    print("\n✅ Successfully added new data to cluster!")
    print(f"\nNext steps:")
    print(f"1. Re-cluster with combined embeddings:")
    print(f"   python cluster_and_segment.py --embeddings {args.out_embeddings} --out runs/segments_updated.json --window {args.window} --stride {args.stride}")
    print(f"2. Use updated windows index: {args.out_windows_index}")


if __name__ == "__main__":
    main()

