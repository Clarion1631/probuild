/**
 * On-demand missing-receipt request for a SINGLE configured target.
 *
 * This is a PURE, INJECTABLE service. It does not import Prisma, fetch, or the
 * webhook URL. Every side effect — reading the snapshot, claiming, posting,
 * finishing — crosses an injected `OnDemandDeps` boundary. The Prisma adapter
 * (`receipt-on-demand-store.ts`) and the HTTP route are thin shells over this
 * module.
 *
 * WHAT THIS IS NOT
 *
 *   * Not the per-owner Chat digest. `CARD_OWNERS_ASKED` (`["CJ","Richard"]`)
 *     is deliberately untouched; this path is Justin-only, first-version,
 *     opt-in by an exact private allowlist.
 *   * Not a global reminder. There is no scheduled owner change, no reminder
 *     flag, no per-run budget beyond the one claim.
 *   * Not a retry surface. `unknown` is terminal for automatic retry; the row
 *     is parked UNCERTAIN for a human.
 *
 * THE CONTRACT THE TESTS AND THE ADAPTER BOTH DEPEND ON
 *
 *   * `prepare` performs NO writes: it reads the snapshot once and returns the
 *     exact card preview (item + owner + ownerUser) plus a stable digest.
 *   * `apply` re-reads the snapshot, recomputes the digest, and only then
 *     asks the store to claim. The caller NEVER supplies vendor/date/amount/
 *     owner — those come from the snapshot the service read for itself.
 *   * The digest EXCLUDES observation timestamps (the service's `now()`), so
 *     an unchanged source reread to a fresh clock still matches.
 *   * A thrown post is converted to a durable `unknown`, and the finish is
 *     invoked with that `unknown` result — never with a fabricated success.
 *   * A `finish` that fails to record is reported as `unknown`, not `posted`.
 */
import { createHash } from "node:crypto";
import {
    CARD_POST_TIMEOUT_MS,
    buildCardFromItems,
    centsToAmount,
    pacificDate,
    requestIdFor,
    type CardItem,
    type OwnerCard,
} from "./receipt-request-cards";

// ── Public types ────────────────────────────────────────────────────────────

/** The exact owner this first version is allowed to ask. Never a caller field. */
export const ON_DEMAND_OWNER = "Justin" as const;

/** `RECEIPT_ON_DEMAND_TARGETS` is a JSON array, max this many entries. */
export const ON_DEMAND_MAX_TARGETS = 1;

/** Overall wall clock for one invocation; delivery must finish inside it. */
export const ON_DEMAND_DEADLINE_MS = 50_000;

/** Reserve for the post/finish after the claim commits. */
export const ON_DEMAND_DELIVERY_RESERVE_MS = CARD_POST_TIMEOUT_MS + 6_000 + 3_000;

/** Caller body cap, enforced at the route boundary before decode. */
export const ON_DEMAND_MAX_BODY_BYTES = 2_048;

export interface OnDemandInput {
    action: "prepare" | "apply";
    /** BankLine id — the single target. Must equal the snapshot's own id. */
    bankLineId: string;
    /** Required for `apply`; produced by `prepare`. */
    digest?: string;
}

/**
 * The item fields that travel with the card. Immutable for the life of the
 * claim: `apply` never accepts caller overrides for any of them.
 */
export interface OnDemandItem {
    issueId: string;
    targetKey: string;
    fingerprint: string;
    /** YYYY-MM-DD posted date. */
    date: string;
    vendor: string;
    /** POSITIVE cents; `amount` is the display form. */
    cents: number;
    amount: string;
    cardTail: string | null;
}

export interface OnDemandEpochs {
    ledger: string;
    evidence: string;
}

/** Snapshot the store is asked to read; every field is source truth. */
export interface PreparedSnapshot {
    bankLineId: string;
    account: string;                 // must be "WTB-0723"
    sourceOfRecord: string;          // must be "STATEMENT"
    /** POSITIVE debit cents — the amount the statement debited. */
    debitCents: number;
    postedDate: string;              // YYYY-MM-DD
    rawDescriptor: string;
    updatedAt: string;               // Persisted source version, included in digest.
    sourceRevision?: string;         // Adapter's complete source/settings fence.
    item: OnDemandItem;
    owner: string;                   // must equal ON_DEMAND_OWNER
    ownerUser: string;               // must be "users/..." from RECEIPT_OWNER_CHAT_USERS
    issueVersion: number;            // positive, bounded safe integer
    epochs: OnDemandEpochs;
    policy: string;                  // exact receiptRecognitionPolicy string
    sweep: {
        certified: boolean;
        fresh: boolean;
        evidenceEligible: boolean;
    };
    flags: {
        acknowledged: boolean;
        resolved: boolean;
        sourceFound: boolean;
    };
}

