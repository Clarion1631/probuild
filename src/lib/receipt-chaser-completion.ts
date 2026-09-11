import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { BANK_LEDGER_EPOCH_KEY } from "./bank-ledger-epoch";
import { RECEIPT_EVIDENCE_EPOCH_KEY } from "./receipt-evidence-lock";
import { BANK_PULL_CHASER_WINDOW_HOURS, BANK_PULL_LAST_SUCCESS_KEY } from "./pipeline-health";
import {
    CYCLE_KEY,
    SWEEP_MARKER_KEY,
    chaserCompletedFor,
    continuationNeedsWork,
    cycleCertified,
    cycleRecognitionPolicyMatches,
    cycleStillValid,
    isSweepPhase,
    parseSweepCycle,
    parseSweepMarker,
    type SweepCycle,
    type SweepMarker,
    type SweepPhase,
} from "./receipt-sweep-marker";
import { CARD_OWNERS_ASKED, isValidChatWebhookUrl, pacificDate, parseOwnerChatUsers } from "./receipt-request-cards";
import { receiptRecognitionPolicy } from "./receipt-source-recognition";
import { reviewedReceiptFactsFingerprint } from "@/server/receipt-reviewed-source-facts";
import { reviewedReceiptPairsFingerprint } from "@/server/receipt-reviewed-pair-facts";

/**
 * READ-ONLY proof of the missing-receipt chaser's CURRENT-CYCLE completion, for
 * `/api/health/pipeline` (`?chaser=only`, and appended to the full response).
 *
 * The health probe used to report the phase marker alone, which cannot answer
 * "did the cycle that is running right now finish, unblocked, against a world
 * that has not moved since". That is the question the sweep's continuation
 * pass asks (`continuationNeedsWork`) and the one the morning cards cron asks
 * (`chaserCompletedFor` with the current cycle id). This module asks both with
 * the SAME imported predicates, over the same eight AutomationSetting rows,
 * and reports every named sub-predicate separately.
 *
 * What it is not:
 *   - not a snapshot: two serial bounded reads compared for exact equality
 *     (row presence included). Unequal reads, a read failure, a malformed
 *     decision-relevant value, or a Pacific-day boundary crossed between the
 *     first read and the evaluation all yield an explicit non-stable status
 *     with NO predicates, never a certification manufactured from a default;
 *   - not a card-eligibility verdict: feature flag, weekday, holds, webhook
 *     delivery, owner state and item-level revalidation are other gates;
 *   - not proof of bank coverage: it describes the sweep's own records.
 *
 * Every time-dependent answer (predicates, bank-pull freshness, `capturedAt`)
 * is evaluated at the clock reading taken AFTER the second read completed, so
 * a stamp that expired while the rows were being read reports as expired.
 *
 * It never writes, never locks, never opens a transaction, never calls a
 * network, and never echoes cursor contents, raw setting text, webhook URLs,
 * user ids, or any policy text outside the strict grammar below.
 */

export const CHASER_COMPLETION_SCOPE = "receipt-chaser-completion";
export const CHASER_COMPLETION_TIME_ZONE = "America/Los_Angeles";

/**
 * The three keys the sweep route keeps private (`CURSOR_KEY`,
 * `OPEN_CURSOR_KEY`, `FULL_RUN_REQUESTED_KEY`). Restated rather than imported
 * because importing the sweep here would drag the whole cron into the health
 * endpoint; `tests/receipt-chaser-completion.test.ts` pins them to the route's
 * literals so they cannot drift.
 */
export const LINE_CURSOR_KEY = "receiptRequestsCursor";
export const OPEN_CURSOR_KEY = "receiptRequestsOpenIssueCursor";
export const FULL_RUN_REQUESTED_KEY = "receiptRequestsFullRunRequested";

/** The FIXED key list. Nothing else is ever queried; nothing is taken from the request. */
export const CHASER_COMPLETION_KEYS = [
    SWEEP_MARKER_KEY,
    CYCLE_KEY,
    LINE_CURSOR_KEY,
    OPEN_CURSOR_KEY,
    FULL_RUN_REQUESTED_KEY,
    BANK_LEDGER_EPOCH_KEY,
    RECEIPT_EVIDENCE_EPOCH_KEY,
    BANK_PULL_LAST_SUCCESS_KEY,
] as const;
export type ChaserSettingKey = (typeof CHASER_COMPLETION_KEYS)[number];

