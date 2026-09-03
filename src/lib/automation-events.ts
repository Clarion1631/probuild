import { prisma } from "@/lib/prisma";

/**
 * Append-only event log behind the Automation Command Center.
 *
 * Two kinds:
 *  - "receipt-push": one row per receipt the bot POSTed to the QBO create
 *    endpoint (created / already-exists / fallback / error).
 *  - "qbo-sync": one row per QBO→ProBuild sync run (cron, manual button, or
 *    backfill) with the run counts in `detail`.
 *  - "qbo-payments-sync": one row per payments-sync run (the money rail), so a
 *    QBO outage there is visible to the health check instead of vanishing into
 *    a cron log.
 *
 * Logging is FIRE-AND-FORGET everywhere: an event-log failure must never fail
 * the automation it describes — the books write always outranks the audit row.
 */

export interface AutomationEventInput {
    kind: "receipt-push" | "qbo-sync" | "receipt-stage" | "setting" | "qbo-payments-sync";
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
/** The column budget for a serialized `detail`. */
const DETAIL_LIMIT = 4000;
/** How much of any ONE value survives once the document is over budget. */
const DETAIL_VALUE_LIMIT = 500;

/** One oversized value, clipped, with its real length still on the record. */
function clipDetailValue(value: unknown): unknown {
    const text = typeof value === "string" ? value : undefined;
    if (text !== undefined) {
        return text.length > DETAIL_VALUE_LIMIT
            ? `${text.slice(0, DETAIL_VALUE_LIMIT)} [+${text.length - DETAIL_VALUE_LIMIT} chars]`
            : text;
    }
    if (value === null || typeof value !== "object") return value;
    // A nested object or array: keep it if it is small, otherwise record it as
    // clipped JSON rather than dropping the key entirely.
    let nested: string | undefined;
    try {
        nested = JSON.stringify(value);
    } catch {
        return "[unserializable]";
    }
    if (nested === undefined) return undefined;
    return nested.length > DETAIL_VALUE_LIMIT
        ? `${nested.slice(0, DETAIL_VALUE_LIMIT)} [+${nested.length - DETAIL_VALUE_LIMIT} chars]`
        : value;
}

/**
 * Bounded, always-valid JSON — naive string slicing would corrupt the document.
 *
 * Truncation is now VALUE BY VALUE. The old form replaced the whole payload
 * with a list of key names, which threw the record away precisely when it
 * mattered: an ambiguous-create resolution logs the actor, the decision and the
 * operator note beside a long create marker, and one oversized field took all
 * of them with it — leaving an audit row that recorded a money decision was
 * made and nothing about who made it or why.
 *
 * Now the long field is the only thing that loses anything. If clipping every
 * value is still not enough (many fields rather than one long one), keys are
 * dropped LONGEST FIRST, so the short high-signal ones — ids, actor, decision,
 * reason — are the last to go, and the ones dropped are named.
 */
export function serializeDetail(detail: Record<string, unknown> | undefined): string | undefined {
    if (!detail) return undefined;
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(detail);
    } catch {
        // A cycle or a BigInt. Never fail the caller over an audit row.
        return JSON.stringify({ truncated: true, keys: Object.keys(detail).slice(0, 20) });
    }
    if (serialized !== undefined && serialized.length <= DETAIL_LIMIT) return serialized;