/** What the store returns from the claim transaction. */
export type ClaimResult =
    | { kind: "claimed"; claimId: string; claimToken: string }
    /** `already-posted`: the exact same single POSTED card exists; return the real thread. */
    | { kind: "already-posted"; threadName: string; messageName: string }
    /** Anything else — lost race, existing different card, POSTING, UNCERTAIN, collision. */
    | { kind: "blocked"; reason: string };

/** What `finish` records. */
export type FinishResult =
    | { kind: "delivered"; threadName: string; messageName: string }
    | { kind: "uncertain"; reason: string };

/**
 * Outcome surfaced to the route. `blocked` is not an error: it is a deliberate
 * refusal. `unknown` means the card may be live; never auto-retry.
 */
export type OnDemandResult =
    | { kind: "ready"; digest: string; card: OwnerCardView; reason?: undefined }
    | { kind: "blocked"; reason: string }
    | { kind: "incomplete"; reason: string }
    | { kind: "posted"; threadName: string; messageName: string }
    | { kind: "unknown"; reason: string };

/** The card preview handed back to the operator — no signature, no job fields. */
export interface OwnerCardView {
    owner: string;
    requestId: string;
    date: string;
    items: CardItem[];
}

export interface OnDemandDeps {
    /** Read-only retry lookup; never creates or changes an association. */
    lookupPosted?(bankLineId: string): Promise<Extract<ClaimResult, { kind: 'already-posted' }> | null>;
    /** Read the CURRENT canonical source + issue + config for one target. Not a cache. */
    readSnapshot(bankLineId: string): Promise<PreparedSnapshot>;
    /**
     * Claim in the store's own transaction. The store MUST re-read the snapshot
     * under locks, compare to `digest`, and either create a POSTING row with
     * the delivery reservation or return `blocked` / `already-posted`.
     */
    claim(snapshot: PreparedSnapshot, digest: string): Promise<ClaimResult>;
    /**
     * Post the card. `webhookUrl` is supplied by the caller (configured), never
     * by this service and never by the request. Throws are converted to unknown.
     */
    post(card: OwnerCard, webhookUrl: string, timeoutMs: number): Promise<FinishResult | { kind: "unknown"; reason: string }>;
    /** Record the outcome with the same claim token; CAS by id + token + POSTING. */
    finish(claim: Extract<ClaimResult, { kind: "claimed" }>, result: FinishResult): Promise<{ kind: "recorded" } | { kind: "failed"; reason: string }>;
    /** The configured webhook URL. Never comes from the request. */
    webhookUrl: string;
    /** Injectable clock; defaults to `() => new Date()`. */
    now?: () => Date;
}

export interface OnDemandOptions {
    /** The exact allowlist. Missing or empty = deny everything. */
    allowedTargets?: readonly string[];
    /** Injectable clock overridden by the option (tests). */
    now?: () => Date;
}

