import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyRecoveryService } from '../src/lib/legacy-affidavit-recovery-service';
import { stableRecoveryDigest } from '../src/lib/legacy-affidavit-recovery-proof';
import { fixture } from './fixtures/legacy-recovery-fixture';

type Artifact = {
  pdfId: string;
  pdfSha256: string | null;
  targetType: string;
  targetKey: string;
  issueId: string;
  provenanceJson: string | null;
};

type Snapshot = {
  canonical: unknown;
  issue: { id: string; version: number; displayDetails: string | null };
  artifacts: Artifact[];
  unknownArtifacts: { count: number; pdfIds: string[]; truncated: boolean };
  identityConflict: boolean;
  truncated: boolean;
};

type DriveResult =
  | { kind: 'verified'; id: string; sha256: string; version: string; byteLength: number }
  | { kind: 'unavailable'; reason: string };

const NOW = new Date('2026-09-10T12:00:00.000Z');
const BANK_LINE = '9c1e4d2a-7b3f-4e8c-a1d5-2f6b8c9d0e1a';
const ISSUE_ID = 'issue-1';
const PDF_ID = 'fictional_pdf_1234567890';
const PDF_SHA = 'a'.repeat(64);

function clone<T>(v: T): T {
  return structuredClone(v);
}

function baseSnapshot(canonical: unknown, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    canonical,
    issue: { id: ISSUE_ID, version: 3, displayDetails: '{}' },
    artifacts: [],
    unknownArtifacts: { count: 0, pdfIds: [], truncated: false },
    identityConflict: false,
    truncated: false,
    ...overrides,
  };
}

type HarnessOptions = {
  snapshot?: Partial<Snapshot>;
  drive?: Record<string, DriveResult>;
  packetThrows?: Error;
  writeThrows?: Error;
  /** Called with the live state before tx.snapshot() resolves, to simulate in-TX drift. */
  beforeTxSnapshot?: (state: { snapshot: Snapshot }) => void;
};

function makeHarness(opts: HarnessOptions = {}) {
  const { packet, canonical } = fixture();
  const packetDigest = stableRecoveryDigest(packet);
  const state = { snapshot: baseSnapshot(canonical, opts.snapshot) };
  const committed: any[] = [];
  const lockOrder: string[] = [];
  let transactions = 0;
  let packetCalls = 0;
  const drive: Record<string, DriveResult> = opts.drive ?? {
    [PDF_ID]: { kind: 'verified', id: PDF_ID, sha256: PDF_SHA, version: 'v1', byteLength: 1234 },
  };

  const deps = {
    packet: async () => {
      packetCalls += 1;
      if (opts.packetThrows) throw opts.packetThrows;
      return { packet: clone(packet), packetDigest };
    },
    drive: async (pdfId: string): Promise<DriveResult> =>
      drive[pdfId] ?? { kind: 'unavailable', reason: `no such pdf ${pdfId}` },
    snapshot: async (bankLineId: string) => {
      assert.equal(bankLineId, BANK_LINE);
      return clone(state.snapshot);
    },
    transaction: async (fn: (tx: any) => Promise<unknown>) => {
      transactions += 1;
      const pending: any[] = [];
      const before = clone(state.snapshot);
      const tx = {
        ...clone(state.snapshot),
        snapshot: async (bankLineId: string) => {
          assert.equal(bankLineId, BANK_LINE);
          opts.beforeTxSnapshot?.(state);
          return clone(state.snapshot);
        },
        lockEvidence: async () => { lockOrder.push('evidence'); },
        lockBankIdentity: async () => { lockOrder.push('bank'); },
        lockContent: async (hash: string) => { lockOrder.push(`content:${hash}`); },
        lockPdf: async (id: string) => { lockOrder.push(`pdf:${id}`); },
        writeRecovery: async (rec: any) => {
          if (opts.writeThrows) throw opts.writeThrows;
          pending.push(clone(rec));
          // stage a provenance-bearing artifact as a real write would
          state.snapshot.artifacts.push({pdfId:rec.pdf.id,pdfSha256:rec.pdf.sha256,targetType:'bank-line',targetKey:BANK_LINE,issueId:ISSUE_ID,provenanceJson:JSON.stringify({recoveredBy:rec.recoveredBy,packetDigest,planDigest:rec.planDigest})});
        },
      };
      try {
        const out = await fn(tx);
        committed.push(...pending);
        return out;
      } catch (err) {
        state.snapshot = before; // rollback
        throw err;
      }
    },
    now: () => new Date(NOW.getTime()),
  };

  const service = createLegacyRecoveryService(deps as any);
  return {
    service,
    state,
    committed,
    lockOrder,
    packet,
    packetDigest,
    get transactions() { return transactions; },
    get packetCalls() { return packetCalls; },
  };
}

