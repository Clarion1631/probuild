export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userHasRole } from "@/lib/mobile-auth";

const MS_PER_HOUR = new Prisma.Decimal(1000 * 60 * 60);

type Params = { params: Promise<{ id: string }> };

/**
 * Edit a past time entry with a reason. Owner or ADMIN/MANAGER may edit.
 * On the first edit, snapshots `startTime`/`endTime` into
 * `originalStartTime`/`originalEndTime` and flips `isEdited` to true.
 * Recomputes `durationHours`/`laborCost`/`burdenCost` from the **owner's**
 * rates (not the editor's). When a manager edits another user's entry,
 * sets `editedByManagerId` + `editedAt`.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;

    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { startTime, endTime, editNotes } = body as {
        startTime?: string;
        endTime?: string | null;
        editNotes?: string;
    };

    if (typeof editNotes !== "string" || editNotes.trim().length === 0) {
        return NextResponse.json({ error: "editNotes is required" }, { status: 400 });
    }

    const existing = await prisma.timeEntry.findUnique({
        where: { id },
        include: { user: true },
    });
    if (!existing) {
        return NextResponse.json({ error: "Time entry not found" }, { status: 404 });
    }

    const isOwner = existing.userId === user.id;
    const isManager = userHasRole(user, ["ADMIN", "MANAGER"]);
    if (!isOwner && !isManager) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const newStart = startTime !== undefined ? new Date(startTime) : existing.startTime;
    if (Number.isNaN(newStart.getTime())) {
        return NextResponse.json({ error: "Invalid startTime" }, { status: 400 });
    }

    let newEnd: Date | null;
    if (endTime === undefined) {
        newEnd = existing.endTime;
    } else if (endTime === null) {
        newEnd = null;
    } else {
        newEnd = new Date(endTime);
        if (Number.isNaN(newEnd.getTime())) {
            return NextResponse.json({ error: "Invalid endTime" }, { status: 400 });
        }
    }

    if (newEnd && newEnd.getTime() < newStart.getTime()) {
        return NextResponse.json({ error: "endTime must be after startTime" }, { status: 400 });
    }

    const update: Prisma.TimeEntryUpdateInput = {
        startTime: newStart,
        endTime: newEnd,
        isEdited: true,
        editNotes: editNotes.trim(),
    };

    if (!existing.isEdited) {
        update.originalStartTime = existing.startTime;
        update.originalEndTime = existing.endTime;
    }

    if (newEnd) {
        const durationMs = Math.max(0, newEnd.getTime() - newStart.getTime());
        const durationDecimal = new Prisma.Decimal(durationMs).div(MS_PER_HOUR);
        const ownerHourly = new Prisma.Decimal(existing.user.hourlyRate.toString());
        const ownerBurden = new Prisma.Decimal(existing.user.burdenRate.toString());
        update.durationHours = durationDecimal.toNumber();
        update.laborCost = durationDecimal.mul(ownerHourly);
        update.burdenCost = durationDecimal.mul(ownerBurden);
    } else {
        update.durationHours = null;
        update.laborCost = null;
        update.burdenCost = null;
    }

    if (isManager && !isOwner) {
        update.editedByManagerId = user.id;
        update.editedAt = new Date();
    }

    const updated = await prisma.timeEntry.update({
        where: { id },
        data: update,
        include: { user: true, project: true, costCode: true },
    });

    return NextResponse.json(JSON.parse(JSON.stringify(updated)));
}

/**
 * Manager-only deletion. Cascade deletion is governed by Prisma's
 * onDelete rules — TimeEntry is a leaf row so no extra cleanup.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;

    if (!userHasRole(user, ["ADMIN", "MANAGER"])) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) {
        return NextResponse.json({ error: "Time entry not found" }, { status: 404 });
    }

    await prisma.timeEntry.delete({ where: { id } });
    return NextResponse.json({ ok: true });
}
