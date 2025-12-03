import argparse
import glob
import json
import os
from typing import Dict, List, Tuple


def parse_args():
    p = argparse.ArgumentParser(description='Export reduced parquet for representative segments')
    p.add_argument('--windows_index_json', type=str, required=True)
    p.add_argument('--segments', type=str, required=True, help='segments_representative.json or segments.json')
    p.add_argument('--files_glob', type=str, default='dataset/raw/*.jsonl')
    p.add_argument('--out', type=str, default='runs/segments_representative.parquet')
    return p.parse_args()


def merge_ranges(ranges: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    if not ranges:
        return []
    ranges = sorted(ranges)
    out = [ranges[0]]
    for s, e in ranges[1:]:
        ps, pe = out[-1]
        if s <= pe + 1:
            out[-1] = (ps, max(pe, e))
        else:
            out.append((s, e))
    return out


def read_jsonl_selected(path: str, keep: List[Tuple[int, int]]):
    # keep: sorted, merged ranges of line indices (0-based)
    cur_range_idx = 0
    pos = 0
    rs = keep
    with open(path, 'r') as f:
        for line in f:
            if cur_range_idx >= len(rs):
                break
            s, e = rs[cur_range_idx]
            if pos < s:
                pos += 1
                continue
            if pos > e:
                cur_range_idx += 1
                continue
            yield json.loads(line)
            pos += 1


def main():
    args = parse_args()
    try:
        import pyarrow as pa  # type: ignore
        import pyarrow.parquet as pq  # type: ignore
    except Exception:
        raise RuntimeError('pyarrow is required. Install with: pip install pyarrow')

    with open(args.windows_index_json, 'r') as f:
        W = json.load(f)
    with open(args.segments, 'r') as f:
        S = json.load(f)

    T = int(W.get('window', 32))
    stride = int(W.get('stride', 8))
    windows = W.get('windows', [])
    file_basenames = W.get('files', [])

    segments = S.get('segments', [])
    if not segments:
        print('No segments provided; nothing to export')
        return

    # Map basenames to real paths from glob
    all_files = glob.glob(args.files_glob)
    base_to_path: Dict[str, str] = { os.path.basename(p): p for p in all_files }

    # Build per-file frame ranges from segments by union of window spans
    file_to_ranges: Dict[int, List[Tuple[int, int]]] = {}
    for seg in segments:
        ws = int(seg['start'])
        we = int(seg['end'])
        for wi in range(ws, we + 1):
            if wi < 0 or wi >= len(windows):
                continue
            w = windows[wi]
            fi = int(w['file_index'])
            start = int(w['start'])
            fr_s = start
            fr_e = start + T - 1
            file_to_ranges.setdefault(fi, []).append((fr_s, fr_e))

    # Merge ranges
    for fi in list(file_to_ranges.keys()):
        file_to_ranges[fi] = merge_ranges(file_to_ranges[fi])

    # Collect rows
    ts, width, height, seq_id, frame_id, fps, kpts = [], [], [], [], [], [], []
    total = 0
    for fi, ranges in file_to_ranges.items():
        base = file_basenames[fi] if fi < len(file_basenames) else None
        if not base or base not in base_to_path:
            print(f'[warn] base not found: {base}, skipping')
            continue
        path = base_to_path[base]
        # read selected frames
        for obj in read_jsonl_selected(path, ranges):
            ts.append(obj.get('ts'))
            width.append(obj.get('width'))
            height.append(obj.get('height'))
            seq_id.append(obj.get('seq_id'))
            frame_id.append(obj.get('frame_id'))
            fps.append(obj.get('fps'))
            kpts.append(obj.get('kpts') or obj.get('keypoints'))
            total += 1

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
    print(f'Wrote reduced parquet: {args.out} rows={table.num_rows}')


if __name__ == '__main__':
    main()


