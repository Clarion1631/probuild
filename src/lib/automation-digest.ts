/**
 * Daily "posted yesterday" digest to Vanessa (Goal 1,
 * docs/plans/vanessa-review-loop-plan.md). An hourly Vercel cron hits
 * src/app/api/automation/digest/route.ts, which calls runDigestTick() here.
 *
 * Source of truth is QBO itself — this queries live Purchases by
 * MetaData.CreateTime and filters to automation-created ones by the
 * [gtr-file:...] marker in PrivateNote. Local automation_events rows are used
 * ONLY to enrich with a Drive link when known; audit-log inserts are
 * fire-and-forget (src/lib/automation-events.ts) and must never be the
 * primary source for a real books digest.
 *
 * Every hourly tick is idempotent and safe to re-run: claimDigestRun() is a
 * fenced compare-and-swap on the DigestRun row for that Pacific date, and the
 * Resend call itself carries a deterministic idempotency key
 * (gtr-digest-<digestDate>) so even an ambiguous send (response lost, retried)
 * can't double-deliver.
 */
import crypto from "node:crypto";
import { prisma } from "./prisma";
import type { QBTokens } from "./quickbooks";
import { getQBPurchasesCreatedBetween } from "./quickbooks";
import { getFreshQBTokens } from "./quickbooks-payments";
import { sendNotification } from "./email";
import { formatCurrency } from "./utils";

const PACIFIC_TZ = "America/Los_Angeles";
/** First hourly tick at or after this Pacific hour attempts the send. */
const SEND_WINDOW_START_HOUR = 6;
/** After this many attempts a FAILED digestDate stays FAILED and stops retrying. */
export const MAX_DIGEST_ATTEMPTS = 5;
/** PROCESSING claims older than this are stale and stealable by the next tick. */
const LEASE_MS = 5 * 60 * 1000;

// ── Pacific date/window math (pure — unit-tested directly, including DST) ──

export function getPacificDateAndHour(now: Date): { pacificDate: string; pacificHour: number } {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: PACIFIC_TZ,
        hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const part of dtf.formatToParts(now)) {
        if (part.type !== "literal") parts[part.type] = part.value;
    }
    // Midnight formats as hour "24" under hourCycle h23 in some ICU builds —
    // normalize to 0 so isWithinSendWindow's >= comparison stays correct.
    const hour = Number(parts.hour) % 24;
    return { pacificDate: `${parts.year}-${parts.month}-${parts.day}`, pacificHour: hour };
}

export function previousCalendarDate(dateStr: string): string {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
}

export function nextCalendarDate(dateStr: string): string {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
}

/** How far `timeZone`'s local wall clock reads from real UTC at `utcDate`
 * (e.g. roughly -7h or -8h for America/Los_Angeles). */
function timeZoneOffsetMs(utcDate: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const part of dtf.formatToParts(utcDate)) {
        if (part.type !== "literal") parts[part.type] = part.value;
    }
    const wallAsUtcMs = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    return wallAsUtcMs - utcDate.getTime();
}

/** UTC instant for local 00:00:00.000 of `dateStr` (YYYY-MM-DD) in `timeZone`.
 * DST-safe: two passes converge even on a transition date because a
 * real-world zone's offset only ever takes one of two values around it. */
function zonedMidnightUtc(dateStr: string, timeZone: string): Date {
    const [y, m, d] = dateStr.split("-").map(Number);
    const naiveGuessMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    let guessMs = naiveGuessMs;
    for (let i = 0; i < 2; i++) {
        const offset = timeZoneOffsetMs(new Date(guessMs), timeZone);
        guessMs = naiveGuessMs - offset;
    }
    return new Date(guessMs);
}

/** [startUtc, endUtc] spanning one full Pacific calendar day
 * (00:00:00.000–23:59:59.999 local), converted to UTC for querying. */
export function pacificDayWindowUtc(pacificDate: string): { startUtc: Date; endUtc: Date } {
    const startUtc = zonedMidnightUtc(pacificDate, PACIFIC_TZ);
    const nextMidnightUtc = zonedMidnightUtc(nextCalendarDate(pacificDate), PACIFIC_TZ);
    return { startUtc, endUtc: new Date(nextMidnightUtc.getTime() - 1) };
}

/** True once the first hourly tick at/after 06:00 Pacific has arrived for `now`. */
export function isWithinSendWindow(now: Date): boolean {
    return getPacificDateAndHour(now).pacificHour >= SEND_WINDOW_START_HOUR;
}

// ── DigestRun claim (fenced compare-and-swap) ───────────────────────────────

