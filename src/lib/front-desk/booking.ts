/**
 * Front Desk v1 §2.1 (availability), §2.2 (book) and §2.3 (reconciler).
 */
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeCallerPhoneE164 } from "@/lib/speed-to-lead/intake";
import { sendPlainNtfy } from "@/lib/speed-to-lead/alerts";
import {
    FRONT_DESK_DAILY_BOOKING_CAP, FRONT_DESK_MAX_BOOK_ATTEMPTS, FRONT_DESK_MAX_OFFERS_PER_CALL,
    FRONT_DESK_MAX_SLOTS_PER_OFFER, FRONT_DESK_SLOT_TTL_MS, FRONT_DESK_BOOK_REPLAY_POLL_MS,
    FRONT_DESK_BOOK_REPLAY_WAIT_MS, FRONT_DESK_RECONCILE_SUBMITTING_MIN_AGE_MS, FRONT_DESK_RECONCILE_MAX_AGE_MS,
    FRONT_DESK_RECONCILE_RETRY_COOLDOWN_MS, FRONT_DESK_RECONCILE_ABSENT_GRACE_MS,
    frontDeskBookingEnabled, frontDeskTestInviteeDomains, pacificDateString, pacificTimeString, pacificSpoken, pacificParts,
} from "./constants";
import { loadFrontDeskCalendlyConfig, getAvailableTimes, createInvitee, listScheduledEvents, listScheduledEventInvitees, type CreateInviteeOutcome } from "./calendly";

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Slot ledger (shared shape written by availability, read by book) ───────

export interface OfferedSlot {
    id: string;
    startTime: string; // UTC ISO
    expiresAt: string; // UTC ISO
    offer: number; // 1-indexed offer-call number this slot came from
}

function parseOfferedSlots(value: unknown): OfferedSlot[] {
    if (!Array.isArray(value)) return [];
    return value.filter((s): s is OfferedSlot => !!s && typeof s === "object" && typeof (s as OfferedSlot).id === "string" && typeof (s as OfferedSlot).startTime === "string");
}

/** The UTC instant of Pacific local midnight for the calendar day `date` falls on — the daily cap's day boundary. Binary search rather than a fixed offset, so it is correct across the DST transition. */
export function pacificDayStartUtc(date: Date): Date {
    const dateStr = pacificDateString(date);
    let lo = new Date(`${dateStr}T00:00:00.000Z`).getTime(); // Pacific is always behind UTC, so this is <= the boundary
    let hi = lo + 24 * 60 * 60 * 1000; // 24h later is always >= the boundary
    while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (pacificDateString(new Date(mid)) === dateStr) hi = mid;
        else lo = mid;
    }
    return new Date(hi);
}

// ── §2.1 availability tool ──────────────────────────────────────────────────

export type AvailabilityReason = "booking_off" | "not_configured" | "offer_limit" | "calendly_unavailable";

export type AvailabilityResult =
    | { status: "take_preferred_times"; reason: AvailabilityReason }
    | { status: "no_times" }
    | { status: "ok"; timezone: string; slots: { slot_id: string; spoken: string; date: string; time: string }[] };

export interface AvailabilityToolInput {
    conversationId: string;
    agentId: string | null;
    isTest: boolean;
    preferredDate: string | null;
    partOfDay: "morning" | "afternoon" | "any" | null;
}

