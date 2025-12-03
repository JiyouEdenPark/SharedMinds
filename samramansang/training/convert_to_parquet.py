import argparse
import glob
import json
import os


def parse_args():
    p = argparse.ArgumentParser(description='Convert JSONL pose files to a single Parquet')
    p.add_argument('--glob', type=str, default='dataset/raw/*.jsonl')
    p.add_argument('--out', type=str, default='dataset/pose.parquet')
    return p.parse_args()


def read_jsonl(path):
    with open(path, 'r') as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                obj = json.loads(s)
                yield obj
            except Exception:
                continue


def main():
    args = parse_args()
    try:
        import pyarrow as pa  # type: ignore
        import pyarrow.parquet as pq  # type: ignore
    except Exception:
        raise RuntimeError('pyarrow is required. Install with: pip install pyarrow')

    files = glob.glob(args.glob)
    files.sort()

    # collect batches
    ts, width, height, seq_id, frame_id, fps, kpts = [], [], [], [], [], [], []
    for fp in files:
        for obj in read_jsonl(fp):
            ts.append(obj.get('ts'))
            width.append(obj.get('width'))
            height.append(obj.get('height'))
            seq_id.append(obj.get('seq_id'))
            frame_id.append(obj.get('frame_id'))
            fps.append(obj.get('fps'))
            kpts.append(obj.get('kpts') or obj.get('keypoints'))

    table = pa.table({
        'ts': pa.array(ts),
        'width': pa.array(width),
        'height': pa.array(height),
        'seq_id': pa.array(seq_id),
        'frame_id': pa.array(frame_id),
        'fps': pa.array(fps),
        'kpts': pa.array(kpts),
    })
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    pq.write_table(table, args.out)
    print(f'Wrote parquet: {args.out} rows={table.num_rows}')


if __name__ == '__main__':
    main()


