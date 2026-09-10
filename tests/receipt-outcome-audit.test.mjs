import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditReceiptOutcomes, assertNow } from '../scripts/lib/receipt-outcome-audit.mjs';

const NOW = '2026-09-09T20:00:00Z';
const DAY = 86400000;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = resolve(HERE, '..', 'scripts', 'audit-receipt-outcomes.mjs');

const item = (o = {}) => ({ n: 1, fingerprint: 'fp-1', date: '2026-09-01', vendor: 'Vendor Zed', cents: 1234, amount: '$12.34', cardTail: '1111', issueId: 'iss-1', targetKey: 'bl-1', ...o });
const issue = (o = {}) => ({ id: 'iss-1', targetType: 'bank-line', targetKey: 'bl-1', displayDetails: null, firstObservedAt: '2026-09-01T00:00:00Z', clearedAt: null, createdAt: '2026-09-01T00:00:00Z', ...o });
const card = (o = {}) => ({ id: 'card-1', owner: 'owner-secret', pacificDate: '2026-09-01', itemsJson: JSON.stringify([item()]), status: 'PENDING', postedAt: null, threadName: null, messageName: null, attempts: 0, lastError: null, resendQueuedAt: null, createdAt: '2026-09-01T01:00:00Z', ...o });
const posted = (o = {}) => card({ status: 'POSTED', postedAt: '2026-09-01T02:00:00Z', messageName: 'spaces/s/messages/m', threadName: 'spaces/s/threads/t', ...o });
const artifact = (o = {}) => ({ id: 'art-secret', pdfId: 'pdf-secret', targetType: 'bank-line', targetKey: 'bl-1', issueId: 'iss-1', createdAt: '2026-09-02T00:00:00Z', ...o });
const memo = (pdfId = 'pdf-secret', resolution = 'memo-signed') => JSON.stringify({ resolution, pdfId, signedAt: '2026-09-02T00:00:00Z', signedThread: 'spaces/x' });
const snap = (o = {}) => ({ capturedAt: '2026-09-09T19:00:00Z', scope: 'test', issues: [], cards: [], artifacts: [], ...o });
const run = (s, now = NOW) => auditReceiptOutcomes(s, now);
const row = (a, k = 'bl-1') => a.rows.find((r) => r.targetKey === k);
const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; };

test('empty complete snapshot: observed 0, unobservable metrics null', () => {
  const a = run(snap());
  assert.equal(a.counts.observedTargets, 0);
  assert.equal(a.counts.eligibleRequests, null);
  assert.equal(a.counts.deliveredToPurchaser, null);
  assert.equal(a.counts.bridgeAck, null);
  assert.equal(a.counts.filedInProbuild, 0);
  assert.deepEqual(a.rows, []);
  assert.deepEqual(a.evidenceErrors, []);
  assert.ok(a.limitations.length > 0);
});

test('missing source arrays make dependent metrics unknown, never zero', () => {
  const a = run(snap({ issues: null, cards: [posted()], artifacts: null }));
  assert.equal(a.counts.observedTargets, null);
  assert.equal(a.counts.filedInProbuild, null);
  assert.equal(a.counts.signedArtifactsRecorded, null);
  assert.equal(a.counts.closedWithoutMemo, null);
  assert.equal(a.counts.unresolved, null);
  assert.equal(row(a).postedToChat, true);
  assert.equal(row(a).filedInProbuild, null);
  assert.ok(row(a).flags.includes('artifact_evidence_unknown'));
  const b = run(snap({ issues: [issue()], cards: null }));
  assert.equal(b.counts.postedToChat, null);
  assert.equal(b.counts.pending, null);
  assert.equal(b.counts.retry, null);
  assert.equal(b.counts.error, null);
  assert.equal(row(b).postedToChat, null);
});

test('verified provider post: awaiting purchaser, delivery still unknown', () => {
  const a = run(snap({ issues: [issue()], cards: [posted()] }));
  const r = row(a);
  assert.equal(r.stage, 'awaiting_purchaser');
  assert.equal(r.postedToChat, true);
  assert.equal(r.deliveredToPurchaser, null);
  assert.equal(r.bridgeAck, null);
  assert.equal(r.elapsedMs, 8 * DAY + 20 * 3600000);
  assert.equal(a.counts.postedToChat, 1);
  assert.equal(a.counts.awaitingPurchaser, 1);
});

test('POSTED status without post evidence is not a post', () => {
  const a = run(snap({ issues: [issue()], cards: [card({ status: 'POSTED', attempts: 2 })] }));
  assert.equal(row(a).stage, 'uncertain_delivery');
  assert.equal(row(a).postedToChat, null);
  assert.ok(row(a).flags.includes('posted_status_unverified'));
  assert.equal(a.counts.postedToChat, 0);
  assert.equal(a.counts.retry, 0);
});