export async function handleAvailabilityTool(db: PrismaClient, input: AvailabilityToolInput, now: Date = new Date()): Promise<AvailabilityResult> {
    if (!frontDeskBookingEnabled()) return { status: "take_preferred_times", reason: "booking_off" };
    const config = await loadFrontDeskCalendlyConfig(db, { isTest: input.isTest });
    if (!config) return { status: "take_preferred_times", reason: "not_configured" };

    await db.$executeRaw`
        INSERT INTO "FrontDeskCall" (id, "conversationId", "agentId", "isTest", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${input.conversationId}, ${input.agentId}, ${input.isTest}, now(), now())
        ON CONFLICT ("conversationId") DO NOTHING`;

    const call = await db.frontDeskCall.findUniqueOrThrow({ where: { conversationId: input.conversationId } });
    const offeredSlots = parseOfferedSlots(call.offeredSlots);
    const offerNumbers = new Set(offeredSlots.map(s => s.offer));
    if (offerNumbers.size >= FRONT_DESK_MAX_OFFERS_PER_CALL) {
        return { status: "take_preferred_times", reason: "offer_limit" };
    }

    const startWindow = new Date(now.getTime() + 60_000);
    const endWindow = new Date(startWindow.getTime() + 7 * 24 * 60 * 60 * 1000);
    const result = await getAvailableTimes(config.token, config.eventTypeUri, startWindow.toISOString(), endWindow.toISOString());
    if (result.kind !== "ok") return { status: "take_preferred_times", reason: "calendly_unavailable" };

    let candidates = result.data.collection
        .filter(t => t.status === "available")
        .map(t => new Date(t.start_time))
        .filter(d => !Number.isNaN(d.getTime()) && d.getTime() > now.getTime());

    if (input.partOfDay === "morning") candidates = candidates.filter(d => pacificParts(d).hour < 12);
    else if (input.partOfDay === "afternoon") candidates = candidates.filter(d => pacificParts(d).hour >= 12);

    candidates.sort((a, b) => a.getTime() - b.getTime());
    if (input.preferredDate) {
        const preferred = candidates.filter(d => pacificDateString(d) === input.preferredDate);
        const rest = candidates.filter(d => pacificDateString(d) !== input.preferredDate);
        candidates = [...preferred, ...rest];
    }

    const chosen = candidates.slice(0, FRONT_DESK_MAX_SLOTS_PER_OFFER);
    if (chosen.length === 0) return { status: "no_times" };

    const nextOffer = offerNumbers.size + 1;
    const baseSeq = call.slotSeq;
    const newSlots: OfferedSlot[] = chosen.map((d, i) => ({
        id: String(baseSeq + i + 1),
        startTime: d.toISOString(),
        expiresAt: new Date(now.getTime() + FRONT_DESK_SLOT_TTL_MS).toISOString(),
        offer: nextOffer,
    }));

    await db.$executeRaw`
        UPDATE "FrontDeskCall"
        SET "slotSeq" = "slotSeq" + ${newSlots.length}, "offeredSlots" = "offeredSlots" || ${JSON.stringify(newSlots)}::jsonb, "updatedAt" = now()
        WHERE "conversationId" = ${input.conversationId}`;

    return {
        status: "ok",
        timezone: "America/Los_Angeles",
        slots: newSlots.map(s => ({
            slot_id: s.id,
            spoken: pacificSpoken(new Date(s.startTime)),
            date: pacificDateString(new Date(s.startTime)),
            time: pacificTimeString(new Date(s.startTime)),
        })),
    };
}

// ── §2.2 book tool ───────────────────────────────────────────────────────

export type BookNotBookedReason =
    | "front_desk_off" | "booking_off" | "not_configured" | "test_invitee_not_allowed"
    | "readback_incomplete" | "readback_mismatch" | "invalid_email" | "invalid_phone"
    | "slot_unknown" | "slot_expired" | "slot_taken"
    | "already_booked" | "daily_cap" | "too_many_attempts"
    | "calendly_rejected" | "calendly_auth" | "calendly_plan" | "rate_limited";

export type BookOutcome =
    | { kind: "booked"; spoken: string }
    | { kind: "uncertain" }
    | { kind: "not_booked"; reason: BookNotBookedReason; mode?: "take_preferred_times"; spoken?: string };

export interface BookToolInput {
    conversationId: string;
    agentId: string | null;
    callerId: string | null;
    isTest: boolean;
    slotId: string;
    confirmedDate: string;
    confirmedTime: string;
    name: string;
    email: string;
    callbackPhone: string;
    readbackConfirmed: boolean;
}

const emailSchema = z.string().trim().email();

function requiredFieldsPresent(input: BookToolInput): boolean {
    return !!(input.slotId && input.confirmedDate && input.confirmedTime && input.name?.trim() && input.email?.trim() && input.callbackPhone?.trim());
}