/**
 * Blocked reasons the sweep can write (`BANK_PULL_STALE_REASON`,
 * `PULL_MOVED_REASON`, `LEDGER_FENCE_FAILED_REASON` in the route). Anything
 * else is reported as "other" rather than echoed.
 */
export const KNOWN_BLOCKED_REASONS = ["bank-pull-stale", "pull-moved", "ledger-fence-failed"] as const;

type FindManyOnly<M extends { findMany: unknown }> = Pick<M, "findMany">;
/** Read-only surface: `findMany` only. A write method does not type-check. */
export interface ChaserCompletionDb {
    automationSetting: FindManyOnly<PrismaClient["automationSetting"]>;
}

export type SettingValues = Readonly<Record<ChaserSettingKey, string | null>>;

export type ChaserCompletionStatus = "stable" | "unstable" | "unavailable";
export type ChaserCompletionReason =
    | "read-failed" | "rows-over-bound" | "duplicate-key" | "unexpected-key" | "value-not-string"
    | "reads-differ" | "day-boundary-crossed"
    | "marker-malformed" | "cycle-malformed" | "bank-ledger-epoch-malformed" | "receipt-evidence-epoch-malformed"
    // Diagnostic-only guards: the sweep's parsers accept any non-empty string
    // for these, but a proof must not certify on identities or policies it
    // cannot show.
    | "marker-cycle-id-malformed" | "cycle-id-malformed" | "cycle-epoch-malformed" | "cycle-policy-malformed" | "runtime-policy-malformed";

export type MarkerShape = "absent" | "legacy-phase" | "json" | "malformed";
export type CycleShape = "absent" | "json" | "malformed";
export type EpochState = "measured" | "missing" | "malformed";
export type BankPullState = "fresh" | "stale" | "future" | "malformed" | "missing";
export type FingerprintState = "absent" | "invalid" | "pinned" | "malformed";
/** The grammars `receiptRecognitionPolicy` has ever produced (v2 was retired by #510 but may still sit in a stored cycle). */
export type PolicyGrammar = "v1-off" | "v2-on" | "v3-on" | "malformed";

export interface RuntimePolicyInput {
    /** The exact string the sweep certifies and the cards cron compares. Echoed only when it matches the grammar whitelist. */
    policy: string;
    recognitionEnabled: boolean;
    reviewedFactsFingerprint: string;
    reviewedPairsFingerprint: string;
}

export interface FingerprintProof {
    state: FingerprintState;
    /** `absent`, `invalid`, or the exact 64-hex packet fingerprint. Null when malformed. */
    fingerprint: string | null;
}

/**
 * Exact policy evidence. `policy` and `digest` (sha256 of the exact string) are
 * present only when the string matches the strict grammar whitelist, so the
 * response can substantiate "stored policy === runtime policy" without ever
 * carrying arbitrary text.
 */
export interface PolicyProof {
    grammar: PolicyGrammar;
    policy: string | null;
    digest: string | null;
    reviewedFacts: FingerprintProof | null;
    reviewedPairs: FingerprintProof | null;
}

export interface CardDeliveryConfigProjection {
    /** `RECEIPT_REQUEST_CARDS_ENABLED === "true"`: the cards cron's exact enable gate. */
    reminderEnabled: boolean;
    /** The cron's `no-webhook` gate: any non-empty `RECEIPTS_CHAT_WEBHOOK`. */
    webhookPresent: boolean;
    /** `postOwnerCard`'s allowlist (`isValidChatWebhookUrl`), which refuses anything else before sending. */
    webhookValid: boolean;
    /**
     * `RECEIPT_OWNER_CHAT_USERS` through the sender-side parser
     * (`parseOwnerChatUsers`), checked for every owner a card is addressed to
     * (`CARD_OWNERS_ASKED`: CJ and Richard; Justin is never a card target). A
     * malformed value degrades to no mapping, exactly as it does for the sender.
     */
    ownerMapping: { present: boolean; owners: Record<string, boolean>; complete: boolean };
    /**
     * Composite configuration readiness: webhook present AND valid AND every
     * asked owner mapped. Configuration shape only — it says nothing about
     * whether a card was, or will be, delivered.
     */
    deliveryConfigured: boolean;
}

