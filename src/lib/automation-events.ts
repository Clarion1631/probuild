import { prisma } from "@/lib/prisma";

/**
 * Append-only event log behind the Automation Command Center.
 *
 * Two kinds:
 *  - "receipt-push": one row per receipt the bot POSTed to the QBO create
 *    endpoint (created / already-exists / fallback / error).
 *  - "qbo-sync": one row per QBO→ProBuild sync run (cron, manual button, or
 *    backfill) with the run counts in `detail`.
 *
 * Logging is FIRE-AND-FORGET everywhere: an event-log failure must never fail
 * the automation it describes — the books write always outranks the audit row.
 */

export interface AutomationEventInput {
    kind: "receipt-push" | "qbo-sync" | "receipt-stage" | "setting";
    stage?: string;
    status: string;
    reason?: string;
    source?: string;
    vendor?: string;
    projectName?: string;
    docNumber?: string;
    fileName?: string;
    amountCents?: number;
    taxCents?: number;
    detail?: Record<string, unknown>;
}

const TEXT_LIMIT = 500;

function clip(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    return value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) : value;
}

/**
 * Never throws — always safe to call (and await) from a money path. AWAIT it
 * in serverless routes: a floating promise started just before the response
 * returns can be frozen and silently dropped when Vercel suspends the
 * function, which would leave holes in the audit trail. One awaited insert
 * costs ~10ms; a swallowed failure costs nothing but the audit row.
 */
/** Bounded, always-valid JSON — naive string slicing would corrupt the document. */
function serializeDetail(detail: Record<string, unknown> | undefined): string | undefined {
    if (!detail) return undefined;
    const serialized = JSON.stringify(detail);
    if (serialized.length <= 4000) return serialized;
    return JSON.stringify({ truncated: true, keys: Object.keys(detail).slice(0, 20) });
}

export async function logAutomationEvent(input: AutomationEventInput): Promise<void> {
    const safeCents = (v: number | undefined) => {
        if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
        const rounded = Math.round(v);
        // Postgres INTEGER bounds — an out-of-range value would fail the insert
        // and silently drop the whole audit row.
        return Math.abs(rounded) <= 2_147_483_647 ? rounded : undefined;
    };
    // Dual-write (Unified Money Register plan §1): the same fileId /
    // qbPurchaseId values already going into `detail` also land in typed
    // columns, so future reads can join on a real id instead of parsing
    // JSON-in-TEXT or the collision-prone 21-char docNumber prefix. `detail`
    // keeps writing unchanged — this is additive, not a cutover.
    const driveFileId =
        typeof input.detail?.fileId === "string" && input.detail.fileId ? input.detail.fileId : undefined;
    const qbPurchaseId =
        typeof input.detail?.qbPurchaseId === "string" && input.detail.qbPurchaseId
            ? input.detail.qbPurchaseId
            : undefined;

    try {
        await prisma.automationEvent.create({
            data: {
                kind: input.kind,
                stage: clip(input.stage),
                status: clip(input.status) ?? "unknown",
                reason: clip(input.reason),
                source: clip(input.source),
                vendor: clip(input.vendor),
                projectName: clip(input.projectName),
                docNumber: clip(input.docNumber),
                fileName: clip(input.fileName),
                amountCents: safeCents(input.amountCents),
                taxCents: safeCents(input.taxCents),
                qbPurchaseId: clip(qbPurchaseId),
                driveFileId: clip(driveFileId),
                detail: serializeDetail(input.detail),
            },
        });
    } catch (error) {
        console.error(
            "automation event log failed",
            error instanceof Error ? error.name : "UnknownError",
        );
    }
}

// ── Dashboard reads ─────────────────────────────────────────────────────────

export interface AutomationDayBucket {
    day: string; // YYYY-MM-DD (UTC)
    created: number;
    fallback: number;
    error: number;
}

