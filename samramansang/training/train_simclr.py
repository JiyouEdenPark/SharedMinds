import argparse
import math
import os
import time
from typing import Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader

from window_dataset import PoseWindowDataset
from models.temporal_encoder import MotionEncoder


def parse_args():
    p = argparse.ArgumentParser(description="SimCLR (InfoNCE) training for pose windows")
    p.add_argument("--data_glob", type=str, default="dataset/raw/*.jsonl")
    p.add_argument("--window", type=int, default=32)
    p.add_argument("--stride", type=int, default=8)
    p.add_argument("--batch_size", type=int, default=128)
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight_decay", type=float, default=1e-4)
    p.add_argument("--temperature", type=float, default=0.1)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--device", type=str, default="cuda" if torch.cuda.is_available() else "cpu")
    p.add_argument("--save_dir", type=str, default="runs/simclr")
    p.add_argument("--amp", action="store_true")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def set_seed(seed: int):
    import random
    import numpy as np
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = False
    torch.backends.cudnn.benchmark = True


def build_loader(glob_path: str, window: int, stride: int, workers: int, batch_size: int) -> DataLoader:
    ds = PoseWindowDataset(paths=[glob_path], window_size=window, stride=stride, simclr=True)
    dl = DataLoader(ds, batch_size=batch_size, shuffle=True, num_workers=workers, pin_memory=True, drop_last=True)
    return dl


def info_nce_loss(z1: torch.Tensor, z2: torch.Tensor, temperature: float = 0.1) -> torch.Tensor:
    """
    NT-Xent loss over 2N samples.
    z1, z2: (N, D) L2-normalized embeddings (projection head output)
    """
    z1 = F.normalize(z1, dim=-1)
    z2 = F.normalize(z2, dim=-1)
    N = z1.size(0)
    z = torch.cat([z1, z2], dim=0)  # (2N, D)
    sim = torch.matmul(z, z.t()) / temperature  # (2N, 2N)

    # mask self-similarity
    mask = torch.eye(2 * N, device=z.device, dtype=torch.bool)
    sim = sim.masked_fill(mask, float('-inf'))

    # positives for each anchor
    targets = torch.cat([torch.arange(N, 2 * N), torch.arange(0, N)], dim=0).to(z.device)
    loss = F.cross_entropy(sim, targets)
    return loss


def train_one_epoch(model: MotionEncoder, loader: DataLoader, opt: torch.optim.Optimizer, scaler, device: str, temperature: float) -> Tuple[float, float]:
    model.train()
    loss_meter = 0.0
    n = 0
    t0 = time.time()
    for (x1, x2) in loader:
        x1 = x1.to(device, non_blocking=True)
        x2 = x2.to(device, non_blocking=True)
        opt.zero_grad(set_to_none=True)
        if scaler is not None:
            with torch.amp.autocast(device_type='cuda'):
                _, z1 = model(x1)
                _, z2 = model(x2)
                loss = info_nce_loss(z1, z2, temperature)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
        else:
            _, z1 = model(x1)
            _, z2 = model(x2)
            loss = info_nce_loss(z1, z2, temperature)
            loss.backward()
            opt.step()
        bs = x1.size(0)
        loss_meter += loss.item() * bs
        n += bs
    dt = time.time() - t0
    return loss_meter / max(1, n), dt


def main():
    args = parse_args()
    set_seed(args.seed)
    os.makedirs(args.save_dir, exist_ok=True)

    device = args.device
    loader = build_loader(args.data_glob, args.window, args.stride, args.workers, args.batch_size)

    model = MotionEncoder(in_channels=3, num_joints=17, hidden_dim=128, emb_dim=128, proj_hidden=256, proj_out=128)
    model.to(device)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    # Cosine decay without restarts
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    scaler = torch.amp.GradScaler(device='cuda', enabled=args.amp)

    best_loss = float('inf')
    for epoch in range(1, args.epochs + 1):
        train_loss, epoch_time = train_one_epoch(model, loader, opt, scaler, device, args.temperature)
        scheduler.step()
        lr = scheduler.get_last_lr()[0]
        print(f"[Ep {epoch:03d}] loss={train_loss:.4f} lr={lr:.6f} time={epoch_time:.1f}s")

        # save last and best
        ckpt = {
            'epoch': epoch,
            'model': model.state_dict(),
            'opt': opt.state_dict(),
            'args': vars(args),
        }
        torch.save(ckpt, os.path.join(args.save_dir, 'last.pt'))
        if train_loss < best_loss:
            best_loss = train_loss
            torch.save(ckpt, os.path.join(args.save_dir, 'best.pt'))

    print("Done.")


if __name__ == "__main__":
    main()