    const clipped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(detail)) {
        const kept = clipDetailValue(value);
        if (kept !== undefined) clipped[key] = kept;
    }
    let out = JSON.stringify({ ...clipped, truncated: true });
    if (out.length <= DETAIL_LIMIT) return out;

    // Still over. Shed the most expensive keys until it fits.
    const byCost = Object.keys(clipped).sort(
        (a, b) => (JSON.stringify(clipped[b]) ?? "").length - (JSON.stringify(clipped[a]) ?? "").length,
    );
    const dropped: string[] = [];
    while (out.length > DETAIL_LIMIT && byCost.length > 0) {
        const key = byCost.shift() as string;
        delete clipped[key];
        dropped.push(key);
        out = JSON.stringify({ ...clipped, truncated: true, droppedKeys: dropped });
    }
    // Everything was dropped and it STILL does not fit (a pathological key
    // list). Fall back to the smallest honest statement rather than an insert
    // that would fail and take the whole audit row with it.
    return out.length <= DETAIL_LIMIT
        ? out
        : JSON.stringify({ truncated: true, droppedKeys: dropped.slice(0, 20) });
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
        // attachment-failed posted a Purchase but lost the receipt: an error
        // on the graph, never a clean create.
        else if (row.status === "error" || row.status === "attachment-failed") bucket.error += 1;
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
        } else if (e.status === "fallback" || e.status === "attachment-failed") {
            // Booked without a receipt still needs a human to finish it, so it
            // counts against the hands-free rate rather than as a clean push.
            fallback += 1;
        }
    }
    const created30 = last30.filter(e => e.status === "created").length;
    const fb30 = last30.filter(e => e.status === "fallback" || e.status === "attachment-failed").length;

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
        // Booked, but the receipt image never landed — surfaced as an error so
        // it appears in the worklist instead of reading as a clean booking.
        if (s.stage === "push" && s.status === "attachment-failed") {
            return { state: "error", reason: s.reason ?? "attachment failed" };
        }
        if (s.stage === "email-book" && s.status === "emailed") {
            return { state: "booked-email", reason: s.reason };
        }
    }
    const last = steps[steps.length - 1];
    if (!last) return { state: "in-flight", reason: null };
    // A Purchase that posted without its receipt image. Terminal (the bot will
    // not resend), so leaving it "in-flight" hid a receipt that is never
    // arriving behind a status that reads like "still working on it".
    if (last.status === "attachment-failed") {
        return { state: "error", reason: last.reason ?? "attachment failed" };
    }
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
 * entry per journey (React list keys, fix-suggestion lookups, …). Trust
 * order: full driveFileId, then full qbPurchaseId, then a composite of the
 * bare docNumber prefix + firstSeen — mirrors the grouping tiers in
 * `groupEventsIntoJourneys` below. Two QBO-only journeys can share a
 * docNumber prefix (and, at second resolution, even a `firstSeen` instant),
 * so the qbPurchaseId tier must come BEFORE the prefix+firstSeen fallback or
 * their keys can collide. Never key on the bare docNumber alone. */
export function journeyKey(j: { driveFileId: string | null; qbPurchaseId: string | null; docNumber: string; firstSeen: Date }): string {
    return j.driveFileId ?? (j.qbPurchaseId ? `qb:${j.qbPurchaseId}` : `${j.docNumber}:${j.firstSeen.toISOString()}`);
}

/** Minimal shape `groupEventsIntoJourneys` needs from an AutomationEvent row —
 * a subset of the Prisma model so the grouping logic stays testable against
 * plain objects instead of a live database. */
export interface JourneyEventInput {
    id: string;
    kind: string;
    stage: string | null;
    status: string;
    reason: string | null;
    source: string | null;
    vendor: string | null;
    projectName: string | null;
    docNumber: string | null;
    fileName: string | null;
    amountCents: number | null;
    taxCents: number | null;
    qbPurchaseId: string | null;
    driveFileId: string | null;
    detail: string | null;
    createdAt: Date;
}