export interface ChaserCompletionPredicates {
    /** marker.phase === "done" */
    phaseDone: boolean;
    /** no marker.blockedReason */
    unblocked: boolean;
    /** a cycle exists and marker.completedCycleId === cycle.id */
    completionIsCurrentCycle: boolean;
    /** chaserCompletedAt parses and is not after the evaluation instant */
    completionTimeValid: boolean;
    /** cycleStillValid(cycle, currentBankEpoch, currentEvidenceEpoch) — epochs only */
    epochsUnchanged: boolean;
    /** cycleRecognitionPolicyMatches(cycle, runtimePolicy) on the actual strings — the cards cron's policy gate */
    cyclePolicyMatchesRuntime: boolean;
    /** cycleStillValid(cycle, bank, evidence, runtimePolicy) — epochs AND policy */
    cycleStillValid: boolean;
    /** The continuation's `certified` sub-expression (all of the above, this cycle, done, unblocked, stamped in the past). */
    cycleCertified: boolean;
    /** chaserCompletedFor(marker, pacificDay, tz, cycle.id) — the cards cron's chaser prerequisite for TODAY. */
    completedForPacificDay: boolean;
    /** `!!receiptRequestsFullRunRequested` — an owed full run overrides any completion. */
    fullRunOwed: boolean;
    /** The exact continuation predicate. false = a continuation pass would answer nothing-in-progress. */
    continuationNeedsWork: boolean;
}

export interface ChaserCompletionDiagnostic {
    scope: typeof CHASER_COMPLETION_SCOPE;
    readOnly: true;
    businessActionsPerformed: false;
    status: ChaserCompletionStatus;
    reason: ChaserCompletionReason | null;
    /** The evaluation instant: the clock reading taken AFTER the second read completed. */
    capturedAt: string;
    /** Pacific day of `capturedAt`; every day-keyed predicate uses this. */
    pacificDay: string;
    timeZone: typeof CHASER_COMPLETION_TIME_ZONE;
    keys: readonly ChaserSettingKey[];
    snapshot: {
        /** Clock reading before the first read, and its Pacific day. */
        startedAt: string;
        startPacificDay: string;
        firstReadOk: boolean;
        secondReadOk: boolean;
        /** Exact per-key equality of both reads, row presence included. */
        readsEqual: boolean | null;
        /** `pacificDay !== startPacificDay`: "today" changed between the first read and the evaluation. */
        dayBoundaryCrossed: boolean | null;
        rowsPresent: Record<ChaserSettingKey, boolean> | null;
    };
    marker: {
        present: boolean;
        shape: MarkerShape;
        phase: SweepPhase | null;
        /** Normalised ISO when the stamp parses; null otherwise. */
        chaserCompletedAt: string | null;
        completedAtValid: boolean;
        /** Echoed only when UUID-shaped (the sweep mints cycle ids with randomUUID). */
        completedCycleId: string | null;
        blocked: boolean;
        blockedReason: (typeof KNOWN_BLOCKED_REASONS)[number] | "other" | null;
    } | null;
    cycle: {
        present: boolean;
        shape: CycleShape;
        id: string | null;
        /** Echoed only when integer-shaped. */
        epoch: string | null;
        evidenceEpoch: string | null;
        /** Null when there is no parsed cycle. */
        recognitionPolicy: {
            /** The field is present in the stored cycle. Absent = legacy cycle, which the comparison reads as v1:off. */
            recorded: boolean;
            grammar: "legacy-absent" | PolicyGrammar;
            /** Exact stored string / its digest, whitelisted grammar only. Null for legacy-absent. */
            policy: string | null;
            digest: string | null;
            /** Digest of what `cycleRecognitionPolicyMatches` actually compares: the stored string, or v1:off for a legacy cycle. */
            effectiveDigest: string | null;
            reviewedFacts: FingerprintProof | null;
            reviewedPairs: FingerprintProof | null;
        } | null;
    } | null;
    currentEpochs: {
        bankLedger: { state: EpochState; value: string | null };
        receiptEvidence: { state: EpochState; value: string | null };
    } | null;
    runtimePolicy: PolicyProof & { recognitionEnabled: boolean };
    fullRun: { owed: boolean } | null;
    /** Presence ONLY. Contents are never read into the response. */
    cursors: { linePresent: boolean; openIssuePresent: boolean } | null;
    /** Separate input-readiness signal; NOT a term of `continuationNeedsWork`. */
    bankPull: { state: BankPullState; lastSuccessAt: string | null; fresh: boolean; windowHours: number } | null;
    predicates: ChaserCompletionPredicates | null;
    delivery: CardDeliveryConfigProjection;
    limitations: readonly string[];
}