// ── Input validation ────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const ISSUE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_SHAPE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[0-9a-z]{24})$/;
const YMD = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const OWNER_USER = /^users\/[A-Za-z0-9_-]+$/;
const PORT: Set<string> = new Set(["bankLineId", "action", "digest"]);
export function validDeliveryIdentity(thread: unknown, message: unknown): boolean {
    if (typeof thread !== 'string' || typeof message !== 'string') return false;
    const t = /^spaces\/([A-Za-z0-9_-]+)\/threads\/[A-Za-z0-9_.-]+$/.exec(thread);
    const m = /^spaces\/([A-Za-z0-9_-]+)\/messages\/[A-Za-z0-9_.-]+$/.exec(message);
    return !!t && !!m && t[1] === m[1];
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidDate(v: string): boolean {
    if (!YMD.test(v)) return false;
    const d = new Date(v + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function isPosSafeInt(v: unknown): v is number {
    return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/**
 * Strict decode. Unknown keys are a refusal — the route never has to trust a
 * caller to omit fields it should not send.
 */
export function decodeOnDemandInput(raw: unknown): OnDemandInput | null {
    if (!isObj(raw)) return null;
    for (const k of Object.keys(raw)) if (!PORT.has(k)) return null;
    const { action, bankLineId, digest } = raw;
    if (action !== "prepare" && action !== "apply") return null;
    if (typeof bankLineId !== "string" || !TARGET_SHAPE.test(bankLineId)) return null;
    if (action === "prepare") {
        if (digest !== undefined) return null;
        return { action, bankLineId };
    }
    if (typeof digest !== "string" || !HEX64.test(digest)) return null;
    return { action, bankLineId, digest };
}

/** Absent, non-array, or empty means "deny everything". */
export function parseAllowedTargets(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length !== 1) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of raw) {
        if (typeof v !== "string" || !TARGET_SHAPE.test(v)) return [];
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
        if (out.length >= ON_DEMAND_MAX_TARGETS) break;
    }
    return out;
}

// ── Snapshot validation ─────────────────────────────────────────────────────

export interface ValidationIssue {
    field: string;
    reason: string;
}

/**
 * Structural + policy check. Every reason returned here is a HARD block:
 * there is no "degraded" path. The reasons are safe to log — they name fields,
 * never values.
 */
export function validateSnapshot(
    snapshot: PreparedSnapshot,
    expectedBankLineId: string,
    allowedTargets: readonly string[],
    now: Date,
): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const push = (field: string, reason: string) => issues.push({ field, reason });

    if (snapshot.bankLineId !== expectedBankLineId) push("bankLineId", "mismatch");
    if (!allowedTargets.includes(snapshot.bankLineId)) push("bankLineId", "not-allowed");

    if (snapshot.account !== "WTB-0723") push("account", "not-canonical");
    if (snapshot.sourceOfRecord !== "STATEMENT") push("sourceOfRecord", "not-canonical");
    if (!isPosSafeInt(snapshot.debitCents)) push("debitCents", "not-positive-integer");

    if (!isValidDate(snapshot.postedDate)) push("postedDate", "invalid");
    if (typeof snapshot.rawDescriptor !== "string" || snapshot.rawDescriptor.length === 0) push("rawDescriptor", "empty");
    if (typeof snapshot.updatedAt !== "string" || snapshot.updatedAt.length === 0) push("updatedAt", "empty");

    const it = snapshot.item;
    if (!isObj(it)) {
        push("item", "missing");
    } else {
        if (it.targetKey !== snapshot.bankLineId) push("item.targetKey", "not-equal-bankLineId");
        if (it.fingerprint !== `pb-${snapshot.bankLineId}`) push("item.fingerprint", "not-pb-target");
        if (!isValidDate(it.date)) push("item.date", "invalid");
        if (it.date !== snapshot.postedDate) push("item.date", "not-equal-postedDate");
        if (typeof it.vendor !== "string") push("item.vendor", "not-string");
        if (!isPosSafeInt(it.cents)) push("item.cents", "not-positive-integer");
        if (it.cents !== snapshot.debitCents) push("item.cents", "not-equal-debitCents");
        if (typeof it.amount !== "string" || it.amount !== centsToAmount(snapshot.debitCents)) push("item.amount", "not-equal-display");
        if (!ISSUE_SHAPE.test(it.issueId)) push("item.issueId", "invalid");
        if (it.cardTail !== null && !/^[0-9]{4}$/.test(it.cardTail ?? "")) push("item.cardTail", "invalid");
    }

    if (snapshot.owner !== ON_DEMAND_OWNER) push("owner", "not-on-demand-owner");
    if (typeof snapshot.ownerUser !== "string" || !OWNER_USER.test(snapshot.ownerUser)) push("ownerUser", "invalid");
    if (!isPosSafeInt(snapshot.issueVersion) || snapshot.issueVersion > Number.MAX_SAFE_INTEGER) push("issueVersion", "invalid");

    if (!snapshot.epochs || !/^\d+$/.test(snapshot.epochs.ledger) || !/^\d+$/.test(snapshot.epochs.evidence)) {
        push("epochs", "invalid");
    }
    if (typeof snapshot.policy !== "string" || snapshot.policy.length === 0) push("policy", "empty");
    if (!snapshot.sweep || snapshot.sweep.certified !== true) push("sweep", "not-certified");
    if (snapshot.sweep && snapshot.sweep.fresh !== true) push("sweep", "stale");
    if (snapshot.sweep && snapshot.sweep.evidenceEligible !== true) push("sweep", "not-evidence-eligible");

    if (snapshot.flags) {
        if (snapshot.flags.acknowledged !== false) push("flags.acknowledged", "not-false");
        if (snapshot.flags.resolved !== false) push("flags.resolved", "not-false");
        if (snapshot.flags.sourceFound !== false) push("flags.sourceFound", "not-false");
    } else {
        push("flags", "missing");
    }

    // `now` is accepted so a caller can assert time-of-day gating later; today
    // the only check is that it is a real instant.
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) push("now", "invalid");
    return issues;
}

// ── Digest ──────────────────────────────────────────────────────────────────

