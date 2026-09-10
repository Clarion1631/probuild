import { createHash } from 'node:crypto';
import type { ParsedRefreshBody, ObservationSnapshot, RefreshApplyContext, RefreshEvidence } from '@/lib/bank-source-refresh';
import type { BankRegisterResult, BankRegisterRow } from '@/lib/qbo-bank-register';

// Policy: refresh ONLY the observation descriptor for a QBO Deposit that is fully linked to exactly one
// Payment which is fully applied to exactly one Invoice. Anything else is blocked with a static reason.
export const DEPOSIT_REFRESH_POLICY = 'qbo-linked-deposit-descriptor/1';
export const BUDGET_MS = 90_000;
const GL_MAX_ROWS = 2000;
const ID_RE = /^\d{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DepositRefreshRollback extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'DepositRefreshRollback'; }
}

// Safe projections: only the fields the policy needs. Raw source objects are never stored or spread.
export type DepositProjection = {
  id: string; txnDate: string; syncToken: string; createTime: string; lastUpdatedTime: string; currency: 'USD';
  totalCents: number; depositToAccountId: string; privateNote: string;
  line: { amountCents: number; linkedTxnId: string; linkedTxnType: 'Payment'; linkedTxnLineId: string; paymentMethodId: string | null };
};
export type PaymentProjection = {
  id: string; txnDate: string; syncToken: string; createTime: string; lastUpdatedTime: string; currency: 'USD';
  totalCents: number; unappliedCents: number; customerId: string; customerName: string; depositToAccountId: string;
  paymentMethodId: string | null; topLinkedTxnId: string; topLinkedTxnType: 'Deposit';
  line: { amountCents: number; invoiceId: string; linkedTxnType: 'Invoice' };
};
export type DescriptorState = { postedDate: string; rawDescriptor: string };
export type DepositPlan = {
  version: typeof DEPOSIT_REFRESH_POLICY; qbTxnId: string; noop: boolean; amountCents: number; postedDate: string;
  basis: 'legacy-descriptor-only'; warnings: readonly ['HISTORICAL_FIELD_HISTORY_MISSING']; accountId: string;
  old: DescriptorState; next: DescriptorState; gl: BankRegisterRow; deposit: DepositProjection;
  payment: PaymentProjection; local: ObservationSnapshot; digest: string;
};
type Res<T> = { ok: true; value: T } | { ok: false; reason: string };
const fail = (reason: string) => ({ ok: false as const, reason });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const normWs = (s: string) => s.trim().replace(/\s+/g, ' ');
function cents(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const c = Math.round(v * 100);
  return Number.isSafeInteger(c) && Math.abs(v * 100 - c) < 1e-6 ? c : null;
}
const numId = (v: unknown) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const refId = (v: unknown) => (isObj(v) ? numId(v.value) : null);
const isoTime = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const one = (v: unknown): unknown => (Array.isArray(v) && v.length === 1 ? v[0] : null);
function link(v: unknown, type: string): string | null {
  const l = one(v);
  return isObj(l) && l.TxnType === type ? numId(l.TxnId) : null;
}
function canon(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}
export const digestOf = (v: unknown) => createHash('sha256').update(canon(v)).digest('hex');