export const CHASER_COMPLETION_LIMITATIONS = [
    "Two serial bounded reads compared for exact equality; this is not an atomic database snapshot and takes no lock.",
    "Every time-dependent answer is evaluated at capturedAt, the clock reading taken after the second read completed.",
    "Certification describes the sweep's own marker, cycle and epoch rows. It does not prove full bank coverage or that every charge was chased.",
    "completedForPacificDay is only the cards cron's chaser prerequisite. Feature flag, weekday, holds, webhook delivery, owner state and item-level revalidation are separate gates not evaluated here.",
    "bankPull freshness is a separate input-readiness signal; a completed cycle is a continuation no-op regardless of it.",
    "delivery booleans describe configuration presence and shape only; they do not mean any card was or will be delivered.",
    "Cursor contents, raw setting text, webhook URLs, user ids and any policy text outside the strict grammar are never echoed.",
] as const;

// ── Policy proof (strict grammar whitelist) ─────────────────────────────────

const V1_OFF = "receipt-source-v1:off";
const FINGERPRINT = "(absent|invalid|[0-9a-f]{64})";
const V2_ON_RE = new RegExp(`^receipt-source-v2:on:${FINGERPRINT}$`);
const V3_ON_RE = new RegExp(`^receipt-source-v3:on:${FINGERPRINT}:pair:${FINGERPRINT}$`);
const HEX64_RE = /^[0-9a-f]{64}$/;

export function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprintProofOf(fingerprint: string): FingerprintProof {
    if (fingerprint === "absent") return { state: "absent", fingerprint };
    if (fingerprint === "invalid") return { state: "invalid", fingerprint };
    if (HEX64_RE.test(fingerprint)) return { state: "pinned", fingerprint };
    return { state: "malformed", fingerprint: null };
}

/** Whitelisted grammars only. Anything else is `malformed` with nothing echoed. */
export function policyProofOf(policy: string): PolicyProof {
    if (policy === V1_OFF) return { grammar: "v1-off", policy, digest: sha256Hex(policy), reviewedFacts: null, reviewedPairs: null };
    const v3 = V3_ON_RE.exec(policy);
    if (v3) return { grammar: "v3-on", policy, digest: sha256Hex(policy), reviewedFacts: fingerprintProofOf(v3[1]), reviewedPairs: fingerprintProofOf(v3[2]) };
    const v2 = V2_ON_RE.exec(policy);
    if (v2) return { grammar: "v2-on", policy, digest: sha256Hex(policy), reviewedFacts: fingerprintProofOf(v2[1]), reviewedPairs: null };
    return { grammar: "malformed", policy: null, digest: null, reviewedFacts: null, reviewedPairs: null };
}

/**
 * The runtime side, exactly as the sweep and the cards cron derive it: the
 * flag plus BOTH private packet fingerprints, through `receiptRecognitionPolicy`.
 * Nothing here reads packet contents — only the fingerprints those modules
 * already export.
 */
export function runtimeRecognitionPolicy(env: NodeJS.ProcessEnv = process.env): RuntimePolicyInput {
    const recognitionEnabled = env.RECEIPT_SOURCE_RECOGNITION_ENABLED === "true";
    return {
        policy: receiptRecognitionPolicy(recognitionEnabled, reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint),
        recognitionEnabled,
        reviewedFactsFingerprint: reviewedReceiptFactsFingerprint,
        reviewedPairsFingerprint: reviewedReceiptPairsFingerprint,
    };
}

export function projectRuntimePolicy(runtime: RuntimePolicyInput): ChaserCompletionDiagnostic["runtimePolicy"] {
    return { recognitionEnabled: runtime.recognitionEnabled, ...policyProofOf(runtime.policy) };
}

function projectCyclePolicy(cycle: SweepCycle): NonNullable<ChaserCompletionDiagnostic["cycle"]>["recognitionPolicy"] {
    if (cycle.recognitionPolicy === undefined) {
        // `cycleRecognitionPolicyMatches` reads an absent field as v1:off.
        return { recorded: false, grammar: "legacy-absent", policy: null, digest: null, effectiveDigest: sha256Hex(V1_OFF), reviewedFacts: null, reviewedPairs: null };
    }
    const proof = policyProofOf(cycle.recognitionPolicy);
    return { recorded: true, ...proof, effectiveDigest: proof.digest };
}

// ── Delivery configuration (the sender's own readers, presence/shape only) ──