/**
 * Group stage beacons + push events into one timeline per receipt.
 *
 * N1 fix: earlier code had each event independently pick ONE key (fileId,
 * else qbPurchaseId, else docNumber prefix) as it was folded in. That let
 * one receipt split across two journeys — e.g. a QBO-only event (carries
 * qbPurchaseId but no fileId yet) landing under `qb:<id>` while an earlier
 * prefix-only stage beacon for the SAME receipt stayed under `prefix:<doc>`.
 * One of the two journeys could then read "booked/synced" while the other
 * read "stuck" and got a fix suggestion — actively wrong, not just
 * incomplete.
 *
 * Fixed with a union-find pass BEFORE any journey object is built: every
 * event that shares a fileId with another event is unioned into the same
 * group, same for qbPurchaseId, and any event carrying BOTH ids is the
 * bridge that reconciles a fileId-only cluster with a qbPurchaseId-only
 * cluster describing the same receipt. An id-less event (e.g. an "intake"
 * stage beacon logged before the bot had booked anything) is then bridged
 * into whichever id-confirmed cluster is the SOLE one sharing its docNumber
 * — that's the actual N1 scenario above, and docNumber being derived from
 * the same fileId at logging time makes this overwhelmingly the SAME
 * receipt. "Overwhelmingly", not certainly, though: a genuinely different
 * receipt whose OWN id-confirmed evidence hasn't arrived yet could still
 * collide on that prefix, and there is no data at this point to rule that
 * out. Codex round 1 finding 5: because of that, a journey built from a
 * cluster that includes even one member joined ONLY via this heuristic
 * never reports `keyConfirmed: true`, regardless of how much real
 * driveFileId/qbPurchaseId evidence the OTHER members carry — see
 * `weaklyBridgedIndices` below. When a docNumber has more than one distinct
 * id-confirmed cluster (a genuine collision), id-less events sharing it are
 * never guessed onto either — they fall back to their own per-docNumber-
 * prefix bucket instead (still `keyConfirmed: false`; a prefix collision
 * between two genuinely different receipts that both lack any id anywhere
 * is a real, disclosed limitation this fix does not attempt to resolve —
 * there is no data to disambiguate them with). This whole pass is
 * order-independent by construction — the same input set produces the same
 * groups regardless of what order the events happen to arrive in.
 *
 * Events are sorted by (createdAt, id) before grouping — id is a
 * deterministic tie-breaker for events sharing the same millisecond
 * timestamp, so journey.steps/firstSeen/lastSeen assembly never depends on
 * incidental DB/array order.
 */