type Header = Pick<DepositProjection, 'id' | 'txnDate' | 'syncToken' | 'createTime' | 'lastUpdatedTime' | 'currency' | 'totalCents'>;
function header(raw: unknown, kind: 'deposit' | 'payment'): Res<Header> {
  if (!isObj(raw)) return fail(`${kind}_malformed`);
  const id = numId(raw.Id);
  const txnDate = typeof raw.TxnDate === 'string' && DATE_RE.test(raw.TxnDate) && !Number.isNaN(Date.parse(raw.TxnDate)) && new Date(raw.TxnDate).toISOString().slice(0, 10) === raw.TxnDate ? raw.TxnDate : null;
  const syncToken = typeof raw.SyncToken === 'string' && /^\d{1,9}$/.test(raw.SyncToken) ? raw.SyncToken : null;
  const md = isObj(raw.MetaData) ? raw.MetaData : {};
  const createTime = isoTime(md.CreateTime), lastUpdatedTime = isoTime(md.LastUpdatedTime);
  const totalCents = cents(raw.TotalAmt);
  if (!id || !txnDate || syncToken === null || totalCents === null || totalCents <= 0) return fail(`${kind}_malformed`);
  if (!createTime || !lastUpdatedTime || Date.parse(createTime) > Date.parse(lastUpdatedTime)) return fail(`${kind}_metadata_invalid`);
  if (!isObj(raw.CurrencyRef) || raw.CurrencyRef.value !== 'USD') return fail(`${kind}_currency_unsupported`);
  if (raw.ExchangeRate !== undefined && raw.ExchangeRate !== 1) return fail(`${kind}_exchange_rate_unsupported`);
  return { ok: true, value: { id, txnDate, syncToken, createTime, lastUpdatedTime, currency: 'USD', totalCents } };
}
export function projectDeposit(raw: unknown): Res<DepositProjection> {
  const h = header(raw, 'deposit');
  if (!h.ok) return h;
  const r = raw as Record<string, unknown>;
  if (r.CashBack !== undefined) return fail('deposit_cashback_unsupported');
  const depositToAccountId = refId(r.DepositToAccountRef);
  if (!depositToAccountId) return fail('deposit_account_malformed');
  if (typeof r.PrivateNote !== 'string' || !normWs(r.PrivateNote) || r.PrivateNote.length > 4000) return fail('deposit_note_missing');
  const ln = one(r.Line);
  if (!isObj(ln)) return fail('deposit_line_count_unsupported');
  const amountCents = cents(ln.Amount), linkedTxnId = link(ln.LinkedTxn, 'Payment');
  if (amountCents === null || !linkedTxnId) return fail('deposit_line_link_unsupported');
  const sourceLink = one(ln.LinkedTxn);
  if (!isObj(sourceLink) || sourceLink.TxnLineId !== '0') return fail('deposit_link_line_unsupported');
  if (r.TxnTaxDetail !== undefined && (!isObj(r.TxnTaxDetail) || Object.keys(r.TxnTaxDetail).length)) return fail('deposit_tax_unsupported');
  if (!isObj(ln.DepositLineDetail)) return fail('deposit_detail_missing');
  const det = ln.DepositLineDetail;
  const paymentMethodId = det.PaymentMethodRef === undefined ? null : refId(det.PaymentMethodRef);
  if (det.PaymentMethodRef !== undefined && !paymentMethodId) return fail('deposit_payment_method_malformed');
  return { ok: true, value: { ...h.value, depositToAccountId, privateNote: r.PrivateNote,
    line: { amountCents, linkedTxnId, linkedTxnType: 'Payment', linkedTxnLineId: '0', paymentMethodId } } };
}
export function projectPayment(raw: unknown): Res<PaymentProjection> {
  const h = header(raw, 'payment');
  if (!h.ok) return h;
  const r = raw as Record<string, unknown>;
  const unappliedCents = cents(r.UnappliedAmt);
  const customerId = refId(r.CustomerRef);
  const customerName = isObj(r.CustomerRef) && typeof r.CustomerRef.name === 'string' ? r.CustomerRef.name : null;
  const depositToAccountId = refId(r.DepositToAccountRef);
  if (unappliedCents === null || !customerId || !customerName || !normWs(customerName) || customerName.length > 1000 || !depositToAccountId) return fail('payment_malformed');
  const paymentMethodId = r.PaymentMethodRef === undefined ? null : refId(r.PaymentMethodRef);
  if (r.PaymentMethodRef !== undefined && !paymentMethodId) return fail('payment_method_malformed');
  const topLinkedTxnId = link(r.LinkedTxn, 'Deposit');
  if (!topLinkedTxnId) return fail('payment_link_unsupported');
  const ln = one(r.Line);
  if (!isObj(ln)) return fail('payment_line_count_unsupported');
  const amountCents = cents(ln.Amount), invoiceId = link(ln.LinkedTxn, 'Invoice');
  if (amountCents === null || !invoiceId) return fail('payment_line_link_unsupported');
  return { ok: true, value: { ...h.value, unappliedCents, customerId, customerName, depositToAccountId, paymentMethodId,
    topLinkedTxnId, topLinkedTxnType: 'Deposit', line: { amountCents, invoiceId, linkedTxnType: 'Invoice' } } };
}

