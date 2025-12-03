import argparse
import os
import numpy as np


def parse_args():
    p = argparse.ArgumentParser(description="Visualize embeddings with UMAP/TSNE")
    p.add_argument("--embeddings", type=str, required=True)
    p.add_argument("--method", type=str, default="umap", choices=["umap", "tsne"])
    p.add_argument("--perplexity", type=float, default=30.0)
    p.add_argument("--out", type=str, default="runs/embeddings_2d.npy")
    return p.parse_args()


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    X = np.load(args.embeddings)
    if args.method == 'umap':
        try:
            import umap  # type: ignore
        except Exception:
            raise RuntimeError("umap-learn is not installed. Try: pip install umap-learn")
        reducer = umap.UMAP(n_components=2, n_neighbors=15, min_dist=0.1, metric='euclidean')
        Y = reducer.fit_transform(X)
    else:
        from sklearn.manifold import TSNE
        Y = TSNE(n_components=2, perplexity=args.perplexity, init='pca', learning_rate='auto').fit_transform(X)
    np.save(args.out, Y)
    print(f"Saved 2D embedding: {Y.shape} -> {args.out}")


if __name__ == '__main__':
    main()


