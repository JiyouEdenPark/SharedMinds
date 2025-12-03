import argparse
import os
import sys
import subprocess


def parse_args():
    p = argparse.ArgumentParser(description="End-to-end: train → extract → cluster")
    # common
    p.add_argument("--data_glob", type=str, default="dataset/raw/*.jsonl")
    p.add_argument("--window", type=int, default=32)
    p.add_argument("--stride", type=int, default=8)
    p.add_argument("--device", type=str, default="cuda")

    # train
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--batch_size", type=int, default=128)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight_decay", type=float, default=1e-4)
    p.add_argument("--temperature", type=float, default=0.1)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--amp", action="store_true")
    p.add_argument("--save_dir", type=str, default="runs/simclr")

    # extract
    p.add_argument("--emb_out", type=str, default="runs/embeddings.npy")
    p.add_argument("--emb_2d_out", type=str, default="runs/embeddings_2d.npy")
    p.add_argument("--viz_method", type=str, default="umap", choices=["umap", "tsne"])
    p.add_argument("--perplexity", type=float, default=30.0)

    # cluster
    p.add_argument("--algo", type=str, default="hdbscan", choices=["kmeans", "hdbscan"])
    p.add_argument("--k", type=int, default=8)
    p.add_argument("--pca", type=int, default=0)
    p.add_argument("--min_len", type=int, default=5)
    p.add_argument("--merge_gap", type=int, default=2)
    p.add_argument("--hdb_min_cluster", type=int, default=5)
    p.add_argument("--hdb_min_samples", type=int, default=3)
    p.add_argument("--split_criterion", type=str, default="rules", choices=["neutral", "energy", "var", "jerk", "proto", "rules"])
    p.add_argument("--neutral_mode", type=str, default="global", choices=["global", "label"])
    p.add_argument("--neutral_radius", type=int, default=3)
    p.add_argument("--var_win", type=int, default=3)
    p.add_argument("--max_len_windows", type=int, default=10)
    # edge trimming
    p.add_argument("--trim_edges", action="store_true")
    p.add_argument("--edge_radius", type=int, default=3)
    p.add_argument("--segments_out", type=str, default="runs/segments.json")
    # representatives
    p.add_argument("--rep_method", type=str, default="per_label_k", choices=["per_label_k", "threshold"])
    p.add_argument("--rep_k", type=int, default=5)
    p.add_argument("--rep_thr", type=float, default=0.25)
    p.add_argument("--rep_out", type=str, default="runs/segments_representative.json")
    # reduced parquet
    p.add_argument("--files_glob", type=str, default="dataset/raw/*.jsonl")
    p.add_argument("--reduced_parquet_out", type=str, default="runs/segments_representative.parquet")
    return p.parse_args()


def main():
    args = parse_args()
    os.makedirs(args.save_dir, exist_ok=True)

    # 1) Train SimCLR
    train_cmd = [
        sys.executable, "-u", "train_simclr.py",
        "--data_glob", args.data_glob,
        "--window", str(args.window),
        "--stride", str(args.stride),
        "--batch_size", str(args.batch_size),
        "--epochs", str(args.epochs),
        "--lr", str(args.lr),
        "--weight_decay", str(args.weight_decay),
        "--temperature", str(args.temperature),
        "--workers", str(args.workers),
        "--device", args.device,
        "--save_dir", args.save_dir,
    ]
    if args.amp:
        train_cmd.append("--amp")
    print("[RUN] ", " ".join(train_cmd))
    subprocess.run(train_cmd, check=True)

    ckpt = os.path.join(args.save_dir, "best.pt")

    # 2) Extract embeddings
    extract_cmd = [
        sys.executable, "-u", "extract_embeddings.py",
        "--data_glob", args.data_glob,
        "--ckpt", ckpt,
        "--window", str(args.window),
        "--stride", str(args.stride),
        "--batch_size", str(max(1, args.batch_size * 2)),
        "--workers", str(args.workers),
        "--device", args.device,
        "--out", args.emb_out,
        "--preview_json", os.path.join(args.save_dir, 'windows_preview.json'),
        "--windows_index_json", os.path.join(args.save_dir, 'windows_index.json'),
    ]
    print("[RUN] ", " ".join(extract_cmd))
    subprocess.run(extract_cmd, check=True)

    # 3) Visualize embeddings (2D)
    viz_cmd = [
        sys.executable, "-u", "viz_embeddings.py",
        "--embeddings", args.emb_out,
        "--method", args.viz_method,
        "--perplexity", str(args.perplexity),
        "--out", args.emb_2d_out,
    ]
    print("[RUN] ", " ".join(viz_cmd))
    subprocess.run(viz_cmd, check=True)

    # 4) Cluster and segment
    cluster_cmd = [
        sys.executable, "-u", "cluster_and_segment.py",
        "--embeddings", args.emb_out,
        "--out", args.segments_out,
        "--algo", args.algo,
        "--k", str(args.k),
        "--pca", str(args.pca),
        "--min_len", str(args.min_len),
        "--merge_gap", str(args.merge_gap),
        "--window", str(args.window),
        "--stride", str(args.stride),
        "--max_len_windows", str(args.max_len_windows),
        "--split_criterion", args.split_criterion,
        "--neutral_mode", args.neutral_mode,
        "--neutral_radius", str(args.neutral_radius),
        "--var_win", str(args.var_win),
    ]
    if args.trim_edges:
        cluster_cmd += ["--trim_edges", "--edge_radius", str(args.edge_radius)]
    if args.algo == "hdbscan":
        cluster_cmd += ["--hdb_min_cluster", str(args.hdb_min_cluster)]
        cluster_cmd += ["--hdb_min_samples", str(args.hdb_min_samples)]
    # If rules criterion, wire preview path from extract step
    if args.split_criterion == "rules":
        cluster_cmd += ["--windows_preview", os.path.join(args.save_dir, 'windows_preview.json')]
    print("[RUN] ", " ".join(cluster_cmd))
    subprocess.run(cluster_cmd, check=True)

    # 5) Select representative segments
    reps_cmd = [
        sys.executable, "-u", "select_representatives.py",
        "--embeddings", args.emb_out,
        "--segments", args.segments_out,
        "--method", args.rep_method,
        "--per_label_k", str(args.rep_k),
        "--threshold", str(args.rep_thr),
        "--windows_index", os.path.join(args.save_dir, 'windows_index.json'),
        "--files_glob", args.data_glob,
        "--scale_exclude_thr", "1.4",
        "--out", args.rep_out,
    ]
    print("[RUN] ", " ".join(reps_cmd))
    subprocess.run(reps_cmd, check=True)

    # 6) Export reduced parquet for representatives
    win_index = os.path.join(args.save_dir, 'windows_index.json')
    export_cmd = [
        sys.executable, "-u", "export_representative_parquet.py",
        "--windows_index_json", win_index,
        "--segments", args.rep_out,
        "--files_glob", args.files_glob,
        "--out", args.reduced_parquet_out,
    ]
    print("[RUN] ", " ".join(export_cmd))
    subprocess.run(export_cmd, check=True)

    print("Pipeline done.")


if __name__ == "__main__":
    main()