export type IngestLineLike = { postedDate: string; rawDescriptor: string; amountCents: number; checkNumber?: string | null };
export type PlanInput = {
  qbTxnId: string; register: BankRegisterResult; depositRaw: unknown; paymentRaw: unknown; evidence: RefreshEvidence;
  toIngestLine: (row: BankRegisterRow) => IngestLineLike | null;
};
// Pure: recomputed from scratch on every dryrun and again inside the apply transaction.
export function planDepositRefresh(i: PlanInput): Res<DepositPlan> {
  const { register } = i;
  if (register.stale) return fail('register_stale');
  if (!register.clearedProbeOk) return fail('register_clearance_failed');
  if (register.rows.length > GL_MAX_ROWS) return fail('register_overflow');
  const glRows = register.rows.filter((r) => r.qbTxnId === i.qbTxnId);
  if (glRows.length !== 1) return fail(glRows.length ? 'gl_row_ambiguous' : 'gl_row_missing');
  const gl = glRows[0];
  if (gl.qbType !== 'Deposit') return fail('gl_row_not_deposit');
  const d = projectDeposit(i.depositRaw);
  if (!d.ok) return d;
  const p = projectPayment(i.paymentRaw);
  if (!p.ok) return p;
  const dep = d.value, pay = p.value, ev = i.evidence;
  if (ev.bankLines.length || ev.expenses.length || ev.intakes.length) return fail('local_evidence_conflict');
  if (ev.observations.length !== 1) return fail(ev.observations.length ? 'local_observation_ambiguous' : 'local_observation_missing');
  const obs = ev.observations[0];
  if (obs.bankLineId !== null) return fail('local_observation_linked');
  if (obs.checkNumber !== null) return fail('local_check_unsupported');
  if (obs.postedDate !== gl.date) return fail('local_date_mismatch');
  const amt = gl.amountCents;
  if (!Number.isSafeInteger(amt) || amt <= 0) return fail('amount_invalid');
  if (gl.docNum) return fail('gl_check_unsupported');
  if ([obs.amountCents, dep.totalCents, dep.line.amountCents, pay.totalCents, pay.line.amountCents].some((c) => c !== amt)) return fail('amount_mismatch');
  if (dep.id !== i.qbTxnId) return fail('deposit_id_mismatch');
  if (dep.txnDate !== gl.date) return fail('deposit_date_mismatch');
  if (dep.depositToAccountId !== register.accountId) return fail('deposit_account_mismatch');
  if (dep.line.linkedTxnId !== pay.id) return fail('payment_id_mismatch');
  if (pay.topLinkedTxnId !== dep.id) return fail('payment_backlink_mismatch');
  if (pay.unappliedCents !== 0) return fail('payment_unapplied');
  if (pay.txnDate > dep.txnDate) return fail('payment_date_after_deposit');
  if (!dep.line.paymentMethodId || !pay.paymentMethodId || dep.line.paymentMethodId !== pay.paymentMethodId) return fail('payment_method_mismatch');
  if (typeof gl.name !== 'string' || normWs(pay.customerName) !== normWs(gl.name)) return fail('party_mismatch');
  if (typeof gl.memo !== 'string' || normWs(dep.privateNote) !== normWs(gl.memo)) return fail('memo_mismatch');
  const ing = i.toIngestLine(gl);
  if (!ing || ing.checkNumber || ing.postedDate !== gl.date || ing.amountCents !== amt) return fail('ingest_line_mismatch');
  const next: DescriptorState = { postedDate: obs.postedDate, rawDescriptor: ing.rawDescriptor };
  const noop = obs.rawDescriptor === next.rawDescriptor;
  if (!noop && normWs(obs.rawDescriptor) !== `${normWs(gl.name)} Deposit`) return fail('old_descriptor_unsupported');
  const body = { version: DEPOSIT_REFRESH_POLICY, qbTxnId: i.qbTxnId, noop, amountCents: amt, postedDate: obs.postedDate,
    basis: 'legacy-descriptor-only', warnings: ['HISTORICAL_FIELD_HISTORY_MISSING'], accountId: register.accountId,
    old: { postedDate: obs.postedDate, rawDescriptor: obs.rawDescriptor }, next, gl, deposit: dep, payment: pay, local: obs } as const;
  return { ok: true, value: { ...body, digest: digestOf(body) } };
}