export function groupEventsIntoJourneys(events: JourneyEventInput[]): Map<string, ReceiptJourney> {
    const sorted = [...events].sort((a, b) => {
        const t = a.createdAt.getTime() - b.createdAt.getTime();
        if (t !== 0) return t;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const parent = sorted.map((_, i) => i);
    function find(i: number): number {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    }
    function union(a: number, b: number) {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    }

    const byFileId = new Map<string, number>();
    const byQbPurchaseId = new Map<string, number>();
    sorted.forEach((e, i) => {
        const fileId = resolveEventFileId(e);
        const qbPurchaseId = resolveEventQbPurchaseId(e);
        if (fileId) {
            const existing = byFileId.get(fileId);
            if (existing !== undefined) union(i, existing);
            else byFileId.set(fileId, i);
        }
        if (qbPurchaseId) {
            const existing = byQbPurchaseId.get(qbPurchaseId);
            if (existing !== undefined) union(i, existing);
            else byQbPurchaseId.set(qbPurchaseId, i);
        }
        // The bridge: an event carrying BOTH ids ties the fileId cluster and
        // the qbPurchaseId cluster together — this is the actual N1 fix.
        if (fileId && qbPurchaseId) {
            union(byFileId.get(fileId)!, byQbPurchaseId.get(qbPurchaseId)!);
        }
    });

    // Events with neither id (e.g. an "intake" stage beacon logged before
    // the bot had booked anything, whose logging path never dual-wrote a
    // typed column): bridge them into the SINGLE id-confirmed cluster that
    // shares their docNumber, when there is exactly one. docNumber is
    // derived from the same fileId at logging time for every event in one
    // receipt's real timeline, so an id-less event and a later id-confirmed
    // event sharing a docNumber are overwhelmingly the SAME receipt — this
    // is what actually reconciles a prefix-only stage beacon with the push
    // event for that same receipt (the N1 scenario). Never guess when a
    // docNumber has MORE THAN ONE distinct id-confirmed cluster (a genuine
    // collision) — id-less events for that docNumber are left out of both
    // rather than arbitrarily attached to one of the colliding receipts.
    const idRootsByDoc = new Map<string, Set<number>>();
    sorted.forEach((e, i) => {
        if (!resolveEventFileId(e) && !resolveEventQbPurchaseId(e)) return;
        const doc = e.docNumber as string;
        const roots = idRootsByDoc.get(doc) ?? new Set<number>();
        roots.add(find(i));
        idRootsByDoc.set(doc, roots);
    });
    // Codex round 1 finding 5: this bridge is a HEURISTIC, not proof — it
    // cannot actually distinguish "this id-less event really is this
    // receipt" from "this id-less event is a genuinely DIFFERENT receipt
    // that merely collides on the same docNumber prefix" (there is no data
    // to tell the two apart, per the doc comment above). Track every index
    // unioned in via this step so the journey it lands in never inherits
    // `keyConfirmed: true` on the strength of a guess — see where
    // `weaklyBridgedIndices` is read below.
    const weaklyBridgedIndices = new Set<number>();
    sorted.forEach((e, i) => {
        if (resolveEventFileId(e) || resolveEventQbPurchaseId(e)) return;
        const roots = idRootsByDoc.get(e.docNumber as string);
        if (roots && roots.size === 1) {
            union(i, [...roots][0]);
            weaklyBridgedIndices.add(i);
        }
    });

    // Any id-less events NOT bridged above (no id-confirmed cluster shares
    // their docNumber, or more than one genuinely does) bucket by bare
    // docNumber prefix among themselves only — never merged into an
    // id-confirmed group just because it shares that group's docNumber,
    // which is exactly the collision this whole scheme exists to avoid.
    const byPrefix = new Map<string, number>();
    sorted.forEach((e, i) => {
        if (resolveEventFileId(e) || resolveEventQbPurchaseId(e)) return;
        const doc = e.docNumber as string;
        const roots = idRootsByDoc.get(doc);
        if (roots && roots.size === 1) return; // already bridged above
        const existing = byPrefix.get(doc);
        if (existing !== undefined) union(i, existing);
        else byPrefix.set(doc, i);
    });

    const groups = new Map<number, number[]>();
    sorted.forEach((_, i) => {
        const root = find(i);
        const arr = groups.get(root);
        if (arr) arr.push(i);
        else groups.set(root, [i]);
    });

    const journeys = new Map<string, ReceiptJourney>();
    for (const indices of groups.values()) {
        const groupEvents = indices.map((i) => sorted[i]); // already ascending (createdAt, id)
        let driveFileId: string | null = null;
        let qbPurchaseId: string | null = null;
        for (const e of groupEvents) {
            driveFileId = driveFileId ?? resolveEventFileId(e);
            const qb = resolveEventQbPurchaseId(e);
            if (qb) qbPurchaseId = qb;
        }
        const doc = groupEvents[0].docNumber as string;
        const key = driveFileId ?? (qbPurchaseId ? `qb:${qbPurchaseId}` : `prefix:${doc}`);

        // Finding 5: real id evidence (driveFileId/qbPurchaseId) on the
        // group is necessary but not sufficient — if ANY member only joined
        // via the doc-prefix bridge heuristic above, that member (and
        // therefore this whole reconciliation) is still a guess, so the
        // journey must never present as confirmed on the strength of the
        // OTHER members' real ids.
        const hasWeakBridgeMember = indices.some((i) => weaklyBridgedIndices.has(i));

        const j: ReceiptJourney = {
            docNumber: doc,
            fileName: null, vendor: null, projectName: null,
            amountCents: null, taxCents: null,
            firstSeen: groupEvents[0].createdAt,
            lastSeen: groupEvents[groupEvents.length - 1].createdAt,
            steps: [], finalState: "in-flight", finalReason: null,
            syncedExpenseId: null, syncedProjectName: null,
            driveFileId, qbPurchaseId, synced: null, backfilled: false,
            keyConfirmed: (Boolean(driveFileId) || Boolean(qbPurchaseId)) && !hasWeakBridgeMember,
        };
        for (const e of groupEvents) {
            if (e.source === "backfill") j.backfilled = true;
            j.fileName = e.fileName ?? j.fileName;
            j.vendor = e.vendor ?? j.vendor;
            j.projectName = e.projectName ?? j.projectName;
            j.amountCents = e.amountCents ?? j.amountCents;
            j.taxCents = e.taxCents ?? j.taxCents;
            j.steps.push({
                at: e.createdAt,
                stage: e.stage ?? (e.kind === "receipt-push" ? "push" : "unknown"),
                status: e.status,
                reason: e.reason,
                detail: e.detail,
            });
        }
        const final = journeyFinalState(j.steps);
        j.finalState = final.state;
        j.finalReason = final.reason;
        journeys.set(key, j);
    }
    return journeys;
}

/** Fields the sync-landing join (`attachSyncedExpenses`) needs off the
 * Expense row, whichever caller fetched it. */
interface SyncedExpenseInput {
    id: string;
    description: string | null;
    amount: unknown; // Prisma Decimal — converted with Number(), display data only
    vendor: string | null;
    receiptUrl: string | null;
    qbSyncedAt: Date | null;
    createdAt: Date;
    qbPurchaseId: string | null;
    estimate: { project: { id: string; name: string } | null } | null;
}

/**
 * Mark the journeys the 4-hour sync already landed in ProBuild job costs,
 * matched via the [gtr-file:<fileId>] marker the sync copies into the
 * Expense description. Mutates `journeys` in place.
 *
 * Codex round 1 finding 8: more than one Expense can carry a marker that
 * resolves to the SAME journey (a resync, a duplicate Expense row, a rare
 * marker collision). The old code applied whichever one it happened to
 * iterate last — silently overwriting an earlier match and depending on
 * `expenses`' incidental array order rather than which one is actually
 * newest. Fixed by collecting every match per journey FIRST, then: the
 * NEWEST (by `syncedAt`, compared explicitly, with `createdAt` desc then
 * `id` desc as deterministic tie-breakers for an exact `syncedAt` tie — see
 * the sort comparator below) wins the journey's `synced` fields; if more
 * than one Expense matched, a single "ambiguous" step is appended instead of
 * one "synced" step per match, so the ambiguity is visible rather than
 * silently resolved; and `j.steps` is re-sorted by `at` afterward, since an
 * appended sync-landing timestamp is not guaranteed to fall after every
 * existing step (it comes from the sync run, not the receipt-push event
 * stream this journey's other steps were built from).
 */
function attachSyncedExpenses(journeys: Map<string, ReceiptJourney>, expenses: SyncedExpenseInput[]): void {
    const matchesByJourney = new Map<ReceiptJourney, { exp: SyncedExpenseInput; fullId: string }[]>();
    for (const exp of expenses) {
        const m = exp.description?.match(/\[gtr-file:([^\]]+)\]/);
        if (!m) continue;
        const fullId = m[1];
        // Confirmed match, in trust order: a journey already keyed on this
        // exact fileId, then one keyed on this exact qbPurchaseId (same
        // grouping tiers as `groupEventsIntoJourneys`). Only when NEITHER
        // exists do we fall back to the bare prefix bucket — which may
        // belong to a DIFFERENT colliding fileId — so that fallback match is
        // marked unconfirmed rather than sure.
        let j = journeys.get(fullId);
        if (!j && exp.qbPurchaseId) {
            j = journeys.get(`qb:${exp.qbPurchaseId}`);
        }
        if (!j) {
            j = journeys.get(`prefix:${fullId.slice(0, 21)}`);
            if (j) j.keyConfirmed = false;
        }
        if (!j) continue;
        const entry = { exp, fullId };
        const existing = matchesByJourney.get(j);
        if (existing) existing.push(entry);
        else matchesByJourney.set(j, [entry]);
    }

    for (const [j, matches] of matchesByJourney) {
        // Codex round 2 finding 8 completion: `syncedAt` values can tie
        // (two Expense rows synced in the same batch, or both falling back
        // to an identical `createdAt`) — a comparator that returns 0 on a
        // tie leaves `.sort()`'s ordering unspecified (V8 is stable, but
        // relying on incidental array order is exactly what this fix was
        // supposed to stop doing). Break ties deterministically: newest
        // `createdAt` next, then highest `id` (plain string compare is fine
        // — this only needs to be a STABLE, deterministic pick, not a
        // meaningful ordering).
        const withSyncedAt = matches
            .map((m) => ({ ...m, syncedAt: m.exp.qbSyncedAt ?? m.exp.createdAt }))
            .sort((a, b) => {
                const bySyncedAt = b.syncedAt.getTime() - a.syncedAt.getTime();
                if (bySyncedAt !== 0) return bySyncedAt;
                const byCreatedAt = b.exp.createdAt.getTime() - a.exp.createdAt.getTime();
                if (byCreatedAt !== 0) return byCreatedAt;
                return a.exp.id < b.exp.id ? 1 : a.exp.id > b.exp.id ? -1 : 0;
            });
        const { exp: newest, fullId, syncedAt } = withSyncedAt[0];

        j.syncedExpenseId = newest.id;
        j.syncedProjectName = newest.estimate?.project?.name ?? null;
        j.driveFileId = j.driveFileId ?? fullId;
        j.synced = {
            expenseId: newest.id,
            projectId: newest.estimate?.project?.id ?? null,
            projectName: newest.estimate?.project?.name ?? null,
            // Prisma Decimal → cents; guard the conversion, this is display data.
            amountCents: newest.amount != null ? Math.round(Number(newest.amount) * 100) : null,
            vendor: newest.vendor ?? null,
            receiptUrl: newest.receiptUrl ?? null,
            syncedAt,
        };

        if (withSyncedAt.length > 1) {
            j.steps.push({
                at: syncedAt,
                stage: "synced",
                status: "ambiguous",
                reason: `${withSyncedAt.length} synced Expense records matched this receipt — showing the most recent`,
                detail: null,
            });
        } else {
            // The expense records when the sync actually landed it — never
            // fabricate the step time from unrelated event timestamps.
            j.steps.push({ at: syncedAt, stage: "synced", status: "ok", reason: null, detail: null });
        }
        j.steps.sort((a, b) => a.at.getTime() - b.at.getTime());
    }
}

const SYNCED_EXPENSE_SELECT = {
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
} as const;

/** B2: an unordered `take` cap can silently drop EITHER side of the window
 * (Postgres gives no ordering guarantee without ORDER BY) — always order the
 * sync-Expense query deterministically, and log (never swallow) when the cap
 * was actually hit so a truncated read leaves a trace instead of quietly
 * reading as "no receipt record". */
async function fetchSyncedExpensesSince(since: Date): Promise<SyncedExpenseInput[]> {
    const cap = 2000;
    const expenses = await prisma.expense.findMany({
        where: {
            qbPurchaseId: { not: null },
            description: { contains: "[gtr-file:" },
            createdAt: { gte: since },
        },
        select: SYNCED_EXPENSE_SELECT,
        orderBy: { createdAt: "desc" },
        take: cap,
    });
    if (expenses.length === cap) {
        console.error(`receiptJourneysAll: sync-Expense query hit its ${cap}-row cap — some sync-landing evidence may be missing from this render`);
    }
    return expenses;
}

/** `receiptJourneysAll`'s return, now that it can no longer promise a
 * COMPLETE list (see `truncated` below and Codex round 1 finding 7's fix to
 * this function's old, inaccurate doc comment). */
export interface ReceiptJourneysResult {
    journeys: ReceiptJourney[];
    /** True when the underlying event query hit its row cap — this window's
     * events (and therefore its journeys/steps) may be missing older audit
     * evidence. Callers that draw conclusions from a journey's COMPLETE
     * history (suggestion cards, "stuck"/stale diagnoses) must suppress
     * those when this is true, since they'd be judging partial data. */
    truncated: boolean;
}

/**
 * Returns journeys for the trailing `days` window. Finding 7: despite the
 * name and the old doc comment here, this was NEVER actually uncapped — the
 * event query below has always had a 5000-row cap (see `cap`). Callers that
 * need a display-size-limited list (the pipeline view) cap it themselves
 * (see `receiptJourneys` below); anything that keys/looks up a SPECIFIC
 * journey (e.g. the register row drill-down) should prefer
 * `receiptJourneysForKeys` instead, which fetches exactly the events for the
 * identifiers it's asked about rather than depending on this function's cap.
 */
export async function receiptJourneysAll(days: number): Promise<ReceiptJourneysResult> {
    const since = new Date(Date.now() - days * 86_400_000);
    const cap = 5000;
    const events = await prisma.automationEvent.findMany({
        where: {
            kind: { in: ["receipt-stage", "receipt-push"] },
            createdAt: { gte: since },
            docNumber: { not: null },
        },
        // DESC + cap keeps the NEWEST events when over the cap (asc would
        // silently drop current activity and freeze the dashboard in the past).
        orderBy: { createdAt: "desc" },
        take: cap,
    });
    const truncated = events.length === cap;
    if (truncated) {
        console.error(`receiptJourneysAll: event query hit its ${cap}-row cap — some older audit evidence may be missing from this render`);
    }

    const journeys = groupEventsIntoJourneys(events);

    const booked = [...journeys.values()].some((j) => j.finalState === "booked-api");
    if (booked) {
        const expenses = await fetchSyncedExpensesSince(since);
        attachSyncedExpenses(journeys, expenses);
    }

    return {
        journeys: [...journeys.values()].sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime()),
        truncated,
    };
}