export function projectCardDeliveryConfig(env: NodeJS.ProcessEnv = process.env): CardDeliveryConfigProjection {
    const webhook = env.RECEIPTS_CHAT_WEBHOOK;
    const webhookPresent = !!webhook;
    const webhookValid = !!webhook && isValidChatWebhookUrl(webhook);
    const mapping = parseOwnerChatUsers(env.RECEIPT_OWNER_CHAT_USERS);
    const owners: Record<string, boolean> = {};
    for (const owner of CARD_OWNERS_ASKED) owners[owner] = typeof mapping[owner] === "string";
    const complete = CARD_OWNERS_ASKED.every(owner => owners[owner]);
    return {
        reminderEnabled: env.RECEIPT_REQUEST_CARDS_ENABLED === "true",
        webhookPresent,
        webhookValid,
        ownerMapping: { present: !!env.RECEIPT_OWNER_CHAT_USERS, owners, complete },
        deliveryConfigured: webhookPresent && webhookValid && complete,
    };
}

// ── Bounded read ────────────────────────────────────────────────────────────

const SETTING_SELECT = { key: true, value: true } as const;

export type SettingsRead = { ok: true; values: SettingValues } | { ok: false; reason: ChaserCompletionReason };

function isChaserSettingKey(key: string): key is ChaserSettingKey {
    return (CHASER_COMPLETION_KEYS as readonly string[]).includes(key);
}

/** Classify one bounded read: every key at most once, every value a string, nothing unexpected. */
export function classifySettingRows(rows: ReadonlyArray<{ key: unknown; value: unknown }>): SettingsRead {
    if (rows.length > CHASER_COMPLETION_KEYS.length) return { ok: false, reason: "rows-over-bound" };
    const values: Partial<Record<ChaserSettingKey, string | null>> = {};
    for (const key of CHASER_COMPLETION_KEYS) values[key] = null;
    const seen = new Set<string>();
    for (const row of rows) {
        if (typeof row.key !== "string" || !isChaserSettingKey(row.key)) return { ok: false, reason: "unexpected-key" };
        if (seen.has(row.key)) return { ok: false, reason: "duplicate-key" };
        seen.add(row.key);
        if (typeof row.value !== "string") return { ok: false, reason: "value-not-string" };
        values[row.key] = row.value;
    }
    return { ok: true, values: values as SettingValues };
}

/** One bounded `findMany` over the fixed keys: `take` is the key count plus one so over-delivery is detectable. */
export async function readChaserSettings(db: ChaserCompletionDb): Promise<SettingsRead> {
    let rows: ReadonlyArray<{ key: unknown; value: unknown }>;
    try {
        rows = await db.automationSetting.findMany({
            where: { key: { in: [...CHASER_COMPLETION_KEYS] } },
            orderBy: { key: "asc" },
            take: CHASER_COMPLETION_KEYS.length + 1,
            select: SETTING_SELECT,
        });
    } catch {
        return { ok: false, reason: "read-failed" };
    }
    if (!Array.isArray(rows)) return { ok: false, reason: "read-failed" };
    return classifySettingRows(rows);
}

export function settingsEqual(a: SettingValues, b: SettingValues): boolean {
    return CHASER_COMPLETION_KEYS.every(key => a[key] === b[key]);
}

// ── Safe projections of each row ────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EPOCH_RE = /^(0|[1-9]\d*)$/;

export function markerShapeOf(value: string | null): MarkerShape {
    if (!value) return "absent";
    if (isSweepPhase(value)) return "legacy-phase";
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "malformed";
        const record = parsed as { phase?: unknown; chaserCompletedAt?: unknown; blockedReason?: unknown; completedCycleId?: unknown };
        // `parseSweepMarker` quietly defaults a junk phase to "done". A reader
        // that only observes must not let that default stand in for a fact.
        if (!isSweepPhase(record.phase)) return "malformed";
        for (const field of [record.chaserCompletedAt, record.blockedReason, record.completedCycleId]) {
            if (field !== undefined && field !== null && typeof field !== "string") return "malformed";
        }
        return "json";
    } catch {
        return "malformed";
    }
}

export function cycleShapeOf(value: string | null): CycleShape {
    if (!value) return "absent";
    return parseSweepCycle(value) === null ? "malformed" : "json";
}

/**
 * Mirrors `readBankLedgerEpoch` / `readReceiptEvidenceEpoch`: a missing row
 * reads as "0" (`rows[0]?.value ?? "0"`), which is NOT a measured zero and is
 * reported as `missing`. A present value that is not a non-negative integer is
 * `malformed` and is never echoed. `effective` is what the helpers would return.
 */