/** Receipts per UTC day over the trailing window — the intake graph. */
export async function receiptDailyBuckets(days: number): Promise<AutomationDayBucket[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await prisma.automationEvent.findMany({
        where: { kind: "receipt-push", createdAt: { gte: since } },
        select: { status: true, createdAt: true },
    });
    const byDay = new Map<string, AutomationDayBucket>();
    for (let i = 0; i < days; i++) {
        const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
        byDay.set(day, { day, created: 0, fallback: 0, error: 0 });
    }
    for (const row of rows) {
        const bucket = byDay.get(row.createdAt.toISOString().slice(0, 10));
        if (!bucket) continue;
        // "already-exists" is an idempotent retry of a receipt that WAS
        // created — counting it again would double-count intake volume.
        if (row.status === "created") bucket.created += 1;
        else if (row.status === "fallback") bucket.fallback += 1;
        else if (row.status === "error") bucket.error += 1;
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface AutomationSummary {
    pushedThisMonth: number;
    fallbackThisMonth: number;
    amountCentsThisMonth: number;
    taxCentsThisMonth: number;
    lastSync: { at: Date; status: string; source: string | null; detail: string | null } | null;
    /** created / (created + fallback), 30-day window; null when no traffic */
    handsFreeRate30d: number | null;
}

export async function automationSummary(): Promise<AutomationSummary> {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

    const [monthEvents, last30, lastSyncRow] = await Promise.all([
        prisma.automationEvent.findMany({
            where: { kind: "receipt-push", createdAt: { gte: monthStart } },
            select: { status: true, amountCents: true, taxCents: true },
        }),
        prisma.automationEvent.findMany({
            where: { kind: "receipt-push", createdAt: { gte: thirtyDaysAgo } },
            select: { status: true },
        }),
        prisma.automationEvent.findFirst({
            where: { kind: "qbo-sync" },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true, status: true, source: true, detail: true },
        }),
    ]);

    let pushed = 0, fallback = 0, amountCents = 0, taxCents = 0;
    for (const e of monthEvents) {
        if (e.status === "created") {
            pushed += 1;
            amountCents += e.amountCents ?? 0;
            taxCents += e.taxCents ?? 0;
        } else if (e.status === "fallback") {
            fallback += 1;
        }
    }
    const created30 = last30.filter(e => e.status === "created").length;
    const fb30 = last30.filter(e => e.status === "fallback").length;

    return {
        pushedThisMonth: pushed,
        fallbackThisMonth: fallback,
        amountCentsThisMonth: amountCents,
        taxCentsThisMonth: taxCents,
        lastSync: lastSyncRow
            ? { at: lastSyncRow.createdAt, status: lastSyncRow.status, source: lastSyncRow.source, detail: lastSyncRow.detail }
            : null,
        handsFreeRate30d: created30 + fb30 > 0 ? created30 / (created30 + fb30) : null,
    };
}

export async function recentAutomationEvents(limit: number) {
    return prisma.automationEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(limit, 1), 200),
    });
}

// ── Receipt journeys (per-receipt stage timeline) ───────────────────────────

export interface JourneyStep {
    at: Date;
    stage: string;       // "intake" | "read" | "dedupe" | "email-book" | "push" | "synced"
    status: string;
    reason: string | null;
    detail: string | null;
}

export interface ReceiptJourney {
    /** Display id: Drive fileId's 21-char prefix (= QBO DocNumber). NOT the
     * grouping key — two different Drive fileIds can share this prefix, see
     * `keyConfirmed`. */
    docNumber: string;
    fileName: string | null;
    vendor: string | null;
    projectName: string | null;
    amountCents: number | null;
    taxCents: number | null;
    firstSeen: Date;
    lastSeen: Date;
    steps: JourneyStep[];
    /** Where the receipt ended up. */
    finalState:
        | "booked-api"      // QBO purchase created via the API path
        | "booked-email"    // booked via the legacy email path
        | "parked"          // sitting in _Needs Review, human needed
        | "quarantined"     // duplicate quarantine
        | "error"           // last attempt errored; bot will retry
        | "in-flight";      // seen, not yet booked
    finalReason: string | null;
    /** Set once the 4h sync landed it in ProBuild job costs. */
    syncedExpenseId: string | null;
    syncedProjectName: string | null;
    /** True when this journey was reconstructed from QBO history rather than observed live. */
    backfilled: boolean;
    /** Full Drive fileId (typed column, falling back to legacy event detail JSON) — powers the "Open in Drive" link. */
    driveFileId: string | null;
    /** QBO purchase id (typed column, falling back to legacy event detail JSON) — powers the QBO deep link. */
    qbPurchaseId: string | null;
    /** False when this journey was grouped by the bare 21-char docNumber
     * prefix because no event on it carries a full driveFileId — a prefix
     * collision with a DIFFERENT receipt is possible, so this journey (and
     * any expense match found for it) must never be presented as confirmed. */
    keyConfirmed: boolean;
    /** Validation panel: what actually landed in ProBuild after the sync. */
    synced: {
        expenseId: string;
        projectId: string | null;
        projectName: string | null;
        amountCents: number | null;
        vendor: string | null;
        receiptUrl: string | null;
        syncedAt: Date;
    } | null;
}

/**
 * Resolve the FULL Drive fileId for an automation event: typed column first
 * (dual-write / backfilled), legacy `detail` JSON as fallback. Returns null
 * when neither is available — never derived from the docNumber prefix, which
 * is exactly the ambiguous value this exists to avoid. Exported so callers
 * that need the same resolution against a single known event (the ai-review
 * and verify API routes, via `automation-key-resolver.ts`) don't duplicate
 * this parsing.
 */
