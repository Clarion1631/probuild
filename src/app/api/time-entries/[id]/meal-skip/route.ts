import { timeEntryVoidedResponse } from "@/lib/time-entry-void";
export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withPayrollWrite, withPeriodLockedRoute } from "@/lib/payroll-period";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { canApproveMealSkip, checkMealSkipDecision } from "@/lib/wa-breaks";
import { isValidChatWebhookUrl } from "@/lib/chat-webhook";

// Skip-lunch = express permission, the Washington way (owner decision D5,
// 2026-08-28). The crew member asks FROM THE APP while clocked in; a named
// approver (CJ / Richard / Justin — src/lib/wa-breaks.ts) approves or denies.
// An APPROVED request lets the clock-out close with no meal deduction and no
// review flag (src/lib/wa-breaks.ts computeMealDeduction). Anything else —
// pending, denied, never asked — falls back to the automatic deduction, with
// the worked-through attestation at clock-out as the lawful escape hatch.
//
//   POST  /api/time-entries/[id]/meal-skip            crew: request on own OPEN entry
//   PATCH /api/time-entries/[id]/meal-skip {decision} approver: APPROVED | DENIED
//
// Approval is refused without a signed meal-period waiver on file
// (User.mealWaiverSignedAt) — that is the written, revocable waiver L&I expects
// to exist before a worker gives up a meal period.

const NOTIFY_TIMEOUT_MS = 8_000;

/** Best-effort manager ping to a Google Chat incoming webhook (MEAL_SKIP_CHAT_WEBHOOK_URL). Never throws. */
async function notifyApprovers(text: string): Promise<void> {
    const url = process.env.MEAL_SKIP_CHAT_WEBHOOK_URL;
    if (!url || !isValidChatWebhookUrl(url)) return;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
            signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
        });
        // Google Chat answers a bad/revoked webhook with 4xx JSON — log it so a
        // silent "nobody got pinged" can be traced in the Vercel runtime logs.
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            console.error("[meal-skip] approver notify rejected", res.status, body.slice(0, 300));
        }
    } catch (error) {
        console.error("[meal-skip] approver notify failed", error);
    }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
    // A payroll write inside: a locked period is a 423, never a 500.
    return withPeriodLockedRoute(() => POSTHandler(req, context));
}

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    const { id } = await params;

    const entry = await prisma.timeEntry.findUnique({
        where: { id },
        select: {
            voidedAt: true,
            id: true,
            userId: true,
            endTime: true,
            mealSkipStatus: true,
            user: { select: { name: true, email: true, mealWaiverSignedAt: true } },
            project: { select: { name: true } },
        },
    });
    if (!entry) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });
    // Only the worker asks for their own lunch — a manager who wants to waive
    // for someone uses the approval side, which leaves their name on it.
    if (entry.userId !== user.id) return NextResponse.json({ error: "Not your time entry" }, { status: 403 });
    if (entry.voidedAt) return timeEntryVoidedResponse();
    if (entry.endTime != null) {
        return NextResponse.json({ error: "Shift is already closed", code: "ENTRY_CLOSED" }, { status: 409 });
    }
    // Idempotent: a double-tap or retry re-returns the existing request rather
    // than resetting an APPROVED one back to PENDING.
    if (entry.mealSkipStatus) {
        return NextResponse.json({ id: entry.id, mealSkipStatus: entry.mealSkipStatus, alreadyRequested: true });
    }

    // Payroll write: goes through the advisory-lock protocol so a locked
    // period refuses it (src/lib/payroll-period.ts).
    const updated = await withPayrollWrite({ entryIds: [id] }, async (tx) =>
        (tx as unknown as typeof prisma).timeEntry.updateMany({
        where: { id, userId: user.id, endTime: null, mealSkipStatus: null },
        data: { mealSkipStatus: "PENDING", mealSkipRequestedAt: new Date() },
        })
    );
    if (updated.count === 0) {
        const current = await prisma.timeEntry.findUnique({ where: { id }, select: { mealSkipStatus: true, endTime: true } });
        if (current?.mealSkipStatus) {
            return NextResponse.json({ id, mealSkipStatus: current.mealSkipStatus, alreadyRequested: true });
        }
        // Lost a race with the clock-out: the shift closed between our read and the write.
        return NextResponse.json({ error: "Shift is already closed", code: "ENTRY_CLOSED" }, { status: 409 });
    }

    const who = entry.user.name || entry.user.email || "A crew member";
    const waiverNote = entry.user.mealWaiverSignedAt ? "" : " (no signed waiver on file — cannot be approved until signed)";
    await notifyApprovers(
        `🍽️ *Skip-lunch request* — ${who} on ${entry.project.name}${waiverNote}. Approve or deny in ProBuild → Manager → Time Entries.`
    );

    return NextResponse.json({ id, mealSkipStatus: "PENDING", waiverOnFile: !!entry.user.mealWaiverSignedAt });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
    // A payroll write inside: a locked period is a 423, never a 500.
    return withPeriodLockedRoute(() => PATCHHandler(req, context));
}