test('POSTING / UNCERTAIN with no positive evidence is uncertain, not failed', () => {
  for (const status of ['POSTING', 'UNCERTAIN']) {
    const a = run(snap({ issues: [issue()], cards: [card({ status, attempts: 3 })] }));
    assert.equal(row(a).stage, 'uncertain_delivery');
    assert.equal(row(a).postedToChat, null);
    assert.ok(!row(a).flags.includes('retry_queued'));
  }
});

test('repeated cards for one target do not double count', () => {
  const a = run(snap({ issues: [issue()], cards: [posted(), posted({ id: 'card-2' }), card({ id: 'card-3', itemsJson: JSON.stringify([item(), item({ n: 2 })]) })] }));
  assert.equal(a.rows.length, 1);
  assert.deepEqual(row(a).requestCardIds, ['card-1', 'card-2', 'card-3']);
  assert.equal(a.counts.observedTargets, 1);
  assert.equal(a.counts.postedToChat, 1);
});

test('backed memo: resolution + artifact on same natural key and pdf = filed', () => {
  const a = run(snap({ issues: [issue({ displayDetails: memo() })], cards: [posted()], artifacts: [artifact()] }));
  const r = row(a);
  assert.equal(r.stage, 'filed_in_probuild');
  assert.equal(r.filedInProbuild, true);
  assert.equal(r.signedArtifactRecorded, true);
  assert.equal(r.elapsedMs, DAY);
  assert.equal(a.counts.filedInProbuild, 1);
  assert.equal(a.counts.signedArtifactsRecorded, 1);
  assert.equal(a.counts.unresolved, 0);
});

test('resolution alone, artifact alone, or memo-conflict are conflicts, not success', () => {
  const a = run(snap({ issues: [issue({ displayDetails: memo() })] }));
  assert.equal(row(a).stage, 'unresolved');
  assert.equal(row(a).filedInProbuild, false);
  assert.ok(row(a).flags.includes('resolution_without_artifact'));
  const b = run(snap({ issues: [issue()], artifacts: [artifact()] }));
  assert.equal(row(b).stage, 'unresolved');
  assert.equal(row(b).signedArtifactRecorded, false);
  assert.ok(row(b).flags.includes('artifact_without_resolution'));
  const c = run(snap({ issues: [issue({ displayDetails: memo('pdf-secret', 'memo-conflict') })], artifacts: [artifact()] }));
  assert.equal(row(c).stage, 'unresolved');
  assert.ok(row(c).flags.includes('memo_conflict'));
  assert.equal(c.counts.filedInProbuild, 0);
});

test('orphan artifact (no issue, no card) is excluded and reported', () => {
  const a = run(snap({ artifacts: [artifact({ targetKey: 'bl-nowhere' })] }));
  assert.deepEqual(a.rows, []);
  assert.ok(a.evidenceErrors.includes('artifact_without_target'));
  assert.equal(a.counts.observedTargets, 0);
});

test('clearedAt alone is closed without memo, not affidavit completion', () => {
  const a = run(snap({ issues: [issue({ clearedAt: '2026-09-03T00:00:00Z' })], cards: [posted()] }));
  assert.equal(row(a).stage, 'closed_without_memo');
  assert.equal(row(a).filedInProbuild, false);
  assert.equal(row(a).elapsedMs, null);
  assert.equal(a.counts.closedWithoutMemo, 1);
  assert.equal(a.counts.filedInProbuild, 0);
});

test('artifact with a different pdf than the resolution is a mismatch', () => {
  const a = run(snap({ issues: [issue({ displayDetails: memo('pdf-other') })], artifacts: [artifact()] }));
  assert.equal(row(a).stage, 'unresolved');
  assert.ok(row(a).flags.includes('artifact_pdf_mismatch'));
  assert.equal(row(a).filedInProbuild, false);
});

test('issue recreation: artifact binds by natural key to the single current issue', () => {
  const a = run(snap({
    issues: [issue({ id: 'iss-new', displayDetails: memo(), firstObservedAt: '2026-09-03T00:00:00Z', createdAt: '2026-09-03T00:00:00Z' })],
    artifacts: [artifact({ issueId: 'iss-old', createdAt: '2026-09-04T00:00:00Z' })],
  }));
  const r = row(a);
  assert.equal(a.rows.length, 1);
  assert.equal(r.stage, 'filed_in_probuild');
  assert.equal(r.issueId, 'iss-new');
  assert.equal(r.elapsedMs, DAY);
});

