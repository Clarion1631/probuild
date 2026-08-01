import { NextResponse } from "next/server";
import { logAutomationEvent } from "@/lib/automation-events";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Stage beacons from the receipt bot (Apps Script). The interesting failures
 * — unreadable receipts, duplicates, parked files — die INSIDE the bot and
 * never reach the push endpoint, so without these beacons the Command
 * Center's per-receipt journey view would only ever show the happy path.
 *
 * Best-effort by contract on BOTH sides: the bot fires and forgets (never
 * blocks receipt processing on this call), and this route never returns an
 * error for malformed items — it logs what it can and reports counts. Auth
 * is the same ingest key as the push endpoint; observability data still
 * must not be writable by the open internet.
 */

interface BeaconItem {
    fileId?: unknown;
    stage?: unknown;
    status?: unknown;
    reason?: unknown;
    fileName?: unknown;
    vendor?: unknown;
    projectName?: unknown;
    amountCents?: unknown;
    taxCents?: unknown;
}

const ALLOWED_STAGES = new Set(["intake", "read", "dedupe", "email-book"]);
const MAX_ITEMS = 20;

function str(v: unknown): string | undefined {
    return typeof v === "string" && v.trim() ? v : undefined;
}
function cents(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
}

export async function POST(request: Request) {
    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || request.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    // Always-200 after auth, whatever the body: JSON null, {"events":null},
    // [null] items — the beacon contract is best-effort, and an authenticated
    // 500 here would look like a transient error worth retrying to the bot.
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ ok: true, logged: 0, dropped: 0 });
    }
    const rawEvents =
        typeof body === "object" && body !== null && Array.isArray((body as { events?: unknown }).events)
            ? ((body as { events: unknown[] }).events)
            : [];
    const items = rawEvents.slice(0, MAX_ITEMS);
    // Over-cap items were sent but not logged — report them as dropped
    // rather than silently pretending they never arrived.
    let dropped = rawEvents.length - items.length;

    let logged = 0;
    for (const raw of items) {
        if (typeof raw !== "object" || raw === null) {
            dropped += 1;
            continue;
        }
        const item = raw as BeaconItem;
        const fileId = str(item.fileId);
        const stage = str(item.stage);
        const status = str(item.status);
        if (!fileId || !stage || !status || !ALLOWED_STAGES.has(stage)) {
            dropped += 1;
            continue;
        }
        await logAutomationEvent({
            kind: "receipt-stage",
            stage,
            status,
            reason: str(item.reason),
            source: "apps-script",
            vendor: str(item.vendor),
            projectName: str(item.projectName),
            docNumber: fileId.slice(0, 21),
            fileName: str(item.fileName),
            amountCents: cents(item.amountCents),
            taxCents: cents(item.taxCents),
        });
        logged += 1;
    }
    return NextResponse.json({ ok: true, logged, dropped });
}