async function PATCHHandler(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    const { id } = await params;

    if (!canApproveMealSkip({ role: user.role, email: user.email })) {
        return NextResponse.json({ error: "Not an approver for skip-lunch requests" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const decision = body?.decision;
    if (decision !== "APPROVED" && decision !== "DENIED") {
        return NextResponse.json({ error: "decision must be APPROVED or DENIED" }, { status: 400 });
    }
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;

    const entry = await prisma.timeEntry.findUnique({
        where: { id },
        select: { voidedAt: true, id: true, endTime: true, mealSkipStatus: true, user: { select: { mealWaiverSignedAt: true } } },
    });
    if (!entry) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });

    if (entry.voidedAt) return timeEntryVoidedResponse();
    const check = checkMealSkipDecision({
        decision,
        currentStatus: entry.mealSkipStatus,
        entryClosed: entry.endTime != null,
        waiverSignedAt: entry.user.mealWaiverSignedAt,
    });
    if (!check.ok) {
        const messages = {
            NOT_PENDING: "There is no pending request on this entry",
            WAIVER_NOT_SIGNED: "This worker has no signed meal-period waiver on file — get Marge's form signed first",
            ENTRY_CLOSED: "The shift already closed; the clock-out attestation applies instead",
        } as const;
        return NextResponse.json({ error: messages[check.code], code: check.code }, { status: 409 });
    }

    // Guarded update: only a still-PENDING row flips, so two approvers
    // deciding at once cannot overwrite each other.
    // Payroll write: goes through the advisory-lock protocol so a locked
    // period refuses it (src/lib/payroll-period.ts).
    const flipped = await withPayrollWrite({ entryIds: [id] }, async (tx) =>
        (tx as unknown as typeof prisma).timeEntry.updateMany({
        // APPROVED additionally requires the shift to STILL be open at write time —
        // a clock-out racing this decision must not leave "approved" on a row
        // whose pay was already settled by the attestation path.
        // ...and the waiver must STILL be on file at write time (a revocation
        // racing this approval must win).
        where: {
            id,
            mealSkipStatus: "PENDING",
            ...(decision === "APPROVED" ? { endTime: null, user: { mealWaiverSignedAt: { not: null } } } : {}),
        },
        data: {
            mealSkipStatus: decision,
            mealSkipDecidedById: user.id,
            mealSkipDecidedAt: new Date(),
            ...(reason !== undefined ? { mealSkipReason: reason } : {}),
        },
        })
    );
    if (flipped.count === 0) {
        return NextResponse.json({ error: "Request was already decided", code: "NOT_PENDING" }, { status: 409 });
    }

    const result = await prisma.timeEntry.findUniqueOrThrow({
        where: { id },
        select: { id: true, mealSkipStatus: true, mealSkipDecidedAt: true, mealSkipDecidedById: true, mealSkipReason: true },
    });
    return NextResponse.json(result);
}