export interface DigestRunRow {
    digestDate: string;
    status: string; // "PROCESSING" | "SENT" | "FAILED"
    attempts: number;
    claimToken: string;
    leaseExpiresAt: Date;
}

/** Minimal shape of the Prisma DigestRun delegate this module needs — lets
 * tests inject an in-memory fake instead of a live database. */
export interface DigestRunClient {
    findUnique(args: { where: { digestDate: string } }): Promise<DigestRunRow | null>;
    create(args: { data: { digestDate: string; status: string; attempts: number; claimToken: string; leaseExpiresAt: Date } }): Promise<DigestRunRow>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export type DigestClaimResult =
    | { claimed: true; claimToken: string; attempts: number }
    | { claimed: false; reason: "already-sent" | "in-flight" | "terminal-failed" | "race" };

function isUniqueConstraintError(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

/**
 * Fenced claim for one Pacific digestDate. On success, the caller MUST
 * present the returned claimToken back to finalizeDigestRun to write
 * SENT/FAILED — a claim whose lease expired and got stolen by a later tick
 * can never overwrite the new claim's result (the fenced update matches 0
 * rows and is silently dropped).
 */
export async function claimDigestRun(
    client: DigestRunClient,
    digestDate: string,
    now: Date,
): Promise<DigestClaimResult> {
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const claimToken = crypto.randomUUID();

    let row = await client.findUnique({ where: { digestDate } });
    if (!row) {
        try {
            await client.create({
                data: { digestDate, status: "PROCESSING", attempts: 1, claimToken, leaseExpiresAt },
            });
            return { claimed: true, claimToken, attempts: 1 };
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            // Concurrent first-claim race — re-fetch and fall through to the
            // existing-row logic below instead of assuming we lost outright.
            row = await client.findUnique({ where: { digestDate } });
        }
    }
    if (!row) return { claimed: false, reason: "race" };

    if (row.status === "SENT") return { claimed: false, reason: "already-sent" };
    if (row.status === "PROCESSING" && row.leaseExpiresAt.getTime() > now.getTime()) {
        return { claimed: false, reason: "in-flight" };
    }
    if (row.status === "FAILED" && row.attempts >= MAX_DIGEST_ATTEMPTS) {
        return { claimed: false, reason: "terminal-failed" };
    }

    // Stale PROCESSING lease or a retryable FAILED — steal the claim via CAS,
    // fenced on the row's CURRENT status + claimToken so two workers racing
    // this same steal can't both succeed.
    const nextAttempts = row.attempts + 1;
    const stolen = await client.updateMany({
        where: { digestDate, status: row.status, claimToken: row.claimToken },
        data: { status: "PROCESSING", claimToken, leaseExpiresAt, attempts: nextAttempts },
    });
    if (stolen.count !== 1) return { claimed: false, reason: "race" };
    return { claimed: true, claimToken, attempts: nextAttempts };
}

/** Fenced write of the terminal outcome. Returns false (no-op) when this
 * worker's claimToken no longer matches — its lease was taken over and it
 * must not stomp on the new worker's result. */
export async function finalizeDigestRun(
    client: DigestRunClient,
    digestDate: string,
    claimToken: string,
    status: "SENT" | "FAILED",
): Promise<boolean> {
    const result = await client.updateMany({
        where: { digestDate, status: "PROCESSING", claimToken },
        data: { status },
    });
    return result.count === 1;
}

// ── QBO purchases → digest rows ─────────────────────────────────────────────

export interface DigestPurchaseRow {
    qbPurchaseId: string;
    /** 21-char Drive fileId prefix (= the automation's docNumber correlation key). */
    docNumber: string;
    date: string | null; // TxnDate, YYYY-MM-DD
    vendor: string | null;
    amountCents: number;
    projectName: string | null;
    driveUrl: string | null;
}

/**
 * Filter raw QBO Purchase rows to automation-created ones (the [gtr-file:...]
 * marker in PrivateNote) and de-duplicate by Purchase Id. Project name comes
 * straight from the QBO row's CustomerRef — createQBReceiptPurchase always
 * resolves that to an EXACT project-name match at booking time
 * (src/lib/qbo-receipt-push.ts), so it's already the source-of-truth value,
 * not something that needs local enrichment.
 */
export function buildDigestRows(rawPurchases: unknown[]): DigestPurchaseRow[] {
    const byId = new Map<string, DigestPurchaseRow>();
    for (const raw of rawPurchases) {
        if (!raw || typeof raw !== "object") continue;
        const p = raw as {
            Id?: unknown; PrivateNote?: unknown; TxnDate?: unknown; TotalAmt?: unknown;
            EntityRef?: { name?: unknown }; CustomerRef?: { name?: unknown };
        };
        const qbPurchaseId = p.Id != null ? String(p.Id) : null;
        if (!qbPurchaseId) continue;
        const privateNote = typeof p.PrivateNote === "string" ? p.PrivateNote : "";
        const markerMatch = privateNote.match(/\[gtr-file:([^\]]+)\]/);
        if (!markerMatch) continue; // not booked via the automation API path

        const fileId = markerMatch[1];
        const total = Number(p.TotalAmt);
        byId.set(qbPurchaseId, {
            qbPurchaseId,
            docNumber: fileId.slice(0, 21),
            date: typeof p.TxnDate === "string" ? p.TxnDate : null,
            vendor: typeof p.EntityRef?.name === "string" ? p.EntityRef.name : null,
            amountCents: Number.isFinite(total) ? Math.round(total * 100) : 0,
            projectName: typeof p.CustomerRef?.name === "string" ? p.CustomerRef.name : null,
            driveUrl: null,
        });
    }
    return [...byId.values()].sort((a, b) => {
        const byDate = (a.date ?? "").localeCompare(b.date ?? "");
        if (byDate !== 0) return byDate;
        return (a.vendor ?? "").localeCompare(b.vendor ?? "");
    });
}

/** Best-effort Drive link per docNumber, sourced from receipt-stage/receipt-push
 * automation_events (detail.fileId) — enrichment only, never the primary list. */
export async function findDriveLinksByDocNumbers(docNumbers: string[]): Promise<Map<string, string>> {
    if (docNumbers.length === 0) return new Map();
    const events = await prisma.automationEvent.findMany({
        where: {
            kind: { in: ["receipt-stage", "receipt-push"] },
            docNumber: { in: docNumbers },
            detail: { contains: "fileId" },
        },
        select: { docNumber: true, detail: true },
        take: 2000,
    });
    const links = new Map<string, string>();
    for (const event of events) {
        if (!event.docNumber || links.has(event.docNumber)) continue;
        try {
            const parsed = JSON.parse(event.detail ?? "{}") as { fileId?: unknown };
            if (typeof parsed.fileId === "string" && parsed.fileId) {
                links.set(event.docNumber, `https://drive.google.com/file/d/${parsed.fileId}/view`);
            }
        } catch {
            // malformed detail JSON — no link, not fatal
        }
    }
    return links;
}

// ── Render ───────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function digestRowHtml(row: DigestPurchaseRow): string {
    const qboUrl = `https://qbo.intuit.com/app/expense?txnId=${encodeURIComponent(row.qbPurchaseId)}`;
    const driveCell = row.driveUrl
        ? `<a href="${escapeHtml(row.driveUrl)}">Receipt</a>`
        : `<span style="color:#94a3b8;">not captured</span>`;
    return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(row.date ?? "—")}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(row.vendor ?? "—")}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(formatCurrency(row.amountCents / 100))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(row.projectName ?? "—")}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;"><a href="${qboUrl}">QuickBooks</a></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;">${driveCell}</td>
    </tr>`;
}

export function renderDigestEmailHtml(digestDate: string, rows: DigestPurchaseRow[]): string {
    if (rows.length === 0) {
        return `<p>Nothing posted yesterday (${escapeHtml(digestDate)}).</p>`;
    }
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
        <p>${rows.length} receipt${rows.length === 1 ? "" : "s"} posted to QuickBooks on ${escapeHtml(digestDate)}:</p>
        <table style="border-collapse:collapse;width:100%;font-size:13px;">
            <thead>
                <tr style="text-align:left;">
                    <th style="padding:6px 10px;border-bottom:2px solid #cbd5e1;">Date</th>
                    <th style="padding:6px 10px;border-bottom:2px solid #cbd5e1;">Vendor</th>
                    <th style="padding:6px 10px;border-bottom:2px solid #cbd5e1;">Amount</th>
                    <th style="padding:6px 10px;border-bottom:2px solid #cbd5e1;">Project</th>
                    <th style="padding:6px 10px;border-bottom:2px solid #cbd5e1;">QuickBooks</th>
                    <th style="padding:6px 10px;border-bottom:2px solid #cbd5e1;">Receipt</th>
                </tr>
            </thead>
            <tbody>${rows.map(digestRowHtml).join("\n")}</tbody>
        </table>
    </div>`;
}

