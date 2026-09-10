import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectMemoContentBinding } from '../src/lib/receipt-memo-content-guard';

type Row = {
  id: string;
  pdfId: string;
  pdfSha256: string | null;
  targetType: string;
  targetKey: string;
  issueId: string;
  provenanceJson: string | null;
};

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function matchesValue(actual: unknown, cond: unknown): boolean {
  if (cond === null) return actual === null;
  if (typeof cond !== 'object') return actual === cond;
  const c = cond as Record<string, unknown>;
  if ('equals' in c) return actual === c.equals;
  if ('in' in c) return (c.in as unknown[]).includes(actual);
  if ('notIn' in c) return !(c.notIn as unknown[]).includes(actual);
  if ('not' in c) return c.not === null ? actual !== null : actual !== c.not;
  throw new Error(`fake: unsupported condition ${JSON.stringify(cond)}`);
}

function matchesWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      const arr = Array.isArray(v) ? v : [v];
      if (!arr.every((w) => matchesWhere(row, w as Record<string, unknown>))) return false;
    } else if (k === 'OR') {
      if (!(v as Record<string, unknown>[]).some((w) => matchesWhere(row, w))) return false;
    } else if (k === 'NOT') {
      const arr = Array.isArray(v) ? v : [v];
      if (arr.some((w) => matchesWhere(row, w as Record<string, unknown>))) return false;
    } else {
      if (!(k in row)) throw new Error(`fake: unknown column ${k}`);
      if (!matchesValue((row as Record<string, unknown>)[k], v)) return false;
    }
  }
  return true;
}

function project(row: Row, select?: Record<string, boolean>): Partial<Row> {
  if (!select) return { ...row };
  const out: Partial<Row> = {};
  for (const [k, v] of Object.entries(select)) if (v) (out as Record<string, unknown>)[k] = (row as Record<string, unknown>)[k];
  return out;
}

function makeTx(rows: Row[]) {
  const rawCalls: unknown[] = [];
  const mutation = (name: string) => () => {
    throw new Error(`guard must not call receiptMemoArtifact.${name}`);
  };
  const tx = {
    receiptMemoArtifact: {
      async findMany(args: { where?: Record<string, unknown>; take?: number; select?: Record<string, boolean>; orderBy?: unknown } = {}) {
        let res = rows.filter((r) => matchesWhere(r, args.where));
        if (args.orderBy) {
          const ob = Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy;
          const [[col, dir]] = Object.entries(ob as Record<string, string>);
          res = [...res].sort((x, y) => {
            const a = String((x as Record<string, unknown>)[col]);
            const b = String((y as Record<string, unknown>)[col]);
            return (a < b ? -1 : a > b ? 1 : 0) * (dir === 'desc' ? -1 : 1);
          });
        }
        if (typeof args.take === 'number') res = res.slice(0, args.take);
        return res.map((r) => project(r, args.select));
      },
      async findUnique(args: { where: { id: string }; select?: Record<string, boolean> }) {
        if (!args?.where || typeof args.where.id !== 'string' || Object.keys(args.where).length !== 1) {
          throw new Error('fake: findUnique requires where.id only');
        }
        const r = rows.find((x) => x.id === args.where.id);
        return r ? project(r, args.select) : null;
      },
      async count(args: { where?: Record<string, unknown> } = {}) {
        return rows.filter((r) => matchesWhere(r, args.where)).length;
      },
      create: mutation('create'),
      createMany: mutation('createMany'),
      update: mutation('update'),
      updateMany: mutation('updateMany'),
      upsert: mutation('upsert'),
      delete: mutation('delete'),
      deleteMany: mutation('deleteMany'),
    },
    $executeRaw(...args: unknown[]) {
      rawCalls.push(args);
      throw new Error('guard must not call $executeRaw');
    },
    $executeRawUnsafe(...args: unknown[]) {
      rawCalls.push(args);
      throw new Error('guard must not call $executeRawUnsafe');
    },
    $queryRaw(...args: unknown[]) {
      rawCalls.push(args);
      throw new Error('guard must not call $queryRaw');
    },
  };
  return { tx, rawCalls };
}

function row(p: Partial<Row> & { id: string }): Row {
  return {
    pdfId: 'pdf-1',
    pdfSha256: HASH_A,
    targetType: 'bank-line',
    targetKey: 'bl-1',
    issueId: 'issue-1',
    provenanceJson: null,
    ...p,
  };
}

const baseInput = {
  pdfId: 'pdf-1',
  pdfSha256: HASH_A,
  targetType: 'bank-line' as const,
  targetKey: 'bl-1',
  issueId: 'issue-1',
};

async function run(rows: Row[], input = baseInput) {
  const { tx, rawCalls } = makeTx(rows);
  const result = await inspectMemoContentBinding(tx as never, input);
  assert.equal(rawCalls.length, 0, 'guard must not issue raw SQL');
  return result;
}

test('no existing artifacts and no hashless rows -> new', async () => {
  const r = await run([]);
  assert.deepEqual(r, { kind: 'new' });
});

test('exact same hash/pdf/target/issue -> same with hashVerified true', async () => {
  const r = await run([row({ id: 'm1' })]);
  assert.deepEqual(r, { kind: 'same', hashVerified: true });
});