export function epochOf(value: string | null): { state: EpochState; value: string | null; effective: string } {
    if (value === null) return { state: "missing", value: null, effective: "0" };
    if (EPOCH_RE.test(value)) return { state: "measured", value, effective: value };
    return { state: "malformed", value: null, effective: value };
}

/** Same four ways to be stale as the sweep's `bankPullFresh`, plus which one it was. Evaluated at `now`. */
export function bankPullOf(value: string | null, now: Date, windowHours: number): NonNullable<ChaserCompletionDiagnostic["bankPull"]> {
    const base = { windowHours };
    if (!value) return { ...base, state: "missing", lastSuccessAt: null, fresh: false };
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return { ...base, state: "malformed", lastSuccessAt: null, fresh: false };
    const lastSuccessAt = new Date(at).toISOString();
    if (at > now.getTime()) return { ...base, state: "future", lastSuccessAt, fresh: false };
    if (now.getTime() - at > windowHours * 3_600_000) return { ...base, state: "stale", lastSuccessAt, fresh: false };
    return { ...base, state: "fresh", lastSuccessAt, fresh: true };
}

function projectMarker(value: string | null, marker: SweepMarker, shape: MarkerShape): NonNullable<ChaserCompletionDiagnostic["marker"]> {
    if (shape === "malformed") {
        return { present: true, shape, phase: null, chaserCompletedAt: null, completedAtValid: false, completedCycleId: null, blocked: false, blockedReason: null };
    }
    const completedAt = marker.chaserCompletedAt ? Date.parse(marker.chaserCompletedAt) : NaN;
    const completedAtValid = Number.isFinite(completedAt);
    const blocked = !!marker.blockedReason;
    return {
        present: !!value,
        shape,
        phase: marker.phase,
        chaserCompletedAt: completedAtValid ? new Date(completedAt).toISOString() : null,
        completedAtValid,
        completedCycleId: marker.completedCycleId && UUID_RE.test(marker.completedCycleId) ? marker.completedCycleId : null,
        blocked,
        blockedReason: !blocked ? null
            : (KNOWN_BLOCKED_REASONS as readonly string[]).includes(marker.blockedReason!) ? marker.blockedReason as (typeof KNOWN_BLOCKED_REASONS)[number]
            : "other",
    };
}

function projectCycle(value: string | null, cycle: SweepCycle | null, shape: CycleShape): NonNullable<ChaserCompletionDiagnostic["cycle"]> {
    if (!cycle) return { present: !!value, shape, id: null, epoch: null, evidenceEpoch: null, recognitionPolicy: null };
    return {
        present: true,
        shape,
        id: UUID_RE.test(cycle.id) ? cycle.id : null,
        epoch: EPOCH_RE.test(cycle.epoch) ? cycle.epoch : null,
        evidenceEpoch: EPOCH_RE.test(cycle.evidenceEpoch) ? cycle.evidenceEpoch : null,
        recognitionPolicy: projectCyclePolicy(cycle),
    };
}

// ── The proof ───────────────────────────────────────────────────────────────

export interface ProjectChaserCompletionInput {
    values: SettingValues;
    /** The evaluation instant: taken AFTER the second read completed. */
    now: Date;
    runtime: RuntimePolicyInput;
    delivery: CardDeliveryConfigProjection;
    snapshot: ChaserCompletionDiagnostic["snapshot"];
    /** Already decided by the reader: unequal reads or a crossed day boundary. */
    unstable: Extract<ChaserCompletionReason, "reads-differ" | "day-boundary-crossed"> | null;
    bankPullWindowHours?: number;
}

