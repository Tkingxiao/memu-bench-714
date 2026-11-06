"""Prepare semantic review packets and calculate benchmark scores offline."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'datasets' / 'natural-timegrid-20261101-v2'
FLAGS = ('错认', '错否', '越界', '编造日期', '不当私事披露')
LISTS = ('违反禁止', '未知当事实', '无关旧事')


def read_rows(path):
    with path.open(encoding='utf-8-sig') as f:
        return [json.loads(line) for line in f if line.strip()]


def indexed(rows):
    result = {}
    for row in rows:
        ident = row['id']
        if not isinstance(ident, str) or not ident or ident in result:
            raise ValueError(f'Invalid or duplicate id: {ident!r}')
        result[ident] = row
    return result


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def rubric_digest(rubric):
    return digest(json.dumps(rubric, ensure_ascii=False, sort_keys=True))


def write_rows(path, rows):
    with path.open('w', encoding='utf-8', newline='\n') as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')


def prepare(answers):
    questions = indexed(read_rows(DATA / 'exam-inputs.jsonl'))
    keys = indexed(read_rows(DATA / 'review-only' / 'answer-key.jsonl'))
    evidence = indexed(read_rows(ROOT / 'grading' / 'evidence.jsonl'))
    for row in answers:
        ident = row['id']
        if ident not in questions or ident not in keys or ident not in evidence:
            raise ValueError(f'Unknown question: {ident}')
        if not isinstance(row.get('answer'), str) or not row['answer'].strip():
            raise ValueError(f'Answer must be non-empty text: {ident}')
        q, key = questions[ident], keys[ident]
        yield {'id': ident, 'question': q['question'], 'now': q['now'],
               'rubric': key['rubric'], 'facts': evidence[ident]['facts'],
               'sources': evidence[ident]['sources'], 'answer': row['answer'],
               'answer_sha256': digest(row['answer']),
               'rubric_sha256': rubric_digest(key['rubric'])}


def score(packets, reviews):
    keys = indexed(read_rows(DATA / 'review-only' / 'answer-key.jsonl'))
    questions = indexed(read_rows(DATA / 'exam-inputs.jsonl'))
    missing = set(packets) - set(reviews)
    extra = set(reviews) - set(packets)
    if missing or extra:
        raise ValueError(f'Review IDs do not match: missing={len(missing)}, extra={len(extra)}')
    for ident, packet in packets.items():
        review = reviews[ident]
        if ident not in keys or ident not in questions:
            raise ValueError(f'Unknown question: {ident}')
        if (packet['answer_sha256'] != digest(packet['answer']) or
                packet['rubric_sha256'] != rubric_digest(keys[ident]['rubric']) or
                packet['rubric'] != keys[ident]['rubric'] or
                any(review.get(k) != packet[k] for k in ('answer_sha256', 'rubric_sha256'))):
            raise ValueError(f'Answer or rubric hash mismatch: {ident}')
        required = review.get('required')
        if not isinstance(required, list) or len(required) != len(packet['rubric']['required']) or any(type(v) is not bool for v in required):
            raise ValueError(f'Invalid required decisions: {ident}')
        if any(type(review.get(k)) is not bool for k in FLAGS):
            raise ValueError(f'All error flags must be booleans: {ident}')
        if any(not isinstance(review.get(k), list) or any(not isinstance(v, str) or not v.strip() for v in review[k]) for k in LISTS):
            raise ValueError(f'All detail fields must be lists of non-empty strings: {ident}')
        if not isinstance(review.get('reason'), str) or not review['reason'].strip():
            raise ValueError(f'Non-empty reason required: {ident}')
        factual = all(required) and not review['违反禁止'] and not review['未知当事实'] and not any(review[k] for k in FLAGS[:4])
        relevant = len(review['无关旧事']) < 3 and not review['不当私事披露']
        key = keys[ident]
        yield {'id': ident, 'persona': questions[ident]['persona'],
               'content_tags': key['content_tags'], 'interval_days': key['interval_days'],
               'answer_sha256': packet['answer_sha256'], 'rubric_sha256': packet['rubric_sha256'],
               'required': required, **{k: review[k] for k in (*FLAGS, *LISTS)},
               'factual_pass': factual, 'relevance_pass': relevant,
               'pass': factual and relevant, 'reason': review['reason']}


def summarize(rows):
    groups = {'persona': {}, 'content_tags': {}, 'interval_days': {}}
    for row in rows:
        for name, values in [('persona', [row['persona']]), ('content_tags', row['content_tags']), ('interval_days', [str(row['interval_days'])])]:
            for value in values:
                counts = groups[name].setdefault(value, Counter())
                counts['total'] += 1
                counts['passed'] += int(row['pass'])
    return {'passed': sum(row['pass'] for row in rows), 'scored': len(rows),
            'dataset_questions': len(read_rows(DATA / 'exam-inputs.jsonl')),
            'groups': groups}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--answers', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p = sub.add_parser('score')
    p.add_argument('--packets', type=Path, required=True)
    p.add_argument('--reviews', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--summary', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        result = list(prepare(indexed(read_rows(args.answers)).values()))
        write_rows(args.out, result)
        print(f'Prepared {len(result)} questions')
    else:
        result = list(score(indexed(read_rows(args.packets)), indexed(read_rows(args.reviews))))
        report = summarize(result)
        write_rows(args.out, result)
        args.summary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f"Passed {report['passed']} / {report['scored']}")


if __name__ == '__main__':
    main()
