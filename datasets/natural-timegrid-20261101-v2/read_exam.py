"""Strict local input reader. Does not import a provider or read the answer key."""
from datetime import datetime
import argparse
import hashlib
import json
from pathlib import Path


def rows(path):
    return [json.loads(s) for s in path.read_text(encoding='utf-8-sig').splitlines() if s.strip()]


def read_input(root, record):
    allowed = {'id','persona','history_file','history_sha256','now','cutoff_turn','question'}
    if set(record) != allowed:
        raise ValueError('Unexpected exam input fields')
    persona = record['persona']
    if persona not in {'P01','P12','P14','P16','P17','P20'}:
        raise ValueError('Unexpected persona')
    if record['history_file'] != f'histories/{persona}.jsonl':
        raise ValueError('Cross-persona or arbitrary history path')
    hp = root / record['history_file']
    if hashlib.sha256(hp.read_bytes()).hexdigest() != record['history_sha256']:
        raise ValueError('History SHA mismatch')
    now = datetime.fromisoformat(record['now'])
    if now.tzinfo is None:
        raise ValueError('Timezone required')
    history = rows(hp)
    ids = [r['轮次'] for r in history]
    if ids != list(range(1, len(history) + 1)):
        raise ValueError('History turn order mismatch')
    times = [datetime.fromisoformat(r['逻辑时间']) for r in history]
    if times != sorted(times) or any(t.tzinfo is None for t in times):
        raise ValueError('History time order mismatch')
    prefix = [r for r,t in zip(history,times) if t <= now]
    cutoff = prefix[-1]['轮次'] if prefix else 0
    if record['cutoff_turn'] != cutoff:
        raise ValueError('Future/missing history cutoff')
    # Only original message fields are allowed across the ingestion boundary.
    clean = [{'turn': r['轮次'], 'time': r['逻辑时间'],
              'user': r['用户消息'], 'assistant': r['助手回复']} for r in prefix]
    return {'id': record['id'], 'persona': persona, 'now': record['now'],
            'history': clean, 'question': record['question']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--id')
    parser.add_argument('--verify-all', action='store_true')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    root = args.root.resolve()
    records = rows(root / 'exam-inputs.jsonl')
    if args.verify_all:
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        for rel, expected in manifest['file_sha256'].items():
            target = (root / rel).resolve()
            if root not in target.parents:
                raise ValueError('Manifest path outside release')
            if hashlib.sha256(target.read_bytes()).hexdigest() != expected:
                raise ValueError(f'Manifest mismatch: {rel}')
        if len({r['id'] for r in records}) != len(records):
            raise ValueError('Duplicate instance IDs')
        for record in records:
            read_input(root, record)
        print(json.dumps({'verified_inputs': len(records), 'manifest_files': len(manifest['file_sha256']),
                          'network_calls': 0, 'status': 'offline_integrity_and_input_boundary_pass'}))
    elif args.id:
        found = [r for r in records if r['id'] == args.id]
        if len(found) != 1:
            raise ValueError('Unknown or duplicate instance id')
        print(json.dumps(read_input(root, found[0]), ensure_ascii=False))
    else:
        parser.error('Choose --verify-all or --id')


if __name__ == '__main__':
    main()