test('malformed or blank JSON reports static errors and makes evidence unknown', () => {
  const a = run(snap({
    issues: [issue({ displayDetails: '{not json' }), issue({ id: 'iss-2', targetKey: 'bl-2', displayDetails: '' })],
    cards: [card({ itemsJson: 'nope' }), card({ id: 'card-2', itemsJson: '' })],
    artifacts: [artifact()],
  }));
  assert.ok(a.evidenceErrors.includes('issue_details_malformed'));
  assert.ok(a.evidenceErrors.includes('card_items_malformed'));
  assert.equal(row(a).filedInProbuild, null);
  assert.equal(row(a).signedArtifactRecorded, null);
  assert.equal(row(a).stage, 'unresolved');
  assert.ok(row(a).flags.includes('issue_details_unknown'));
  assert.equal(row(a).postedToChat, null);
  assert.ok(row(a).flags.includes('card_evidence_incomplete'));
  assert.equal(a.counts.postedToChat, null);
  assert.equal(a.counts.pending, null);
  assert.equal(a.counts.error, null);
  assert.equal(a.counts.filedInProbuild, null);
});

test('orphan card target is retained with missing_issue', () => {
  const a = run(snap({ cards: [card({ id: 'card-9', itemsJson: JSON.stringify([item({ targetKey: 'bl-orphan', issueId: 'iss-gone' })]) })] }));
  const r = row(a, 'bl-orphan');
  assert.ok(r);
  assert.equal(r.issueId, null);
  assert.ok(r.flags.includes('missing_issue'));
  assert.equal(r.stage, 'pending');
  assert.equal(r.elapsedMs, null);
  assert.equal(a.counts.observedTargets, 1);
});

test('invalid, future, or out-of-order timestamps give null elapsed with a flag; bad now throws', () => {
  const a = run(snap({ issues: [issue({ firstObservedAt: 'not-a-date' })], cards: [posted()] }));
  assert.equal(row(a).elapsedMs, null);
  assert.ok(row(a).flags.includes('first_observed_invalid'));
  const b = run(snap({ issues: [issue({ firstObservedAt: '2027-01-01T00:00:00Z' })], cards: [posted()] }));
  assert.equal(row(b).elapsedMs, null);
  assert.ok(row(b).flags.includes('first_observed_future'));
  const c = run(snap({ issues: [issue({ displayDetails: memo(), firstObservedAt: '2026-09-05T00:00:00Z' })], artifacts: [artifact()] }));
  assert.equal(row(c).stage, 'filed_in_probuild');
  assert.equal(row(c).elapsedMs, null);
  assert.ok(row(c).flags.includes('timestamp_out_of_order'));
  assert.throws(() => run(snap(), '2026-09-09T20:00:00'), TypeError);
  assert.throws(() => run(snap(), 'garbage'), TypeError);
  assert.throws(() => assertNow(1757448000000), TypeError);
});

test('retry comes from resendQueuedAt only; attempts are not a retry; error from lastError only', () => {
  const a = run(snap({ issues: [issue()], cards: [card({ attempts: 5 })] }));
  assert.equal(a.counts.retry, 0);
  assert.equal(a.counts.error, 0);
  assert.equal(row(a).stage, 'pending');
  const b = run(snap({ issues: [issue()], cards: [card({ resendQueuedAt: '2026-09-02T00:00:00Z', lastError: 'boom secret' }), card({ id: 'card-2', resendQueuedAt: '2026-09-03T00:00:00Z' })] }));
  assert.equal(b.counts.retry, 1);
  assert.equal(b.counts.error, 1);
  assert.ok(row(b).flags.includes('retry_queued'));
  assert.ok(row(b).flags.includes('card_error'));
});

test('input snapshot is never mutated', () => {
  const s = deepFreeze(snap({ issues: [issue({ displayDetails: memo() })], cards: [posted()], artifacts: [artifact()] }));
  const before = JSON.stringify(s);
  run(s);
  assert.equal(JSON.stringify(s), before);
});

test('duplicate or conflicting identities fail closed', () => {
  const a = run(snap({ issues: [issue({ displayDetails: memo() }), issue({ displayDetails: memo() })], artifacts: [artifact()] }));
  assert.equal(row(a).stage, 'unresolved');
  assert.ok(row(a).flags.includes('identity_conflict'));
  assert.ok(a.evidenceErrors.includes('issue_identity_conflict'));
  assert.equal(row(a).filedInProbuild, false);
  const b = run(snap({
    issues: [issue({ displayDetails: memo() }), issue({ id: 'iss-2', targetKey: 'bl-2', displayDetails: memo() })],
    artifacts: [artifact(), artifact({ id: 'art-2', targetKey: 'bl-2' })],
  }));
  assert.equal(b.counts.filedInProbuild, 0);
  for (const k of ['bl-1', 'bl-2']) {
    assert.equal(row(b, k).stage, 'unresolved');
    assert.ok(row(b, k).flags.includes('artifact_pdf_conflict'));
  }
  const c = run(snap({ issues: [issue({ displayDetails: memo() })], artifacts: [artifact(), artifact({ id: 'art-2' })] }));
  assert.equal(row(c).stage, 'unresolved');
  assert.ok(row(c).flags.includes('artifact_conflict'));
});