export function resolveEventFileId(e: { driveFileId: string | null; detail: string | null }): string | null {
    if (e.driveFileId) return e.driveFileId;
    if (e.detail) {
        try {
            const d = JSON.parse(e.detail) as { fileId?: unknown };
            if (typeof d.fileId === "string" && d.fileId) return d.fileId;
        } catch {
            // malformed detail — no full id derivable from this event
        }
    }
    return null;
}

/** Same idea as `resolveEventFileId`, for the QBO Purchase id. */
export function resolveEventQbPurchaseId(e: { qbPurchaseId: string | null; detail: string | null }): string | null {
    if (e.qbPurchaseId) return e.qbPurchaseId;
    if (e.detail) {
        try {
            const d = JSON.parse(e.detail) as { qbPurchaseId?: unknown };
            if (typeof d.qbPurchaseId === "string" && d.qbPurchaseId) return d.qbPurchaseId;
        } catch {
            // malformed detail — ignore
        }
    }
    return null;
}

function journeyFinalState(steps: JourneyStep[]): { state: ReceiptJourney["finalState"]; reason: string | null } {
    // Booking wins over anything that happened before it.
    for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (s.stage === "push" && (s.status === "created" || s.status === "already-exists")) {
            return { state: "booked-api", reason: null };
        }
        if (s.stage === "email-book" && s.status === "emailed") {
            return { state: "booked-email", reason: s.reason };
        }
    }
    const last = steps[steps.length - 1];
    if (!last) return { state: "in-flight", reason: null };
    if (last.status === "parked") return { state: "parked", reason: last.reason };
    if (last.status === "quarantined") return { state: "quarantined", reason: last.reason };
    if (last.status === "error") return { state: "error", reason: last.reason };
    if (last.stage === "push" && last.status === "fallback") {
        // Declined by the API; the bot books it by email right after — if the
        // email beacon hasn't arrived yet, surface the decline reason.
        return { state: "in-flight", reason: last.reason };
    }
    return { state: "in-flight", reason: last.reason };
}

/** Stable key for a journey, for anywhere a Map/Record needs exactly one
 * entry per journey (React list keys, fix-suggestion lookups, …). Full
 * driveFileId when confirmed; otherwise a composite of the bare docNumber
 * prefix + firstSeen so two journeys sharing that prefix (a real collision)
 * never collide onto the same key. Never key on the bare docNumber alone. */
export function journeyKey(j: { driveFileId: string | null; docNumber: string; firstSeen: Date }): string {
    return j.driveFileId ?? `${j.docNumber}:${j.firstSeen.toISOString()}`;
}

/**
 * Group stage beacons + push events into one timeline per receipt, newest
 * receipt first, and mark the ones the 4-hour sync already landed in
 * ProBuild (matched via the [gtr-file:...] marker the sync copies into the
 * expense description).
 *
 * Returns the COMPLETE list for the trailing `days` window — uncapped.
 * Callers that need a display-size-limited list (the pipeline view) must cap
 * it themselves (see `receiptJourneys` below); anything that keys/looks up a
 * SPECIFIC journey (e.g. the register row drill-down) must use this
 * uncapped list, or a genuinely-matching older journey can silently miss the
 * cap and read as "no audit record".
 */