test('prepare returns ready with a planDigest and never opens a transaction or writes', async () => {
  const h = makeHarness();
  const res = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ready');
  assert.equal(typeof res.planDigest, 'string');
  assert.ok(res.planDigest!.length > 0);
  assert.equal(h.transactions, 0);
  assert.equal(h.committed.length, 0);
});

test('apply with the exact planDigest writes once under locks ordered evidence -> bank -> content -> pdf; wrong digest is rejected', async () => {
  const h = makeHarness();
  const prep = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  assert.equal(prep.status, 'ready');

  const bad = await h.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: 'not-the-plan' });
  assert.equal(bad.ok, false);
  assert.equal(h.committed.length, 0);

  const res = await h.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: prep.planDigest });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'recovered');
  assert.equal(res.planDigest, prep.planDigest);
  assert.equal(h.transactions, 2);
  assert.equal(h.committed.length, 1);
  assert.deepEqual(h.lockOrder, ['evidence', 'bank', `content:${PDF_SHA}`, `pdf:${PDF_ID}`]);

  const rec = h.committed[0];
  assert.equal(rec.recoveredBy, 'cron-machine');
  assert.equal(rec.planDigest, prep.planDigest);
  assert.equal(rec.pdf.id, PDF_ID);
  assert.equal(rec.pdf.sha256, PDF_SHA);
  assert.equal(rec.snapshot.issue.version, 3);
});

test('apply persists the packet as returned at reply time and stamps recoveredAt from now() separately', async () => {
  const h = makeHarness();
  const prep = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  const res = await h.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: prep.planDigest });
  assert.equal(res.status, 'recovered');
  const rec = h.committed[0];
  assert.deepEqual(rec.packet, h.packet);
  assert.notEqual(rec.packet, h.packet);
  assert.equal(new Date(rec.recoveredAt).toISOString(), NOW.toISOString());
  assert.equal(JSON.stringify(rec.packet).includes(NOW.toISOString()), false);
});

test('immutable config pin mismatch from packet() rejects before any transaction', async () => {
  const h = makeHarness({ packetThrows: new Error('config pin mismatch') });
  await assert.rejects(
    () => h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE }),
    /pin mismatch/,
  );
  await assert.rejects(
    () => h.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: 'anything' }),
    /pin mismatch/,
  );
  assert.equal(h.transactions, 0);
  assert.equal(h.committed.length, 0);
});

test('pdf hash drift between artifact and drive is rejected with no writes', async () => {
  const h = makeHarness({
    drive: { [PDF_ID]: { kind: 'verified', id: PDF_ID, sha256: 'b'.repeat(64), version: 'v2', byteLength: 999 } },
  });
  const prep = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  assert.equal(prep.ok, false);
  assert.equal(prep.status, 'conflict');
  assert.match(prep.reason ?? '', /sha256|hash/i);

  const res = await h.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: prep.planDigest ?? 'x' });
  assert.equal(res.ok, false);
  assert.equal(h.committed.length, 0);
});

test('issue version drift after prepare or inside the transaction rejects apply with no writes', async () => {
  // drift between prepare and apply
  const a = makeHarness();
  const prepA = await a.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  a.state.snapshot.issue.version = 4;
  const resA = await a.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: prepA.planDigest });
  assert.equal(resA.ok, false);
  assert.notEqual(resA.status, 'recovered');
  assert.equal(a.committed.length, 0);

  // drift observed only by the in-transaction snapshot
  let armed = false;
  const b = makeHarness({
    beforeTxSnapshot: (state) => { if (armed) state.snapshot.issue.version = 4; },
  });
  const prepB = await b.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  armed = true;
  const resB = await b.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: prepB.planDigest });
  assert.equal(resB.ok, false);
  assert.notEqual(resB.status, 'recovered');
  assert.equal(b.committed.length, 0);
});