export async function handleBookTool(db: PrismaClient, input: BookToolInput, now: Date = new Date()): Promise<BookOutcome> {
    if (!frontDeskBookingEnabled()) return { kind: "not_booked", reason: "booking_off", mode: "take_preferred_times" };
    if (!requiredFieldsPresent(input) || input.readbackConfirmed !== true) {
        return { kind: "not_booked", reason: "readback_incomplete" };
    }

    const config = await loadFrontDeskCalendlyConfig(db, { isTest: input.isTest });
    if (!config) return { kind: "not_booked", reason: "not_configured" };

    const emailParse = emailSchema.safeParse(input.email);
    if (!emailParse.success) return { kind: "not_booked", reason: "invalid_email" };
    const emailLower = emailParse.data.toLowerCase();
    const phoneE164 = normalizeCallerPhoneE164(input.callbackPhone);
    if (!phoneE164) return { kind: "not_booked", reason: "invalid_phone" };

    if (input.isTest) {
        const domain = emailLower.split("@")[1] ?? "";
        if (!frontDeskTestInviteeDomains().includes(domain)) return { kind: "not_booked", reason: "test_invitee_not_allowed" };
    }

    const call = await db.frontDeskCall.findUnique({ where: { conversationId: input.conversationId } });
    const slot = parseOfferedSlots(call?.offeredSlots).find(s => s.id === input.slotId);
    if (!slot) return { kind: "not_booked", reason: "slot_unknown" };
    if (new Date(slot.expiresAt).getTime() < now.getTime()) return { kind: "not_booked", reason: "slot_expired" };

    const slotDate = new Date(slot.startTime);
    if (pacificDateString(slotDate) !== input.confirmedDate || pacificTimeString(slotDate) !== input.confirmedTime) {
        return { kind: "not_booked", reason: "readback_mismatch" };
    }

    const requestHash = createHash("sha256")
        .update(JSON.stringify({ eventTypeUri: config.eventTypeUri, startTime: slot.startTime, name: input.name.trim(), emailLower, phoneE164 }))
        .digest("hex");

    type Reservation =
        | { kind: "replay"; rowId: string }
        | { kind: "already_booked"; spoken?: string }
        | { kind: "too_many_attempts" }
        | { kind: "daily_cap" }
        | { kind: "slot_taken" }
        | { kind: "reserved"; rowId: string };

    // §2.2 step 3: ONE short transaction under a global advisory lock. Volume
    // is tiny, so serializing every reservation removes the cap/phone/email
    // races outright rather than trying to express them as SQL predicates
    // under snapshot isolation.
    const reservation: Reservation = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('front-desk-booking'))`;

        const replay = await tx.frontDeskBooking.findUnique({ where: { conversationId_requestHash: { conversationId: input.conversationId, requestHash } } });
        if (replay) return { kind: "replay", rowId: replay.id };

        const attemptCount = await tx.frontDeskBooking.count({ where: { conversationId: input.conversationId } });
        if (attemptCount >= FRONT_DESK_MAX_BOOK_ATTEMPTS) return { kind: "too_many_attempts" };

        const activeForCall = await tx.frontDeskBooking.findFirst({ where: { conversationId: input.conversationId, status: { in: ["SUBMITTING", "BOOKED", "UNCERTAIN"] } } });
        if (activeForCall) return { kind: "already_booked", spoken: activeForCall.status === "BOOKED" ? pacificSpoken(activeForCall.startTime) : undefined };

        const dupe = await tx.frontDeskBooking.findFirst({
            where: { status: { in: ["SUBMITTING", "BOOKED", "UNCERTAIN"] }, startTime: { gt: now }, OR: [{ phoneE164 }, { emailLower }] },
            orderBy: { createdAt: "asc" },
        });
        if (dupe) return { kind: "already_booked", spoken: dupe.status === "BOOKED" ? pacificSpoken(dupe.startTime) : undefined };

        const dayStart = pacificDayStartUtc(now);
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const todayCount = await tx.frontDeskBooking.count({ where: { status: { in: ["SUBMITTING", "BOOKED", "UNCERTAIN"] }, createdAt: { gte: dayStart, lt: dayEnd } } });
        if (todayCount >= FRONT_DESK_DAILY_BOOKING_CAP) return { kind: "daily_cap" };

        const slotTaken = await tx.frontDeskBooking.findFirst({ where: { status: { in: ["SUBMITTING", "BOOKED", "UNCERTAIN"] }, eventTypeUri: config.eventTypeUri, startTime: slotDate } });
        if (slotTaken) return { kind: "slot_taken" };

        const row = await tx.frontDeskBooking.create({
            data: {
                conversationId: input.conversationId, requestHash, status: "SUBMITTING", isTest: input.isTest,
                eventTypeUri: config.eventTypeUri, startTime: slotDate, phoneE164, emailLower, submittedAt: now,
            },
        });
        return { kind: "reserved", rowId: row.id };
    });

    if (reservation.kind === "too_many_attempts") return { kind: "not_booked", reason: "too_many_attempts" };
    if (reservation.kind === "daily_cap") return { kind: "not_booked", reason: "daily_cap" };
    if (reservation.kind === "slot_taken") return { kind: "not_booked", reason: "slot_taken" };
    if (reservation.kind === "already_booked") return { kind: "not_booked", reason: "already_booked", spoken: reservation.spoken };
    if (reservation.kind === "replay") return waitForBookingRowOutcome(db, reservation.rowId);

    // reservation.kind === "reserved" — POST to Calendly OUTSIDE the transaction (§2.2 step 4).
    const createResult = await createInvitee(config.token, {
        eventTypeUri: config.eventTypeUri, startTimeIso: slot.startTime, name: input.name.trim(), email: input.email.trim(), phoneE164, trackingContent: reservation.rowId,
    });
    return applyBookingOutcome(db, reservation.rowId, createResult, now);
}

/** §2.2 step 6: the loser of a concurrent identical request polls the winner's row for up to 9s, then returns its stored result (or `uncertain`). */
async function waitForBookingRowOutcome(db: PrismaClient, rowId: string): Promise<BookOutcome> {
    const deadline = Date.now() + FRONT_DESK_BOOK_REPLAY_WAIT_MS;
    for (;;) {
        const row = await db.frontDeskBooking.findUnique({ where: { id: rowId } });
        if (!row) return { kind: "uncertain" };
        if (row.status === "BOOKED") return { kind: "booked", spoken: pacificSpoken(row.startTime) };
        if (row.status === "NOT_BOOKED") return { kind: "not_booked", reason: (row.reason as BookNotBookedReason) ?? "calendly_rejected" };
        if (Date.now() >= deadline) return { kind: "uncertain" };
        await sleep(FRONT_DESK_BOOK_REPLAY_POLL_MS);
    }
}

async function applyBookingOutcome(db: PrismaClient, rowId: string, result: CreateInviteeOutcome, now: Date): Promise<BookOutcome> {
    if (result.kind === "created") {
        await db.frontDeskBooking.updateMany({
            where: { id: rowId, status: "SUBMITTING" },
            data: { status: "BOOKED", inviteeUri: result.inviteeUri, eventUri: result.eventUri, cancelUrl: result.cancelUrl, rescheduleUrl: result.rescheduleUrl, resolvedAt: now },
        });
        const row = await db.frontDeskBooking.findUniqueOrThrow({ where: { id: rowId } });
        return { kind: "booked", spoken: pacificSpoken(row.startTime) };
    }
    if (result.kind === "rejected") {
        await db.frontDeskBooking.updateMany({ where: { id: rowId, status: "SUBMITTING" }, data: { status: "NOT_BOOKED", reason: "calendly_rejected", resolvedAt: now } });
        return { kind: "not_booked", reason: "calendly_rejected" };
    }
    if (result.kind === "auth") {
        await db.frontDeskBooking.updateMany({ where: { id: rowId, status: "SUBMITTING" }, data: { status: "NOT_BOOKED", reason: "calendly_auth", resolvedAt: now } });
        await db.companySettings.updateMany({ where: { id: "singleton", frontDeskCalendlyAuthFailedAt: null }, data: { frontDeskCalendlyAuthFailedAt: now } });
        await sendPlainNtfy("Front desk: Calendly auth failed", "Richard's Calendly token was rejected (401). Booking is failing until it's re-pasted on /settings/front-desk.");
        return { kind: "not_booked", reason: "calendly_auth" };
    }
    if (result.kind === "plan") {
        await db.frontDeskBooking.updateMany({ where: { id: rowId, status: "SUBMITTING" }, data: { status: "NOT_BOOKED", reason: "calendly_plan", resolvedAt: now } });
        return { kind: "not_booked", reason: "calendly_plan" };
    }
    if (result.kind === "rate_limited") {
        await db.frontDeskBooking.updateMany({ where: { id: rowId, status: "SUBMITTING" }, data: { status: "NOT_BOOKED", reason: "rate_limited", resolvedAt: now } });
        return { kind: "not_booked", reason: "rate_limited" };
    }
    // uncertain: timeout, network error, or 5xx.
    await db.frontDeskBooking.updateMany({ where: { id: rowId, status: "SUBMITTING" }, data: { status: "UNCERTAIN" } });
    return { kind: "uncertain" };
}

// ── §2.3 reconciler ──────────────────────────────────────────────────────

async function stopReconciling(db: PrismaClient, rowId: string, now: Date): Promise<void> {
    await db.frontDeskBooking.update({ where: { id: rowId }, data: { reconcileStoppedAt: now } });
    await sendPlainNtfy("Front desk: booking still uncertain", `Booking ${rowId} has been UNCERTAIN for 24 hours and will no longer be checked automatically.`);
}

/**
 * §2.3 — runs in the existing every-minute cron. Never re-POSTs and never
 * books a replacement; it only reads Calendly's own record of what actually
 * happened to the invitee.
 */
export async function reconcileFrontDeskBookings(now: Date = new Date(), db: PrismaClient = prisma): Promise<{ checked: number }> {
    const [liveConfig, testConfig] = await Promise.all([
        loadFrontDeskCalendlyConfig(db, { isTest: false }),
        loadFrontDeskCalendlyConfig(db, { isTest: true }),
    ]);

    const submittingCutoff = new Date(now.getTime() - FRONT_DESK_RECONCILE_SUBMITTING_MIN_AGE_MS);
    const retryCooldownCutoff = new Date(now.getTime() - FRONT_DESK_RECONCILE_RETRY_COOLDOWN_MS);

    const rows = await db.frontDeskBooking.findMany({
        where: {
            reconcileStoppedAt: null,
            OR: [{ status: "UNCERTAIN" }, { status: "SUBMITTING", createdAt: { lt: submittingCutoff } }],
            AND: [{ OR: [{ lastReconcileAt: null }, { lastReconcileAt: { lt: retryCooldownCutoff } }] }],
        },
        take: 50,
    });

    let checked = 0;
    for (const row of rows) {
        const config = row.isTest ? testConfig : liveConfig;
        if (!config) continue;
        checked++;
        await db.frontDeskBooking.update({ where: { id: row.id }, data: { lastReconcileAt: now } });

        const windowStart = new Date(row.startTime.getTime() - 60_000).toISOString();
        const windowEnd = new Date(row.startTime.getTime() + 60_000).toISOString();
        const events = await listScheduledEvents(config.token, config.userUri, windowStart, windowEnd);

        let calendlySucceeded = events.kind === "ok";
        let foundEventUri: string | null = null;
        if (events.kind === "ok") {
            for (const ev of events.data.collection) {
                const invitees = await listScheduledEventInvitees(config.token, ev.uri);
                if (invitees.kind !== "ok") { calendlySucceeded = false; break; }
                if (invitees.data.collection.some(inv => inv.tracking?.utm_content === row.id)) { foundEventUri = ev.uri; break; }
            }
        }

        if (foundEventUri) {
            await db.frontDeskBooking.updateMany({ where: { id: row.id, status: { in: ["SUBMITTING", "UNCERTAIN"] } }, data: { status: "BOOKED", eventUri: foundEventUri, resolvedAt: now } });
            const call = await db.frontDeskCall.findUnique({ where: { conversationId: row.conversationId } });
            if (call?.leadId) {
                await db.leadNote.create({ data: { leadId: call.leadId, content: "Booking confirmed by reconciler", createdBy: "front-desk-reconciler" } }).catch(() => undefined);
            }
            continue;
        }

        const ageSinceCreatedMs = now.getTime() - row.createdAt.getTime();
        if (!calendlySucceeded) {
            if (ageSinceCreatedMs >= FRONT_DESK_RECONCILE_MAX_AGE_MS) await stopReconciling(db, row.id, now);
            continue;
        }

        const submittedAt = row.submittedAt ?? row.createdAt;
        if (now.getTime() - submittedAt.getTime() >= FRONT_DESK_RECONCILE_ABSENT_GRACE_MS) {
            await db.frontDeskBooking.updateMany({ where: { id: row.id, status: { in: ["SUBMITTING", "UNCERTAIN"] } }, data: { status: "NOT_BOOKED", reason: "reconciled_absent", resolvedAt: now } });
        } else if (ageSinceCreatedMs >= FRONT_DESK_RECONCILE_MAX_AGE_MS) {
            await stopReconciling(db, row.id, now);
        }
    }
    return { checked };
}
