import { createHash } from "node:crypto";
import type { MergedRegisterRow } from "./register-merge";

/**
 * Review-alert reason codes (Unified Money Register plan §4, punch 9).
 *
 * PURE leaf module — no Prisma, no fetch. Stable, enum-like codes only, never
 * free text: a comma-joined display string collides (`["a,b","c"]` and
 * `["a","b,c"]` canonicalize identically), and hashing text that contains
 * amounts/dates churns a new alert generation on every evaluation even when
 * nothing about the UNDERLYING problem changed. Amounts/dates belong in a
 * separate, never-hashed "display details" blob (see review-alert-lifecycle.ts).
 *
 * `DUPLICATE` is reserved per the plan's example list but not derived by
 * `deriveReasonCodes` below — duplicate-purchase detection is a distinct
 * evaluator this step does not build (see the step-8 report's judgment-call
 * notes). It is kept in the closed set now so a future evaluator doesn't need
 * a schema change to start emitting it.
 *
 * `MISSING_RECEIPT` is emitted by a DIFFERENT evaluator on a different target
 * type: `src/lib/receipt-requests.ts` against `targetType:"bank-line"`, never
 * by `deriveReasonCodes` (which is qbo-purchase-only). It lives in the same
 * closed set because the set is closed by construction: `decodeReasonCodes`
 * filters through `isReasonCode`, so a code missing from KNOWN_CODES decodes
 * to `[]` — which the lifecycle reads as "cleared", and every issue carrying
 * it would self-destruct on the next read.
 */
export type ReasonCode =
    | "NO_RECEIPT"
    | "NO_JOB_COST"
    | "AMOUNT_MISMATCH"
    | "AMOUNT_INDETERMINATE"
    | "CLASSIFICATION_CONFLICT"
    | "UNCLASSIFIED"
    | "UNRECOGNIZED_OUTFLOW"
    | "DUPLICATE"
    | "MISSING_RECEIPT";

const KNOWN_CODES: ReadonlySet<ReasonCode> = new Set([
    "NO_RECEIPT",
    "NO_JOB_COST",
    "AMOUNT_MISMATCH",
    "AMOUNT_INDETERMINATE",
    "CLASSIFICATION_CONFLICT",
    "UNCLASSIFIED",
    "UNRECOGNIZED_OUTFLOW",
    "DUPLICATE",
    "MISSING_RECEIPT",
]);

export function isReasonCode(value: unknown): value is ReasonCode {
    return typeof value === "string" && KNOWN_CODES.has(value as ReasonCode);
}

/** Sorted + deduped — the canonical form that goes into `reasonCodes` and is hashed. */
export function canonicalizeReasonCodes(codes: ReasonCode[]): ReasonCode[] {
    return [...new Set(codes)].sort();
}

export function encodeReasonCodes(codes: ReasonCode[]): string {
    return JSON.stringify(canonicalizeReasonCodes(codes));
}

/** Parses a `reasonCodes`/`acknowledgedCodes` column value back into a code
 * array. Fails closed to `[]` on malformed JSON rather than throwing — a
 * corrupted stored value must never crash the evaluator; the lifecycle
 * decision tree treats an empty set the same as "nothing acknowledged yet". */
export function decodeReasonCodes(json: string): ReasonCode[] {
    try {
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isReasonCode);
    } catch {
        return [];
    }
}

/** Untruncated SHA-256 hex digest of the canonical JSON encoding. Never
 * truncate this — a shortened hash reintroduces exactly the collision risk
 * the reason-code redesign (plan punch 9) exists to remove. */
export function hashReasonCodes(codes: ReasonCode[]): string {
    return createHash("sha256").update(encodeReasonCodes(codes)).digest("hex");
}

/**
 * Derive reason codes for one merged register row (`register-merge.ts`'s
 * output — read-only dependency, that module is owned by a parallel
 * workstream and is not modified here). Only rows with
 * `status === "needs-review"` ever produce alertable codes; every other
 * status (including "job-cost-matched", which is deliberately excluded from
 * the actionable queue per plan §2) returns `[]`, which is exactly the
 * lifecycle's "reason set empty" clearing signal.
 *
 * Mirrors `mergeRegister()`'s own needs-review branches one-for-one
 * (register-merge.ts, the `else` missing-edges branch and the two branches
 * above it) so the codes stay in lockstep with the status matrix that
 * produced them. If that matrix's needs-review conditions ever change, this
 * function's branches must change with them.
 */
export function deriveReasonCodes(
    row: Pick<MergedRegisterRow, "status" | "classification" | "edges">,
): ReasonCode[] {
    if (row.status !== "needs-review") return [];

    // register-merge.ts: overhead/owner-draw classification contradicted by a
    // matched job-cost expense ("classification conflict").
    if (row.classification === "overhead" || row.classification === "owner-draw") {
        return ["CLASSIFICATION_CONFLICT"];
    }

    // register-merge.ts: never classified (or explicitly "unknown").
    if (row.classification === "unknown") {
        return ["UNCLASSIFIED"];
    }

    // register-merge.ts: classified job-cost, but one or more of
    // receipt/jobCost/amount didn't all pass (the "job-cost-matched" shape —
    // receipt unknown, jobCost+amount pass — is its own status and never
    // reaches here with status "needs-review").
    if (row.classification === "job-cost" && row.edges) {
        const { receipt, jobCost, amount } = row.edges;
        if (jobCost === "pass" && amount === "indeterminate") {
            return ["AMOUNT_INDETERMINATE"];
        }
        const codes: ReasonCode[] = [];
        if (receipt !== "pass") codes.push("NO_RECEIPT");
        if (jobCost !== "pass") codes.push("NO_JOB_COST");
        if (jobCost === "pass" && amount !== "pass") codes.push("AMOUNT_MISMATCH");
        return codes.length > 0 ? codes : ["UNRECOGNIZED_OUTFLOW"];
    }

    // register-merge.ts: purchase-type reversal (amount > 0, no classification
    // lookup happens on that branch), sign/type conflict on a known money-in
    // type posted negative, or an unrecognized "other" type posted negative
    // (Refund Receipt included) — none of these carry a classification
    // record. The plan's own language for the last two is literally
    // "unrecognized outflow".
    return ["UNRECOGNIZED_OUTFLOW"];
}