test('artifact bound to a malformed or wrong target conflicts', async () => {
  const h = makeHarness({
    snapshot: {
      artifacts: [{
        pdfId: PDF_ID,
        pdfSha256: PDF_SHA,
        targetType: 'affidavitBatch',
        targetKey: 'some-other-key',
        issueId: ISSUE_ID,
        provenanceJson: null,
      }],
    },
  });
  const res = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'conflict');
  assert.match(res.reason ?? '', /target/i);
  assert.equal(h.transactions, 0);
});

test('hashless artifact and unknownArtifacts count make the recovery incomplete', async () => {
  const h = makeHarness({
    snapshot: {
      artifacts: [{
        pdfId: PDF_ID,
        pdfSha256: null,
        targetType: 'bank-line',
        targetKey: BANK_LINE,
        issueId: ISSUE_ID,
        provenanceJson: null,
      }],
      unknownArtifacts: { count: 2, pdfIds: ['pdf-x', 'pdf-y'], truncated: false },
    },
  });
  const res = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'incomplete');
  assert.equal(h.committed.length, 0);
});

test('the same content hash on another pdf is a conflict', async () => {
  const h = makeHarness({
    snapshot: {
      artifacts: [
        { pdfId: PDF_ID, pdfSha256: PDF_SHA, targetType: 'bank-line', targetKey: BANK_LINE, issueId: ISSUE_ID, provenanceJson: null },
        { pdfId: 'pdf-2', pdfSha256: PDF_SHA, targetType: 'bank-line', targetKey: BANK_LINE, issueId: ISSUE_ID, provenanceJson: null },
      ],
    },
    drive: {
      [PDF_ID]: { kind: 'verified', id: PDF_ID, sha256: PDF_SHA, version: 'v1', byteLength: 1234 },
      'pdf-2': { kind: 'verified', id: 'pdf-2', sha256: PDF_SHA, version: 'v1', byteLength: 1234 },
    },
  });
  const res = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'conflict');
  assert.equal(h.transactions, 0);
});

test('competing bank identity is a conflict and apply refuses to write', async () => {
  const h = makeHarness({ snapshot: { identityConflict: true } });
  const prep = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  assert.equal(prep.ok, false);
  assert.equal(prep.status, 'conflict');

  const clean = makeHarness();
  const goodPlan = (await clean.service.handle({ mode: 'prepare', bankLineId: BANK_LINE })).planDigest;
  const res = await h.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: goodPlan });
  assert.equal(res.ok, false);
  assert.equal(h.committed.length, 0);
});

test('a throwing writeRecovery rolls the transaction back with nothing committed and snapshot restored', async () => {
  const h = makeHarness({ writeThrows: new Error('disk on fire') });
  const prep = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  const before = clone(h.state.snapshot);
  await assert.rejects(
    () => h.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: prep.planDigest }),
    /disk on fire/,
  );
  assert.equal(h.committed.length, 0);
  assert.deepEqual(h.state.snapshot, before);
  assert.deepEqual(h.lockOrder, ['evidence', 'bank', `content:${PDF_SHA}`, `pdf:${PDF_ID}`]);
});

