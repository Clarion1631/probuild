/**
 * The v1 -> v2 cutover boundary.
 *
 * The problem this exists to solve: at cutover, the shadow-week backlog cannot
 * all be treated the same way. Rows received while the Apps Script was still
 * BOOKING were booked by v1, so v2 must never book them again — v2's QuickBooks
 * identity for an email/chat/mobile/web row is the intake UUID, which v1 never
 * saw, so DocNumber idempotency cannot recognise the Purchase v1 already made.
 * But rows received AFTER v1 stopped booking were never booked by anyone, and
 * retiring those would silently drop real expenses on the floor.
 *
 * One timestamp separates the two: the instant the Apps Script was flipped to
 * forwarder mode and stopped writing to QuickBooks. It is recorded when that
 * flip happens, NOT derived — nothing in the database can infer it, and a guess
 * here either double-books or loses receipts.
 *
 * With no boundary recorded the worker refuses to retire anything at all. That
 * is the only safe default: retiring on a guess destroys evidence, and the
 * failure mode of refusing is a visible, logged no-op.
 */
import { prisma } from "@/lib/prisma";

export const CUTOVER_SETTING_KEY = "cutoverV1StoppedAt";

/**
 * When v1 stopped booking. Read from the AutomationSetting row first (that is
 * what an operator writes at the flip), falling back to the env var so a
 * deployment can carry it too. Returns null when unset OR unparseable — a
 * malformed value must not be silently treated as "epoch", which would retire
 * the entire backlog.
 */
export async function resolveCutoverBoundary(): Promise<Date | null> {
    let raw: string | null | undefined;
    try {
        raw = (await prisma.automationSetting.findUnique({ where: { key: CUTOVER_SETTING_KEY } }))?.value;
    } catch (error) {
        // A settings read failure is NOT "no boundary" — that would let a DB
        // blip authorise a retire. Surface it as unset, which refuses.
        console.error("[cutover] settings read failed", error instanceof Error ? error.name : "UnknownError");
        return null;
    }
    return parseCutoverBoundary(raw ?? process.env.CUTOVER_V1_STOPPED_AT);
}

/** Pure, so the parsing rules are testable without a database. */
export function parseCutoverBoundary(value: string | null | undefined): Date | null {
    if (!value || !value.trim()) return null;
    const at = new Date(value.trim());
    if (!Number.isFinite(at.getTime())) return null;
    return at;
}