/** PURE. Everything decision-relevant is projected first; predicates are computed only on a stable, well-formed read. */
export function projectChaserCompletion(input: ProjectChaserCompletionInput): ChaserCompletionDiagnostic {
    const { values, now } = input;
    const pacificDay = pacificDate(now);
    const windowHours = input.bankPullWindowHours ?? BANK_PULL_CHASER_WINDOW_HOURS;

    const markerValue = values[SWEEP_MARKER_KEY];
    const cycleValue = values[CYCLE_KEY];
    const markerShape = markerShapeOf(markerValue);
    const cycleShape = cycleShapeOf(cycleValue);
    const marker = parseSweepMarker(markerValue);
    const cycle = parseSweepCycle(cycleValue);
    const bank = epochOf(values[BANK_LEDGER_EPOCH_KEY]);
    const evidence = epochOf(values[RECEIPT_EVIDENCE_EPOCH_KEY]);
    // Same presence rule as the sweep's cursor readers (`row?.value ? row.value : null`).
    const lineCursor = values[LINE_CURSOR_KEY] ? values[LINE_CURSOR_KEY] : null;
    const openCursor = values[OPEN_CURSOR_KEY] ? values[OPEN_CURSOR_KEY] : null;
    // Same rule as the sweep's `readFullRunRequested` (`!!row?.value`).
    const fullRunOwed = !!values[FULL_RUN_REQUESTED_KEY];

    const base: Omit<ChaserCompletionDiagnostic, "status" | "reason" | "predicates"> = {
        scope: CHASER_COMPLETION_SCOPE,
        readOnly: true,
        businessActionsPerformed: false,
        capturedAt: now.toISOString(),
        pacificDay,
        timeZone: CHASER_COMPLETION_TIME_ZONE,
        keys: CHASER_COMPLETION_KEYS,
        snapshot: input.snapshot,
        marker: projectMarker(markerValue, marker, markerShape),
        cycle: projectCycle(cycleValue, cycle, cycleShape),
        currentEpochs: {
            bankLedger: { state: bank.state, value: bank.value },
            receiptEvidence: { state: evidence.state, value: evidence.value },
        },
        runtimePolicy: projectRuntimePolicy(input.runtime),
        fullRun: { owed: fullRunOwed },
        cursors: { linePresent: lineCursor !== null, openIssuePresent: openCursor !== null },
        bankPull: bankPullOf(values[BANK_PULL_LAST_SUCCESS_KEY], now, windowHours),
        delivery: input.delivery,
        limitations: CHASER_COMPLETION_LIMITATIONS,
    };

    if (input.unstable) return { ...base, status: "unstable", reason: input.unstable, predicates: null };
    const malformed: ChaserCompletionReason | null =
        markerShape === "malformed" ? "marker-malformed"
        : cycleShape === "malformed" ? "cycle-malformed"
        : bank.state === "malformed" ? "bank-ledger-epoch-malformed"
        : evidence.state === "malformed" ? "receipt-evidence-epoch-malformed"
        // Diagnostic-only, fail closed: `parseSweepCycle` / `parseSweepMarker`
        // accept any non-empty string here (unchanged for the sweep), but this
        // proof suppresses its predicates when it cannot show the identities
        // and policies they would rest on. A legacy cycle with no recorded
        // policy, and a marker with no completion, remain legitimate.
        : typeof marker.completedCycleId === "string" && !UUID_RE.test(marker.completedCycleId) ? "marker-cycle-id-malformed"
        : cycle !== null && !UUID_RE.test(cycle.id) ? "cycle-id-malformed"
        : cycle !== null && !(EPOCH_RE.test(cycle.epoch) && EPOCH_RE.test(cycle.evidenceEpoch)) ? "cycle-epoch-malformed"
        : cycle !== null && cycle.recognitionPolicy !== undefined && policyProofOf(cycle.recognitionPolicy).grammar === "malformed" ? "cycle-policy-malformed"
        : policyProofOf(input.runtime.policy).grammar === "malformed" ? "runtime-policy-malformed"
        : null;
    if (malformed) return { ...base, status: "unavailable", reason: malformed, predicates: null };

    const completedAt = marker.chaserCompletedAt ? Date.parse(marker.chaserCompletedAt) : NaN;
    const certification = { marker, cycle, bankEpoch: bank.effective, evidenceEpoch: evidence.effective, recognitionPolicy: input.runtime.policy, now };
    const predicates: ChaserCompletionPredicates = {
        phaseDone: marker.phase === "done",
        unblocked: !marker.blockedReason,
        completionIsCurrentCycle: cycle !== null && marker.completedCycleId === cycle.id,
        completionTimeValid: Number.isFinite(completedAt) && completedAt <= now.getTime(),
        epochsUnchanged: cycleStillValid(cycle, bank.effective, evidence.effective),
        cyclePolicyMatchesRuntime: cycleRecognitionPolicyMatches(cycle, input.runtime.policy),
        cycleStillValid: cycleStillValid(cycle, bank.effective, evidence.effective, input.runtime.policy),
        cycleCertified: cycleCertified(certification),
        completedForPacificDay: chaserCompletedFor(marker, pacificDay, CHASER_COMPLETION_TIME_ZONE, cycle?.id ?? null),
        fullRunOwed,
        continuationNeedsWork: continuationNeedsWork({ ...certification, fullRunOwed, lineCursor, openCursor }),
    };
    return { ...base, status: "stable", reason: null, predicates };
}