test('an identical prior recovery returns already-recovered only with matching hash, provenance and exact packetDigest; hashless same binding stays incomplete', async () => {
  const probe = makeHarness();
  const plan = (await probe.service.handle({ mode: 'prepare', bankLineId: BANK_LINE })).planDigest;
  const provenance = (packetDigest: string) =>
    JSON.stringify({ recoveredBy: 'cron-machine', packetDigest, planDigest: plan });

  // identical prior recovery, plus an unrelated hashless artifact that must not block it
  const done = makeHarness({
    snapshot: {
      artifacts: [
        { pdfId: PDF_ID, pdfSha256: PDF_SHA, targetType: 'bank-line', targetKey: BANK_LINE, issueId: ISSUE_ID, provenanceJson: provenance(probe.packetDigest) },
        { pdfId: 'pdf-unrelated', pdfSha256: null, targetType: 'attachment', targetKey: 'elsewhere', issueId: 'issue-other', provenanceJson: null },
      ],
    },
  });
  const already = await done.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: plan });
  assert.equal(already.ok, true);
  assert.equal(already.status, 'already-recovered');
  assert.equal(done.committed.length, 0);

  // provenance naming a different packetDigest is not "the same" recovery
  const stale = makeHarness({
    snapshot: {
      artifacts: [
        { pdfId: PDF_ID, pdfSha256: PDF_SHA, targetType: 'bank-line', targetKey: BANK_LINE, issueId: ISSUE_ID, provenanceJson: provenance('deadbeef') },
      ],
    },
  });
  const staleRes = await stale.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
  assert.notEqual(staleRes.status, 'already-recovered');

  // same binding but hashless: cannot retroactively claim a recovery
  const hashless = makeHarness({
    snapshot: {
      artifacts: [
        { pdfId: PDF_ID, pdfSha256: null, targetType: 'bank-line', targetKey: BANK_LINE, issueId: ISSUE_ID, provenanceJson: provenance(probe.packetDigest) },
      ],
    },
  });
  const hashlessRes = await hashless.service.handle({ mode: 'apply', bankLineId: BANK_LINE, planDigest: plan });
  assert.equal(hashlessRes.ok, false);
  assert.equal(hashlessRes.status, 'incomplete');
  assert.equal(hashless.committed.length, 0);
});
test('malformed inventory and issue versions fail closed before any write',async()=>{
 for(const patch of [
  {unknownArtifacts:{count:NaN,pdfIds:[],truncated:false}},
  {unknownArtifacts:{count:-1,pdfIds:[],truncated:false}},
  {unknownArtifacts:{count:'0',pdfIds:[],truncated:false}},
  {unknownArtifacts:{count:0,pdfIds:[],truncated:'false'}},
  {unknownArtifacts:{count:1,pdfIds:[''],truncated:false}},
  {unknownArtifacts:{count:0,pdfIds:[],truncated:false},identityConflict:'false'},
  {issue:{id:ISSUE_ID,version:0,displayDetails:'{}'}},
  {issue:{id:ISSUE_ID,version:2147483648,displayDetails:'{}'}},
  {artifacts:[{pdfId:'bad'}]},
 ]){const h=makeHarness({snapshot:patch as any});const res=await h.service.handle({mode:'prepare',bankLineId:BANK_LINE});assert.equal(res.ok,false,JSON.stringify(patch));assert.equal(h.committed.length,0);}
});

test('Drive unavailability is incomplete while verified hash drift remains a conflict', async () => {
  const h = makeHarness({ drive: { [PDF_ID]: { kind: 'unavailable', reason: 'timeout' } } });
  for (const mode of ['prepare', 'apply'] as const) {
    const result = await h.service.handle({ mode, bankLineId: BANK_LINE, planDigest: 'x' });
    assert.equal(result.status, 'incomplete');
    assert.equal(h.transactions, 0);
    assert.equal(h.committed.length, 0);
  }
});
test('prepare rejects details the real writer cannot preserve as an object', async () => {
  for (const displayDetails of ['Legacy affidavit', '[]', 'null', '1', '"text"']) {
    const h = makeHarness({ snapshot: { issue: { id: ISSUE_ID, version: 3, displayDetails } } });
    const result = await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE });
    assert.equal(result.status, 'rejected', displayDetails);
    assert.equal(result.planDigest, undefined);
    assert.equal(h.transactions, 0);
  }
  for (const displayDetails of [null, '', '  ', '{}']) {
    const h = makeHarness({ snapshot: { issue: { id: ISSUE_ID, version: 3, displayDetails } } });
    assert.equal((await h.service.handle({ mode: 'prepare', bankLineId: BANK_LINE })).status, 'ready');
  }
});