/**
 * Display-capped wrapper around `receiptJourneysAll` for the pipeline list
 * view, which genuinely only ever renders a bounded number of rows. Never
 * use this for a lookup/match against one specific journey (e.g. the
 * register row drill-down) — an older, genuinely-matching journey can sit
 * just past the cap and read as "no audit record" even though it exists;
 * use `receiptJourneysAll` or `receiptJourneysForKeys` for that instead.
 * `truncated` propagates from `receiptJourneysAll` unchanged — slicing the
 * DISPLAY list down doesn't make the underlying event read any less partial.
 */
export async function receiptJourneys(days: number, maxReceipts: number): Promise<ReceiptJourneysResult> {
    const all = await receiptJourneysAll(days);
    return {
        journeys: all.journeys.slice(0, Math.min(Math.max(maxReceipts, 1), 200)),
        truncated: all.truncated,
    };
}

/**
 * N2/B2: targeted journey lookup for the register row drill-down. Instead of
 * matching every register row against a bulk, count-capped journey list
 * (an R × J scan on the page that carries the money register, and one whose
 * cap could silently drop a genuinely-matching older journey), this fetches
 * ONLY the events that could belong to the receipts named by `keys` —
 * expected to stay well within the hard cap below given the register's own
 * row count — and returns them pre-indexed by both lookup tiers
 * `matchReceiptJourney` needs.
 *
 * `byQbPurchaseId` covers the confirmed match path (`journey.qbPurchaseId ===
 * row.qbTxnId`); `byDocNumber` covers the always-unconfirmed prefix-fallback
 * path. When more than one journey shares a docNumber (a real prefix
 * collision), the journey with the most recent `lastSeen` wins the map slot —
 * the same tie-break `matchReceiptJourney`'s old `.find()` against a
 * newest-first list produced.
 *
 * Codex round 1 finding 6: the event query used to have no `take` at all,
 * trusting the id lists above to keep it bounded — true in the common case,
 * but a register page covering many months/rows could still hand this a
 * large enough id list to pull an unbounded number of events. Now capped at
 * `EVENTS_CAP`, with `truncated` surfaced so a caller can show the SAME
 * degraded-data warning it already shows for other partial reads (page.tsx),
 * rather than silently rendering some drill-downs from a partial event set.
 */