test('output carries no vendor, owner, pdf id, artifact id, money text, or raw error', () => {
  const a = run(snap({ issues: [issue({ displayDetails: memo() })], cards: [posted({ lastError: 'boom secret' })], artifacts: [artifact()] }));
  const out = JSON.stringify(a);
  for (const s of ['Vendor Zed', 'owner-secret', 'art-secret', 'boom secret', '$12.34', '1111']) assert.ok(!out.includes(s), s);
  const stripped = JSON.stringify(a, (k, v) => (k === 'filedArtifact' ? undefined : v));
  assert.ok(!stripped.includes('pdf-secret'), 'pdf id appears only inside the accepted filedArtifact');
});

test('CLI runs offline from a snapshot file, fails closed on bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roa-'));
  const file = join(dir, 'snap.json');
  writeFileSync(file, JSON.stringify(snap({ issues: [issue()], cards: [posted()] })));
  const ok = spawnSync(process.execPath, [CLI, '--snapshot', file, '--now', NOW], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.counts.observedTargets, 1);
  assert.equal(out.rows[0].stage, 'awaiting_purchaser');
  const bad = spawnSync(process.execPath, [CLI, '--snapshot', join(dir, 'missing.json')], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.ok(bad.stderr.includes('snapshot file unreadable'));
  assert.ok(!bad.stderr.includes('ENOENT'));
  assert.equal(bad.stdout, '');
  const both = spawnSync(process.execPath, [CLI, '--snapshot', file, '--database'], { encoding: 'utf8' });
  assert.equal(both.status, 1);
});

test('CLI is inert on import even with DATABASE_URL set', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(CLI).href)}).then((m) => console.log(typeof m.parseArgs))`], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgresql://dummy:dummy@127.0.0.1:1/dummy' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'function');
  assert.equal(r.stderr, '');
});


test('partial, future, and inconsistent Chat metadata cannot prove a post', () => {
  for (const overrides of [{ messageName: null }, { threadName: null }, { postedAt: '2027-01-01T00:00:00Z' }, { postedAt: '2026-09-01T02:00:00' }, { messageName: 'spaces/other/messages/m' }]) {
    const a = run(snap({ issues: [issue()], cards: [posted(overrides)] }));
    assert.notEqual(row(a).postedToChat, true);
  }
});

test('malformed row sources make dependent totals unknown instead of zero', () => {
  for (const issues of [[null], [issue({targetKey:null})]]) {
    const a = run(snap({issues}));
    assert.equal(a.counts.observedTargets, null);
    assert.equal(a.counts.filedInProbuild, null);
  }
  const a = run(snap({cards:[card({itemsJson:'broken'})]}));
  assert.equal(a.counts.observedTargets, null);
});

test('duplicate issue or artifact identity invalidates both targets regardless of row order', () => {
  for (const kind of ['issue','artifact']) {
    const issues = [issue({displayDetails:memo()}),issue({id:kind==='issue'?'iss-1':'iss-2',targetKey:'bl-2',displayDetails:memo('pdf-2')})];
    const artifacts = [artifact(),artifact({id:kind==='artifact'?'art-secret':'art-2',targetKey:'bl-2',pdfId:'pdf-2'})];
    const a = run(snap({issues,artifacts}));
    assert.equal(a.counts.filedInProbuild,0);
    assert.ok(a.rows.every(r=>r.filedInProbuild!==true));
  }
});

test('two current issue rows with one natural key cannot select a convenient winner', () => {
  const a = run(snap({issues:[issue({displayDetails:memo()}),issue({id:'iss-2',clearedAt:'2026-09-02T00:00:00Z'})],artifacts:[artifact()]}));
  assert.equal(a.counts.filedInProbuild,0);
});

test('pending and awaiting are unresolved business targets', () => {
  for (const c of [card(),posted(),card({status:'UNCERTAIN'})]) {
    assert.equal(run(snap({issues:[issue()],cards:[c]})).counts.unresolved,1);
  }
});

test('local CLI rejects direct database mode even with credentials available', () => {
  const a=spawnSync(process.execPath,[CLI,'--database'],{encoding:'utf8',env:{...process.env,DATABASE_URL:'postgres://dummy:dummy@127.0.0.1:1/nope'}});
  assert.equal(a.status,1);
  assert.equal(a.stdout,'');
});