// GET-only readers with hardcoded typed paths, numeric ids and a per-call 10s deadline.
export function createQboSourceReaders<T, D>(io: {
  qbFetch: (path: string, tokens: T, init: { method: 'GET'; qbDeadline: D }) => Promise<Response>;
  getTokens: (deadline: D) => Promise<T>; createDeadline: (ms: number) => D;
}) {
  const read = (kind: 'deposit' | 'payment') => async (id: string): Promise<unknown> => {
    if (!ID_RE.test(id)) throw new Error('invalid_id');
    const deadline = io.createDeadline(10_000);
    const res = await io.qbFetch(`/${kind}/${id}`, await io.getTokens(deadline), { method: 'GET', qbDeadline: deadline });
    if (!res.ok) throw new Error('source_fetch_failed');
    const body: unknown = await res.json();
    return isObj(body) ? body[kind === 'deposit' ? 'Deposit' : 'Payment'] : undefined;
  };
  return { fetchDeposit: read('deposit'), fetchPayment: read('payment') };
}

export type DepositRefreshDeps = {
  authorize(req: Request): boolean | Promise<boolean>;
  readBody(req: Request): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  parseBody(text: string): ParsedRefreshBody;
  toIngestLine: PlanInput['toIngestLine'];
  readRegister(): Promise<BankRegisterResult>;
  fetchDeposit(id: string): Promise<unknown>;
  fetchPayment(id: string): Promise<unknown>;
  readEvidence(id: string): Promise<RefreshEvidence>;
  apply<T>(id: string, body: (ctx: RefreshApplyContext) => Promise<T>, remainingMs: number): Promise<T>;
  now?: () => number;
};
type Outcome = { result: 'applied' | 'noop' | 'blocked'; reason?: string };
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export function createDepositSourceRefreshHandler(deps: DepositRefreshDeps) {
  return async (req: Request): Promise<Response> => {
    const now = deps.now ?? Date.now, started = now();
    const inBudget = () => now() - started <= BUDGET_MS;
    if (!(await deps.authorize(req))) return json(401, { ok: false, reason: 'unauthorized' });
    if (new URL(req.url).search) return json(400, { ok: false, reason: 'query_unsupported' });
    let parsed: ParsedRefreshBody;
    try { const body = await deps.readBody(req); if (!body.ok) return json(400, { ok: false, reason: body.reason }); parsed = deps.parseBody(body.text); } catch { return json(400, { ok: false, reason: 'invalid_body' }); }
    if (!parsed.ok) return json(400, { ok: false, reason: parsed.reason });
    if (parsed.items.length !== 1) return json(400, { ok: false, reason: 'single_item_required' });
    const mode = parsed.mode;
    const { qbTxnId, expectedDigest } = parsed.items[0];
    if (typeof qbTxnId !== 'string' || !ID_RE.test(qbTxnId)) return json(400, { ok: false, reason: 'invalid_txn_id' });
    if (mode === 'apply' && typeof expectedDigest !== 'string') return json(400, { ok: false, reason: 'expected_digest_required' });
    const blocked = (status: number, reason: string) => json(status, { ok: false, mode, qbTxnId, result: 'blocked', reason });
    try {
      if (!inBudget()) return json(503, { ok: false, mode, qbTxnId, reason: 'budget_exceeded' });
      const register = await deps.readRegister();
      if (!inBudget()) return blocked(503, 'budget_exceeded');
      if (register.stale || !register.clearedProbeOk || register.rows.length > GL_MAX_ROWS) return blocked(200, 'register_unavailable');
      const rows = register.rows.filter(r => r.qbTxnId === qbTxnId);
      if (rows.length !== 1 || rows[0].qbType !== 'Deposit') return blocked(200, 'gl_deposit_not_unique');
      const depositRaw = await deps.fetchDeposit(qbTxnId);
      const head = projectDeposit(depositRaw);
      if (!head.ok) return blocked(200, head.reason);
      if (head.value.id !== qbTxnId || head.value.depositToAccountId !== register.accountId) return blocked(200, 'deposit_identity_mismatch');
      if (!inBudget()) return blocked(503, 'budget_exceeded');
      const paymentRaw = await deps.fetchPayment(head.value.line.linkedTxnId);
      if (!inBudget()) return blocked(503, 'budget_exceeded');
      const fetchedAt = new Date(now()).toISOString();
      const base = { qbTxnId, register, depositRaw, paymentRaw, toIngestLine: deps.toIngestLine };
      const planned = planDepositRefresh({ ...base, evidence: await deps.readEvidence(qbTxnId) });
      if (!inBudget()) return blocked(503, 'budget_exceeded');
      if (!planned.ok) return blocked(200, planned.reason);
      const plan = planned.value;
      if (expectedDigest !== null && expectedDigest !== plan.digest) return blocked(409, 'digest_mismatch');
      if (mode === 'dry-run') return json(200, { ok: true, mode, qbTxnId, result: plan.noop ? 'noop' : 'planned', digest: plan.digest, plan });
      if (!inBudget()) return json(503, { ok: false, mode, qbTxnId, reason: 'budget_exceeded' });
      const out = await deps.apply<Outcome>(qbTxnId, async (ctx) => {
        if (!inBudget()) throw new DepositRefreshRollback('budget_exceeded');
        const re = planDepositRefresh({ ...base, evidence: await ctx.readEvidence() });
        if (!re.ok) return { result: 'blocked', reason: re.reason };
        const fresh = re.value;
        if (fresh.digest !== expectedDigest) return { result: 'blocked', reason: 'digest_mismatch' };
        if (fresh.noop) return { result: 'noop' };
        if (!inBudget()) throw new DepositRefreshRollback('budget_exceeded');
        await ctx.bumpEpoch();
        if (!inBudget()) throw new DepositRefreshRollback('budget_exceeded');
        if ((await ctx.updateObservation(fresh.local, fresh.next)) !== 1) throw new DepositRefreshRollback('cas_conflict');
        await ctx.appendAudit(fresh.local.id, {
          action: 'QBO_SOURCE_REFRESH', sourceEntityType: 'Deposit', policyVersion: DEPOSIT_REFRESH_POLICY, qbTxnId,
          old: fresh.old, next: fresh.next, deposit: fresh.deposit, payment: fresh.payment, gl: fresh.gl, local: fresh.local,
          digest: fresh.digest, fetchedAt, registerCapturedAt: register.fetchedAt, warnings: fresh.warnings, basis: fresh.basis,
        });
        return { result: 'applied' };
      }, Math.max(1, BUDGET_MS - (now() - started)));
      return json(out.result === 'blocked' ? 409 : 200, { ok: out.result !== 'blocked', mode, qbTxnId, ...out, digest: plan.digest });
    } catch (e) {
      if (e instanceof DepositRefreshRollback) return blocked(409, e.reason);
      return json(500, { ok: false, mode, qbTxnId, result: 'failed', reason: 'internal_failure' });
    }
  };
}