export function unavailableChaserCompletion(
    reason: ChaserCompletionReason,
    now: Date,
    extra: { startedAt?: Date; runtime?: RuntimePolicyInput; delivery?: CardDeliveryConfigProjection; snapshot?: Partial<ChaserCompletionDiagnostic["snapshot"]> } = {},
): ChaserCompletionDiagnostic {
    const startedAt = extra.startedAt ?? now;
    return {
        scope: CHASER_COMPLETION_SCOPE,
        readOnly: true,
        businessActionsPerformed: false,
        status: "unavailable",
        reason,
        capturedAt: now.toISOString(),
        pacificDay: pacificDate(now),
        timeZone: CHASER_COMPLETION_TIME_ZONE,
        keys: CHASER_COMPLETION_KEYS,
        snapshot: {
            startedAt: startedAt.toISOString(), startPacificDay: pacificDate(startedAt),
            firstReadOk: false, secondReadOk: false, readsEqual: null, dayBoundaryCrossed: null, rowsPresent: null,
            ...extra.snapshot,
        },
        marker: null,
        cycle: null,
        currentEpochs: null,
        runtimePolicy: projectRuntimePolicy(extra.runtime ?? runtimeRecognitionPolicy()),
        fullRun: null,
        cursors: null,
        bankPull: null,
        predicates: null,
        delivery: extra.delivery ?? projectCardDeliveryConfig(),
        limitations: CHASER_COMPLETION_LIMITATIONS,
    };
}

export interface ChaserCompletionDeps {
    now?: () => Date;
    runtime?: RuntimePolicyInput;
    env?: NodeJS.ProcessEnv;
    bankPullWindowHours?: number;
}

/**
 * Read the fixed keys twice and prove completion only if nothing moved. Two
 * bounded reads, no retry, no transaction, no lock.
 *
 * The clock is read before the first read (`startedAt`) and again after the
 * second read completed (`capturedAt`). Everything time-dependent is evaluated
 * at `capturedAt`, so a bank-pull stamp or a completion that crossed a
 * boundary while the rows were being read is judged as it stands at the end.
 * If the Pacific day differs between the two clock readings, "today" changed
 * underneath the read and the proof is reported unstable.
 */
export async function loadChaserCompletion(db: ChaserCompletionDb, deps: ChaserCompletionDeps = {}): Promise<ChaserCompletionDiagnostic> {
    const clock = deps.now ?? (() => new Date());
    const env = deps.env ?? process.env;
    const runtime = deps.runtime ?? runtimeRecognitionPolicy(env);
    const delivery = projectCardDeliveryConfig(env);
    const startedAt = clock();
    const startPacificDay = pacificDate(startedAt);

    const first = await readChaserSettings(db);
    if (!first.ok) return unavailableChaserCompletion(first.reason, clock(), { startedAt, runtime, delivery });
    const second = await readChaserSettings(db);
    if (!second.ok) return unavailableChaserCompletion(second.reason, clock(), { startedAt, runtime, delivery, snapshot: { firstReadOk: true } });
    const now = clock();
    const readsEqual = settingsEqual(first.values, second.values);
    const dayBoundaryCrossed = pacificDate(now) !== startPacificDay;
    const rowsPresent = Object.fromEntries(CHASER_COMPLETION_KEYS.map(key => [key, first.values[key] !== null])) as Record<ChaserSettingKey, boolean>;

    return projectChaserCompletion({
        values: first.values,
        now,
        runtime,
        delivery,
        snapshot: {
            startedAt: startedAt.toISOString(), startPacificDay,
            firstReadOk: true, secondReadOk: true, readsEqual, dayBoundaryCrossed, rowsPresent,
        },
        unstable: !readsEqual ? "reads-differ" : dayBoundaryCrossed ? "day-boundary-crossed" : null,
        bankPullWindowHours: deps.bankPullWindowHours,
    });
}

/** Production entry for the health route. The Prisma client is imported lazily; failure is a static "unavailable", never raw diagnostics. */
export async function loadChaserCompletionDiagnostic(): Promise<ChaserCompletionDiagnostic> {
    try {
        const { prisma } = await import("./prisma");
        return await loadChaserCompletion(prisma);
    } catch (error) {
        console.error("[health/pipeline] chaser completion unavailable", error instanceof Error ? error.name : "UnknownError");
        return unavailableChaserCompletion("read-failed", new Date());
    }
}