export async function receiptJourneysAll(days: number): Promise<ReceiptJourney[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const events = await prisma.automationEvent.findMany({
        where: {
            kind: { in: ["receipt-stage", "receipt-push"] },
            createdAt: { gte: since },
            docNumber: { not: null },
        },
        // DESC + cap keeps the NEWEST events when over the cap (asc would
        // silently drop current activity and freeze the dashboard in the past),
        // then restore chronological order for grouping.
        orderBy: { createdAt: "desc" },
        take: 5000,
    });

    events.reverse(); // back to ascending for timeline assembly

    // Grouping key, in trust order: FULL driveFileId, then FULL qbPurchaseId,
    // then the bare 21-char docNumber prefix as a last resort. Two different
    // Drive fileIds can share a prefix (qbo-receipt-push.ts:477-481), so
    // keying by prefix alone would silently merge two different receipts'
    // timelines into one journey — but keying SOLELY by fileId also misses
    // real matches: events that never recorded a fileId can still carry the
    // same typed qbPurchaseId (near-zero collision risk, same trust tier
    // `automation-key-resolver.ts` gives it), and without that tier those
    // events would stay split into separate, incomplete journeys. An event
    // with neither id groups under a `prefix:`-tagged bucket (distinct from
    // any real fileId/qbPurchaseId string) and the resulting journey is
    // marked `keyConfirmed: false`.
    const byDoc = new Map<string, ReceiptJourney>();
    for (const e of events) {
        const doc = e.docNumber as string;
        const fileId = resolveEventFileId(e);
        const qbPurchaseId = resolveEventQbPurchaseId(e);
        const key = fileId ?? (qbPurchaseId ? `qb:${qbPurchaseId}` : `prefix:${doc}`);
        let j = byDoc.get(key);
        if (!j) {
            j = {
                docNumber: doc,
                fileName: null, vendor: null, projectName: null,
                amountCents: null, taxCents: null,
                firstSeen: e.createdAt, lastSeen: e.createdAt,
                steps: [], finalState: "in-flight", finalReason: null,
                syncedExpenseId: null, syncedProjectName: null,
                driveFileId: fileId, qbPurchaseId: null, synced: null, backfilled: false,
                keyConfirmed: Boolean(fileId) || Boolean(qbPurchaseId),
            };
            byDoc.set(key, j);
        }
        j.lastSeen = e.createdAt;
        if (e.source === "backfill") j.backfilled = true;
        j.fileName = e.fileName ?? j.fileName;
        j.vendor = e.vendor ?? j.vendor;
        j.projectName = e.projectName ?? j.projectName;
        j.amountCents = e.amountCents ?? j.amountCents;
        j.taxCents = e.taxCents ?? j.taxCents;
        j.driveFileId = j.driveFileId ?? fileId;
        if (qbPurchaseId) j.qbPurchaseId = qbPurchaseId;
        j.steps.push({
            at: e.createdAt,
            stage: e.stage ?? (e.kind === "receipt-push" ? "push" : "unknown"),
            status: e.status,
            reason: e.reason,
            detail: e.detail,
        });
    }

    for (const j of byDoc.values()) {
        const final = journeyFinalState(j.steps);
        j.finalState = final.state;
        j.finalReason = final.reason;
    }

    // Sync landing: expenses carry the QBO PrivateNote (with the full
    // [gtr-file:<fileId>] marker) in their description.
    const booked = [...byDoc.values()].filter(j => j.finalState === "booked-api");
    if (booked.length > 0) {
        const expenses = await prisma.expense.findMany({
            where: {
                qbPurchaseId: { not: null },
                description: { contains: "[gtr-file:" },
                createdAt: { gte: since },
            },
            select: {
                id: true,
                description: true,
                amount: true,
                vendor: true,
                receiptUrl: true,
                qbSyncedAt: true,
                createdAt: true,
                qbPurchaseId: true,
                // Expense hangs off the ESTIMATE, not the project directly.
                estimate: { select: { project: { select: { id: true, name: true } } } },
            },
            take: 2000,
        });
        for (const exp of expenses) {
            const m = exp.description?.match(/\[gtr-file:([^\]]+)\]/);
            if (!m) continue;
            const fullId = m[1];
            // Confirmed match, in trust order: a journey already keyed on
            // this exact fileId, then one keyed on this exact qbPurchaseId
            // (same journeys.ts grouping tiers above). Only when NEITHER
            // exists do we fall back to the bare prefix bucket — which may
            // belong to a DIFFERENT colliding fileId — so that fallback
            // match is marked unconfirmed rather than sure.
            let j = byDoc.get(fullId);
            if (!j && exp.qbPurchaseId) {
                j = byDoc.get(`qb:${exp.qbPurchaseId}`);
            }
            if (!j) {
                j = byDoc.get(`prefix:${fullId.slice(0, 21)}`);
                if (j) j.keyConfirmed = false;
            }
            if (j) {
                const syncedAt = exp.qbSyncedAt ?? exp.createdAt;
                j.syncedExpenseId = exp.id;
                j.syncedProjectName = exp.estimate?.project?.name ?? null;
                j.driveFileId = j.driveFileId ?? fullId;
                j.synced = {
                    expenseId: exp.id,
                    projectId: exp.estimate?.project?.id ?? null,
                    projectName: exp.estimate?.project?.name ?? null,
                    // Prisma Decimal → cents; guard the conversion, this is display data.
                    amountCents: exp.amount != null ? Math.round(Number(exp.amount) * 100) : null,
                    vendor: exp.vendor ?? null,
                    receiptUrl: exp.receiptUrl ?? null,
                    syncedAt,
                };
                // The expense records when the sync actually landed it — never
                // fabricate the step time from unrelated event timestamps.
                j.steps.push({ at: syncedAt, stage: "synced", status: "ok", reason: null, detail: null });
            }
        }
    }

    return [...byDoc.values()].sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
}

/**
 * Display-capped wrapper around `receiptJourneysAll` for the pipeline list
 * view, which genuinely only ever renders a bounded number of rows. Never
 * use this for a lookup/match against one specific journey (e.g. the
 * register row drill-down) — an older, genuinely-matching journey can sit
 * just past the cap and read as "no audit record" even though it exists;
 * use `receiptJourneysAll` for that instead.
 */
export async function receiptJourneys(days: number, maxReceipts: number): Promise<ReceiptJourney[]> {
    const all = await receiptJourneysAll(days);
    return all.slice(0, Math.min(Math.max(maxReceipts, 1), 200));
}