/**
 * Stable content digest. INCLUDES everything that changes what the card says
 * or who is asked, including persisted source updatedAt. Only the observation
 * clock is excluded, apart from the Pacific request day.
 *
 * Reused by the store at claim time: the store recomputes it from the exact
 * snapshot it read under locks and rejects the claim if it differs from the
 * digest the caller supplied. That is the immutability guarantee.
 */
export function computeOnDemandDigest(snapshot: PreparedSnapshot, now: Date): string {
    const payload = [
        "v1",
        pacificDate(now),
        snapshot.bankLineId,
        snapshot.account,
        snapshot.sourceOfRecord,
        String(snapshot.debitCents),
        snapshot.postedDate,
        snapshot.rawDescriptor,
        snapshot.updatedAt,
        snapshot.sourceRevision ?? '',
        snapshot.item.issueId,
        snapshot.item.targetKey,
        snapshot.item.fingerprint,
        snapshot.item.date,
        snapshot.item.vendor,
        String(snapshot.item.cents),
        snapshot.item.amount,
        snapshot.item.cardTail ?? "-",
        snapshot.owner,
        snapshot.ownerUser,
        String(snapshot.issueVersion),
        snapshot.epochs.ledger,
        snapshot.epochs.evidence,
        snapshot.policy,
        snapshot.sweep.certified ? "1" : "0",
        snapshot.sweep.fresh ? "1" : "0",
        snapshot.sweep.evidenceEligible ? "1" : "0",
        snapshot.flags.acknowledged ? "1" : "0",
        snapshot.flags.resolved ? "1" : "0",
        snapshot.flags.sourceFound ? "1" : "0",
    ];
    return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

// ── Card build ──────────────────────────────────────────────────────────────

/** Card preview: no signature, no job fields, no per-item extras. */
export function toOwnerCardView(snapshot: PreparedSnapshot, now: Date): OwnerCardView {
    const day = pacificDate(now);
    const item: CardItem = {
        n: 1,
        fingerprint: snapshot.item.fingerprint,
        date: snapshot.item.date,
        vendor: snapshot.item.vendor,
        cents: snapshot.item.cents,
        amount: snapshot.item.amount,
        cardTail: snapshot.item.cardTail,
        issueId: snapshot.item.issueId,
        targetKey: snapshot.item.targetKey,
    };
    return {
        owner: ON_DEMAND_OWNER,
        requestId: requestIdFor(ON_DEMAND_OWNER, day),
        date: day,
        items: [item],
    };
}

/**
 * The exact payload handed to `post`. Text is intentionally minimal — the
 * point of this path is a single human-visible ask with a clear reply, not the
 * per-owner digest.
 */
export function toOwnerCard(snapshot: PreparedSnapshot, now: Date): OwnerCard {
    const view = toOwnerCardView(snapshot, now);
    return buildCardFromItems(view.owner, view.date, view.items, 0, true);
}

// ── Run ─────────────────────────────────────────────────────────────────────

function blocked(reason: string): OnDemandResult {
    return { kind: "blocked", reason };
}

async function prepareOnce(
    input: OnDemandInput,
    deps: OnDemandDeps,
    options: OnDemandOptions,
    now: () => Date,
): Promise<OnDemandResult> {
    const allowed = options.allowedTargets ?? [];
    if (!allowed.includes(input.bankLineId)) return blocked("target-not-allowed");

    let snapshot: PreparedSnapshot;
    try {
        snapshot = await deps.readSnapshot(input.bankLineId);
    } catch {
        return { kind: 'incomplete', reason: 'snapshot-read-failed' };
    }

    const instant = now();
    const issues = validateSnapshot(snapshot, input.bankLineId, allowed, instant);
    if (issues.length > 0) return blocked(`snapshot-invalid:${issues[0].field}:${issues[0].reason}`);

    const digest = computeOnDemandDigest(snapshot, instant);
    return { kind: "ready", digest, card: toOwnerCardView(snapshot, instant) };
}

async function applyOnce(
    input: OnDemandInput,
    deps: OnDemandDeps,
    options: OnDemandOptions,
    now: () => Date,
): Promise<OnDemandResult> {
    const startedAt = now().getTime();
    const allowed = options.allowedTargets ?? [];
    if (!allowed.includes(input.bankLineId)) return blocked("target-not-allowed");
    if (typeof input.digest !== "string" || !HEX64.test(input.digest)) return blocked("digest-missing");

    let snapshot: PreparedSnapshot;
    try {
        snapshot = await deps.readSnapshot(input.bankLineId);
    } catch {
        return { kind: 'incomplete', reason: 'snapshot-read-failed' };
    }

    const instant = now();
    const issues = validateSnapshot(snapshot, input.bankLineId, allowed, instant);
    if (issues.length > 0) return blocked(`snapshot-invalid:${issues[0].field}:${issues[0].reason}`);

    const recomputed = computeOnDemandDigest(snapshot, instant);
    if (recomputed !== input.digest) return blocked("digest-mismatch");
    const card = toOwnerCard(snapshot, instant);
    // Claim's maxWait + timeout is 9s; leave full post/finish headroom first.
    if (now().getTime() - startedAt >= ON_DEMAND_DEADLINE_MS - 9_000 - ON_DEMAND_DELIVERY_RESERVE_MS)
        return blocked('deadline-before-claim');

    let claim: ClaimResult;
    try {
        claim = await deps.claim(snapshot, recomputed);
    } catch {
        return blocked("claim-failed");
    }

    if (claim.kind === "blocked") return blocked(`claim-blocked:${claim.reason}`);
    if (claim.kind === "already-posted") {
        // We returned the REAL thread the store discovered. Never a fabricated
        // success, never a resend.
        return validDeliveryIdentity(claim.threadName, claim.messageName)
            ? { kind: "posted", threadName: claim.threadName, messageName: claim.messageName }
            : { kind: 'unknown', reason: 'invalid-existing-delivery' };
    }

    // Deliver OUTSIDE any transaction the store may be holding; the store's
    // claim() committed before we were called. Reserve the whole window.
    const timeoutMs = CARD_POST_TIMEOUT_MS;

    let postResult: FinishResult | { kind: "unknown"; reason: string };
    try {
        postResult = now().getTime() - startedAt >= ON_DEMAND_DEADLINE_MS - ON_DEMAND_DELIVERY_RESERVE_MS
            ? { kind: 'unknown', reason: 'deadline-before-send' }
            : await deps.post(card, deps.webhookUrl, timeoutMs);
    } catch {
        // A thrown post is UNKNOWN — Chat may have taken the card. Never a
        // fabricated success, never a silent drop.
        postResult = { kind: "unknown", reason: "post-threw" };
    }

    const finishInput: FinishResult =
        postResult.kind === "delivered" && validDeliveryIdentity(postResult.threadName, postResult.messageName)
            ? { kind: "delivered", threadName: postResult.threadName, messageName: postResult.messageName }
            : { kind: "uncertain", reason: postResult.kind === 'delivered' ? 'invalid-delivery-identity' : postResult.reason };

    let finish: { kind: "recorded" } | { kind: "failed"; reason: string };
    try {
        finish = await deps.finish(claim, finishInput);
    } catch {
        // A thrown finish is UNKNOWN. We never fabricate a success on the way
        // out — the row may still be POSTING, and the next reader will see it.
        return { kind: "unknown", reason: "finish-threw" };
    }

    if (finish.kind === "failed") {
        // Not recorded is not posted. Surface the honest outcome.
        return { kind: "unknown", reason: `finish-failed:${finish.reason}` };
    }

    if (finishInput.kind === "delivered") {
        return { kind: "posted", threadName: finishInput.threadName, messageName: finishInput.messageName };
    }
    return { kind: "unknown", reason: finishInput.reason };
}

/**
 * The single entry point. `options.now` overrides `deps.now`; if neither is
 * supplied, `new Date()` is used. The clock is INJECTED everywhere it is read
 * — the digest is recomputed from the same clock in both prepare and apply,
 * so an unchanged source with a moved clock still matches.
 */
export async function runOnDemand(
    input: OnDemandInput,
    deps: OnDemandDeps,
    options: OnDemandOptions = {},
): Promise<OnDemandResult> {
    const decoded = decodeOnDemandInput(input);
    if (!decoded) return blocked("invalid-input");
    const now = options.now ?? deps.now ?? (() => new Date());
    if ((options.allowedTargets ?? []).includes(decoded.bankLineId) && deps.lookupPosted) {
        try {
            const existing = await deps.lookupPosted(decoded.bankLineId);
            if (existing) return validDeliveryIdentity(existing.threadName, existing.messageName)
                ? { kind: 'posted', threadName: existing.threadName, messageName: existing.messageName }
                : { kind: 'unknown', reason: 'invalid-existing-delivery' };
        } catch { return blocked('existing-request-unavailable'); }
    }
    // Re-decode with the strict shape to preserve the narrowed type.
    if (decoded.action === "prepare") return prepareOnce(decoded, deps, options, now);
    return applyOnce(decoded, deps, options, now);
}