function terminalFailureHtml(digestDate: string, attempts: number, lastError: string): string {
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
        <p><strong>The Vanessa expense digest for ${escapeHtml(digestDate)} has failed ${attempts} times and will not retry automatically.</strong></p>
        <p>Last error: ${escapeHtml(lastError)}</p>
        <p>Check QuickBooks and the /automation register directly for that date, then have someone fix the underlying issue before the next Pacific day's digest runs.</p>
    </div>`;
}

// ── Orchestration ────────────────────────────────────────────────────────

export interface AutomationDigestDeps {
    now(): Date;
    digestRunClient: DigestRunClient;
    getTokens(): Promise<QBTokens>;
    queryPurchasesCreatedBetween(tokens: QBTokens, startUtc: Date, endUtc: Date): Promise<unknown[]>;
    findDriveLinks(docNumbers: string[]): Promise<Map<string, string>>;
    sendDigest(input: { to: string; cc: string; html: string; digestDate: string }): Promise<{ success: boolean }>;
    sendTerminalAlert(input: { cc: string; digestDate: string; attempts: number; lastError: string }): Promise<{ success: boolean }>;
}

export type DigestTickResult =
    | { ok: true; skipped: "before-send-window" | "already-sent" | "in-flight" | "terminal-failed" }
    | { ok: true; sent: true; digestDate: string; rowCount: number }
    | { ok: false; digestDate: string; attempts: number; error: string };

/** One hourly cron tick. Computes yesterday's Pacific date, claims it, and —
 * if claimed — queries QBO, renders, and sends. Never throws: every failure
 * path is caught, recorded as FAILED (fenced), and returned as ok:false so
 * the route can log it without crashing the cron. */
export async function runDigestTick(
    deps: AutomationDigestDeps,
    recipients: { vanessaEmail: string; digestCcEmail: string },
): Promise<DigestTickResult> {
    const now = deps.now();
    if (!isWithinSendWindow(now)) return { ok: true, skipped: "before-send-window" };

    const { pacificDate } = getPacificDateAndHour(now);
    const digestDate = previousCalendarDate(pacificDate);

    const claim = await claimDigestRun(deps.digestRunClient, digestDate, now);
    if (!claim.claimed) {
        return { ok: true, skipped: claim.reason === "race" ? "in-flight" : claim.reason };
    }

    try {
        const tokens = await deps.getTokens();
        const { startUtc, endUtc } = pacificDayWindowUtc(digestDate);
        const rawPurchases = await deps.queryPurchasesCreatedBetween(tokens, startUtc, endUtc);
        const rows = buildDigestRows(rawPurchases);
        const driveLinks = await deps.findDriveLinks(rows.map((r) => r.docNumber));
        const withLinks = rows.map((r) => ({ ...r, driveUrl: driveLinks.get(r.docNumber) ?? null }));
        const html = renderDigestEmailHtml(digestDate, withLinks);

        const sendResult = await deps.sendDigest({
            to: recipients.vanessaEmail,
            cc: recipients.digestCcEmail,
            html,
            digestDate,
        });
        if (!sendResult.success) {
            throw new Error("Resend reported failure sending the digest");
        }

        const finalized = await finalizeDigestRun(deps.digestRunClient, digestDate, claim.claimToken, "SENT");
        if (!finalized) {
            // Sent successfully, but our lease was stolen before we could record
            // it — the stealing worker will find "SENT" is impossible to reach
            // from its own stale view and its Resend call is deduped by the
            // shared idempotency key, so no double-send; just log the race.
            console.warn(`[automation-digest] ${digestDate} sent but lease was stolen before finalize`);
        }
        return { ok: true, sent: true, digestDate, rowCount: withLinks.length };
    } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        await finalizeDigestRun(deps.digestRunClient, digestDate, claim.claimToken, "FAILED");
        if (claim.attempts >= MAX_DIGEST_ATTEMPTS) {
            await deps.sendTerminalAlert({
                cc: recipients.digestCcEmail,
                digestDate,
                attempts: claim.attempts,
                lastError: message,
            });
        }
        return { ok: false, digestDate, attempts: claim.attempts, error: message };
    }
}

export function createDefaultDigestDeps(): AutomationDigestDeps {
    return {
        now: () => new Date(),
        digestRunClient: prisma.digestRun,
        getTokens: getFreshQBTokens,
        queryPurchasesCreatedBetween: getQBPurchasesCreatedBetween,
        findDriveLinks: findDriveLinksByDocNumbers,
        sendDigest: ({ to, cc, html, digestDate }) =>
            sendNotification(to, `GTR expense digest — ${digestDate}`, html, undefined, {
                cc: [cc],
                idempotencyKey: `gtr-digest-${digestDate}`,
            }),
        sendTerminalAlert: ({ cc, digestDate, attempts, lastError }) =>
            sendNotification(
                cc,
                `GTR expense digest FAILED ${attempts}x — ${digestDate}`,
                terminalFailureHtml(digestDate, attempts, lastError),
                undefined,
                { idempotencyKey: `gtr-digest-alert-${digestDate}` },
            ),
    };
}