export async function receiptJourneysForKeys(
    keys: { qbPurchaseId: string | null; docNumber: string | null }[],
    days: number,
): Promise<{ byQbPurchaseId: Map<string, ReceiptJourney>; byDocNumber: Map<string, ReceiptJourney>; truncated: boolean }> {
    const EVENTS_CAP = 2000;
    const docNumbers = [...new Set(keys.map((k) => k.docNumber).filter((v): v is string => Boolean(v)))];
    const qbPurchaseIds = [...new Set(keys.map((k) => k.qbPurchaseId).filter((v): v is string => Boolean(v)))];

    const byQbPurchaseId = new Map<string, ReceiptJourney>();
    const byDocNumber = new Map<string, ReceiptJourney>();
    if (docNumbers.length === 0 && qbPurchaseIds.length === 0) {
        return { byQbPurchaseId, byDocNumber, truncated: false };
    }

    const since = new Date(Date.now() - days * 86_400_000);
    const events = await prisma.automationEvent.findMany({
        where: {
            kind: { in: ["receipt-stage", "receipt-push"] },
            createdAt: { gte: since },
            docNumber: { not: null },
            OR: [
                ...(docNumbers.length ? [{ docNumber: { in: docNumbers } }] : []),
                ...(qbPurchaseIds.length ? [{ qbPurchaseId: { in: qbPurchaseIds } }] : []),
            ],
        },
        // DESC + cap, same convention as receiptJourneysAll's — keeps the
        // NEWEST events for each matched identifier when the hard cap below
        // is actually hit.
        orderBy: { createdAt: "desc" },
        take: EVENTS_CAP,
    });
    const truncated = events.length === EVENTS_CAP;
    if (truncated) {
        console.error(`receiptJourneysForKeys: event query hit its ${EVENTS_CAP}-row cap — some drill-downs may be built from partial journey history`);
    }

    const journeys = groupEventsIntoJourneys(events);

    const booked = [...journeys.values()].some((j) => j.finalState === "booked-api");
    if (booked && qbPurchaseIds.length > 0) {
        const expenses = await prisma.expense.findMany({
            where: { qbPurchaseId: { in: qbPurchaseIds }, description: { contains: "[gtr-file:" } },
            select: SYNCED_EXPENSE_SELECT,
            orderBy: { createdAt: "desc" },
        });
        attachSyncedExpenses(journeys, expenses);
    }

    return { ...indexJourneysByKeys([...journeys.values()]), truncated };
}

/**
 * Pure indexing step of `receiptJourneysForKeys`, split out so it's testable
 * without a database: builds the two lookup tiers `matchReceiptJourney`
 * needs from an already-grouped journey list. Newest `lastSeen` first, so
 * when more than one journey shares a docNumber (a real prefix collision)
 * the map keeps the most recently active one — the same tie-break a
 * `.find()` against a newest-first list gave before this fix.
 */
export function indexJourneysByKeys(
    journeys: ReceiptJourney[],
): { byQbPurchaseId: Map<string, ReceiptJourney>; byDocNumber: Map<string, ReceiptJourney> } {
    const byQbPurchaseId = new Map<string, ReceiptJourney>();
    const byDocNumber = new Map<string, ReceiptJourney>();
    const sorted = [...journeys].sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
    for (const j of sorted) {
        if (j.qbPurchaseId && !byQbPurchaseId.has(j.qbPurchaseId)) byQbPurchaseId.set(j.qbPurchaseId, j);
        if (!byDocNumber.has(j.docNumber)) byDocNumber.set(j.docNumber, j);
    }
    return { byQbPurchaseId, byDocNumber };
}
