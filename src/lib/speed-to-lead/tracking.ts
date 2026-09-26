import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CLOSED_LEAD_STAGES } from "@/lib/gpt-estimate";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { dayKeyInTimeZone } from "@/lib/tz-date";
import { logLeadEvent } from "./audit";
import { sendPlainNtfy } from "./alerts";
import { speedToLeadMode, DIGEST_HOUR_LOCAL, DIGEST_LOOKBACK_MS, DIGEST_CLAIM_STALE_MS } from "./constants";
import { safeErrorCategory } from "./error-category";

/**
 * Booked/Called (the funnel's tracking half) and the 09:00 digest — v1a has
 * no dispatch to cancel, so these move here from v1's `followups.ts`
 * unchanged in spirit but with the cancellation step dropped entirely.
 */

/** Written to the per-day claim key BEFORE any push is attempted — see maybeSend0900Digest's own doc comment for why establishing this durably up front (rather than only after a successful push) is what actually closes the duplicate-send gap. */
const CLAIM_VALUE_SENDING = "sending";
/** Written AFTER a push has been confirmed delivered, if (and only if) the primary `sentKey` write below it failed. Purely diagnostic for a human inspecting the row — correctness never depends on this write succeeding, since CLAIM_VALUE_SENDING is already non-reclaimable on its own by the time the push even starts. */
const CLAIM_VALUE_SENT_PENDING = "sent-pending";

/** A Speed-to-Lead-owned lead — one that actually went through this feature's own intake (via its LeadIntakeEvent relation), so a pre-existing CRM lead never appears in the digest. */
const OWNED_LEAD_WHERE = {
    bookedAt: null,
    calledAt: null,
    isArchived: false,
    stage: { notIn: CLOSED_LEAD_STAGES },
    leadIntakeEvents: { some: {} },
} as const;

/** Any signed-in active staff may press these — see speed-to-lead-actions.ts. The timestamp is set exactly once; a second press is a no-op and logs nothing new. */
export async function markLeadBooked(leadId: string, actor: string, db: PrismaClient = prisma): Promise<void> {
    const { count } = await db.lead.updateMany({ where: { id: leadId, bookedAt: null }, data: { bookedAt: new Date() } });
    if (count > 0) await logLeadEvent(db, { leadId, kind: "lead-booked", actor });
}

export async function markLeadCalled(leadId: string, actor: string, db: PrismaClient = prisma): Promise<void> {
    const { count } = await db.lead.updateMany({ where: { id: leadId, calledAt: null }, data: { calledAt: new Date() } });
    if (count > 0) await logLeadEvent(db, { leadId, kind: "lead-called", actor });
}

/** The hour-of-day (0-23) `date` falls on in `timeZone` — Intl can render midnight as "24", so it is normalized back to 0. */
function hourInTimeZone(date: Date, timeZone: string): number {
    const hourPart = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).formatToParts(date).find(p => p.type === "hour")?.value ?? "0";
    return Number(hourPart) % 24;
}

/**
 * Goal: unanswered/unbooked leads plus DEAD alerts and poll health, once a
 * day at the business's own local morning (never 09:00 UTC — Golden Touch
 * Remodeling is in Vancouver, WA / America/Los_Angeles).
 *
 * Returns whether the digest is fully handled: true when there was nothing
 * to send, or the push actually succeeded; false when there WAS content but
 * the push failed. `sendPlainNtfy` never throws on a failed push (it
 * resolves `false`), so the caller cannot tell success from failure via
 * try/catch alone — it must check this return value.
 */