test('same pdf already bound to a different target -> conflict', async () => {
  const r = await run([row({ id: 'm1', targetKey: 'bl-other' })]);
  assert.equal(r.kind, 'conflict');
  assert.match((r as { reason: string }).reason, /pdf|target/i);
});

test('same target already bound to a different file -> conflict', async () => {
  const r = await run([row({ id: 'm1', pdfId: 'pdf-2', pdfSha256: HASH_B })]);
  assert.equal(r.kind, 'conflict');
  assert.match((r as { reason: string }).reason, /target|pdf/i);
});

test('same content hash reused under a different pdf id -> conflict', async () => {
  const r = await run([row({ id: 'm1', pdfId: 'pdf-2', targetKey: 'bl-2', issueId: 'issue-2' })]);
  assert.equal(r.kind, 'conflict');
  assert.match((r as { reason: string }).reason, /hash/i);
});

test('unrelated hashless artifact blocks a new binding -> incomplete', async () => {
  const r = await run([row({ id: 'm9', pdfId: 'pdf-9', pdfSha256: null, targetKey: 'bl-9', issueId: 'issue-9' })]);
  assert.deepEqual(r, {
    kind: 'incomplete',
    reason: 'hashless-bindings',
    unknownCount: 1,
    unknownPdfIds: ['pdf-9'],
    truncated: false,
  });
});

test('exact repeat still returns same even when unrelated hashless artifacts exist', async () => {
  const r = await run([
    row({ id: 'm1' }),
    row({ id: 'm9', pdfId: 'pdf-9', pdfSha256: null, targetKey: 'bl-9', issueId: 'issue-9' }),
  ]);
  assert.deepEqual(r, { kind: 'same', hashVerified: true });
});

test('existing hashless binding for the same pdf and target -> same with hashVerified false, never new', async () => {
  const r = await run([row({ id: 'm1', pdfSha256: null })]);
  assert.deepEqual(r, { kind: 'same', hashVerified: false });
});

test('more than 20 hashless artifacts -> exact count, first 20 ids, truncated', async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 25; i++) {
    rows.push(row({ id: `h${i}`, pdfId: `pdf-h${i}`, pdfSha256: null, targetKey: `bl-h${i}`, issueId: `issue-h${i}` }));
  }
  const r = await run(rows);
  assert.equal(r.kind, 'incomplete');
  const inc = r as { unknownCount: number; unknownPdfIds: string[]; truncated: boolean };
  assert.equal(inc.unknownCount, 25);
  assert.equal(inc.unknownPdfIds.length, 20);
  assert.equal(inc.truncated, true);
  assert.equal(new Set(inc.unknownPdfIds).size, 20);
  for (const id of inc.unknownPdfIds) assert.ok(rows.some((x) => x.pdfId === id));
});

test('same pdf/hash/target but different issueId -> conflict', async () => {
  const r = await run([row({ id: 'm1', issueId: 'issue-2' })]);
  assert.equal(r.kind, 'conflict');
  assert.match((r as { reason: string }).reason, /issue/i);
});

test('same pdf/hash/target key but different targetType -> conflict', async () => {
  const r = await run([row({ id: 'm1', targetType: 'ledger-line' })]);
  assert.equal(r.kind, 'conflict');
  assert.match((r as { reason: string }).reason, /type|target/i);
});

test('empty or malformed hash rejects without touching the store', async () => {
  for (const bad of ['', 'not-a-hash', 'A'.repeat(63), 'zz'.repeat(32)]) {
    const r = await run([], { ...baseInput, pdfSha256: bad });
    assert.equal(r.kind, 'conflict', `expected conflict for ${JSON.stringify(bad)}`);
    assert.match((r as { reason: string }).reason, /hash/i);
  }
});

test('guard never invokes mutation methods or raw SQL across all paths', async () => {
  const scenarios: Row[][] = [
    [],
    [row({ id: 'm1' })],
    [row({ id: 'm1', targetKey: 'bl-x' })],
    [row({ id: 'm1', pdfSha256: null })],
    [row({ id: 'm9', pdfId: 'pdf-9', pdfSha256: null, targetKey: 'bl-9', issueId: 'issue-9' })],
  ];
  for (const rows of scenarios) {
    const { tx, rawCalls } = makeTx(rows);
    await assert.doesNotReject(() => inspectMemoContentBinding(tx as never, baseInput));
    assert.equal(rawCalls.length, 0);
  }
});
test('positive cross-file content reuse overrides an exact old hashless repeat',async()=>{
 const result=await run([row({id:'old',pdfSha256:null}),row({id:'other',pdfId:'pdf-other',targetKey:'other-target',issueId:'other-issue'})]);assert.equal(result.kind,'conflict');
});
test('malformed global unknown count cannot authorize a new binding',async()=>{
 for(const count of [NaN,-1,1.5,Number.MAX_SAFE_INTEGER+1]){const {tx}=makeTx([]);tx.receiptMemoArtifact.count=async()=>count;assert.equal((await inspectMemoContentBinding(tx,baseInput)).kind,'conflict');}
});