export async function send0900Digest(db: PrismaClient = prisma, now: Date = new Date()): Promise<boolean> {
    const since = new Date(now.getTime() - DIGEST_LOOKBACK_MS);
    const leads = await db.lead.findMany({
        where: { ...OWNED_LEAD_WHERE, createdAt: { gte: since } },
        select: { id: true, name: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 50,
    });
    const deadAlerts = await db.leadAlert.count({ where: { status: "DEAD", createdAt: { gte: since } } });
    const settings = await db.companySettings.findUnique({ where: { id: "singleton" }, select: { leadInboxLastPollOk: true, leadInboxFailureCount: true } });
    const pollHealthLine = settings?.leadInboxLastPollOk === false
        ? `Inbox poll unhealthy (${settings.leadInboxFailureCount} consecutive failure(s)).`
        : "Inbox poll healthy.";

    if (leads.length === 0 && deadAlerts === 0) return true;

    const lines = [
        pollHealthLine,
        deadAlerts > 0 ? `${deadAlerts} alert(s) failed delivery (DEAD) in the last 14 days — see Settings > Speed-to-Lead.` : null,
        "",
        ...leads.map(l => `- ${l.name} (received ${l.createdAt.toISOString().slice(0, 10)})`),
    ].filter((l): l is string => l !== null);

    return sendPlainNtfy(`Speed-to-Lead: ${leads.length} unanswered/unbooked lead(s)`, lines.join("\n"));
}

/**
 * Sent once at the business's local morning, even with two concurrent cron
 * runs. Claims a per-day marker BEFORE sending and only writes the "sent"
 * marker AFTER the push succeeds; a failed push releases the claim so the
 * next minute within the same local hour retries (v1a fix for #557's
 * write-before-send bug, which lost the whole day on one failed push).
 *
 * Failure modes beyond a simple claim/release, v1a round-3 through round-5
 * findings:
 *  - A crash (or the claim-row delete above itself failing) BEFORE the push
 *    is even attempted would otherwise strand the claim for the rest of the
 *    local day with the digest never actually sent — a stale claim in that
 *    state is reclaimed below rather than left to block every later tick.
 *  - Once the push has actually STARTED, this function must never release
 *    the claim again for any reason — a crash mid-push, or a failure
 *    writing the "sent" marker afterward, must never look indistinguishable
 *    from "never attempted", or a later retry could re-send a push that
 *    already went out. Round-5 fix: the claim is written as
 *    CLAIM_VALUE_SENDING BEFORE `send0900Digest` is even called (not only
 *    AFTER a successful push, as the round-4 design had it) — the OLD
 *    design's entire protection depended on the after-push
 *    CLAIM_VALUE_SENT_PENDING write succeeding, and that write's own
 *    failure was silently swallowed (`.catch(() => undefined)`), which left
 *    the exact same ambiguity a bare crash mid-push already had: a claim
 *    that looked exactly like "never attempted" and so was reclaimed and
 *    re-sent.
 *  - The staleness check below never reclaims CLAIM_VALUE_SENDING or
 *    CLAIM_VALUE_SENT_PENDING, no matter their age — re-pushing risks a
 *    real duplicate send, which is worse than a missed digest a human can
 *    force by clearing the row. Once such a claim is old enough that no
 *    real invocation could still be running, this only logs it for manual
 *    follow-up rather than silently doing nothing forever.
 */
export async function maybeSend0900Digest(now: Date = new Date(), db: PrismaClient = prisma): Promise<boolean> {
    if (speedToLeadMode() === "OFF") return false;
    const timeZone = await resolveCompanyTimeZone(db);
    if (hourInTimeZone(now, timeZone) !== DIGEST_HOUR_LOCAL) return false;

    const today = dayKeyInTimeZone(now, timeZone);
    const sentKey = "speedToLeadDigestLastSentDate";
    const claimKey = `speedToLeadDigestClaim:${today}`;

    const alreadySent = await db.automationSetting.findUnique({ where: { key: sentKey } });
    if (alreadySent?.value === today) return false;

    const existingClaim = await db.automationSetting.findUnique({ where: { key: claimKey } });
    if (existingClaim) {
        const ageMs = now.getTime() - existingClaim.updatedAt.getTime();
        if (existingClaim.value === CLAIM_VALUE_SENDING || existingClaim.value === CLAIM_VALUE_SENT_PENDING) {
            // A push was at least ATTEMPTED under this claim — its outcome
            // (still running, crashed mid-push, or succeeded but the "sent"
            // marker write failed) is indistinguishable from here, and every
            // one of those is safer to treat as "possibly already sent"
            // than to risk a real duplicate. Never reclaimed, no matter how
            // old; once old enough that no real invocation could still be
            // in flight, log it so a human can check and clear it manually.
            if (ageMs > DIGEST_CLAIM_STALE_MS) {
                console.error(`[speed-to-lead] 09:00 digest claim ${claimKey} has been "${existingClaim.value}" for ${Math.round(ageMs / 1000)}s — treating as possibly already sent and NOT re-pushing. If it was not actually sent, clear this AutomationSetting row to allow a retry.`);
            }
            return false;
        }
        // Any other stale value (defensive only — this function itself
        // never writes anything but CLAIM_VALUE_SENDING going forward) is
        // safe to reclaim once old enough: nothing was ever attempted under
        // it. Guarded by updatedAt so a claim refreshed by another run
        // between the read and this delete is left alone.
        if (ageMs > DIGEST_CLAIM_STALE_MS) {
            await db.automationSetting.deleteMany({ where: { key: claimKey, updatedAt: existingClaim.updatedAt } }).catch(() => undefined);
        }
    }

    try {
        // The unique constraint on AutomationSetting.key is the claim — a
        // second concurrent invocation's create() throws and it walks away.
        // Marked CLAIM_VALUE_SENDING from this single write on, BEFORE the
        // push is ever attempted (see doc comment above).
        await db.automationSetting.create({ data: { key: claimKey, value: CLAIM_VALUE_SENDING } });
    } catch {
        return false;
    }

    let delivered: boolean;
    try {
        delivered = await send0900Digest(db, now);
    } catch (error) {
        console.error("[speed-to-lead] 09:00 digest failed; releasing claim for retry", safeErrorCategory(error));
        await db.automationSetting.delete({ where: { key: claimKey } }).catch(() => undefined);
        return false;
    }

    if (!delivered) {
        // sendPlainNtfy resolved false (a real push failure) rather than
        // throwing — this branch is what actually catches that; the catch
        // block above alone never would (v1a's #557 write-before-send bug,
        // reproduced: the "sent" marker must not be written on a failed
        // push). Nothing went out, so releasing the claim for a same-hour
        // retry is safe.
        console.error("[speed-to-lead] 09:00 digest push failed; releasing claim for retry");
        await db.automationSetting.delete({ where: { key: claimKey } }).catch(() => undefined);
        return false;
    }

    // The push already went out — the claim has been CLAIM_VALUE_SENDING
    // (already non-reclaimable) since before the push started, so it is
    // NEVER released again from here, no matter what happens next.
    try {
        await db.automationSetting.upsert({ where: { key: sentKey }, create: { key: sentKey, value: today }, update: { value: today } });
    } catch (error) {
        console.error("[speed-to-lead] 09:00 digest sent but marking it as sent failed", safeErrorCategory(error));
        // Purely diagnostic — correctness does not depend on this write
        // succeeding. If it ALSO fails, the claim simply stays
        // CLAIM_VALUE_SENDING, which the staleness check above treats
        // identically to CLAIM_VALUE_SENT_PENDING: never reclaimed.
        await db.automationSetting.update({ where: { key: claimKey }, data: { value: CLAIM_VALUE_SENT_PENDING } })
            .catch(err => console.error("[speed-to-lead] also failed marking the claim sent-pending (non-fatal — it stays 'sending', still never reclaimed)", safeErrorCategory(err)));
        return false;
    }
    return true;
}
