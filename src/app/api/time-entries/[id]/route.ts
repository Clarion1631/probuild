export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

// Mobile + web hybrid. Two distinct flows, both routed through PATCH:
//
//   1. Edit  — body has `startTime` and/or `endTime` and `editNotes`.
//              Captures the original times the FIRST time the entry is edited
//              (so the audit trail preserves the as-clocked values), recomputes
//              durationHours / laborCost / burdenCost from the OWNER's rates
//              (not the editor's), and stamps `editedByManagerId` + `editedAt`
//              when a manager edits someone else's punch.
//
//   2. Offsite telemetry — body has `offsiteMs` / `isOffsite` / `lastLocationCheck`.
//                          Mobile geofence watcher hits this every minute or on
//                          a state change; we accept the absolute offsite_ms the
//                          mobile reports so retries don't double-count.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });

    const isOwner = existing.userId === user.id;
    const isPrivileged = user.role === "MANAGER" || user.role === "ADMIN";

    // Field crew can edit their own; managers/admins can edit anyone's.
    if (!isOwner && !isPrivileged) {
        return NextResponse.json({ error: "Unauthorized to edit this entry" }, { status: 403 });
    }

    const body = await req.json();

    // -------- Branch detection. We refuse to mix the two flows in one request because
    // edits recompute laborCost while telemetry must NOT touch it; combining them would
    // either silently drop telemetry (the bug Codex flagged) or recompute cost off
    // partial inputs. Mobile sends one or the other.
    const telemetryFields = ["offsiteMs", "isOffsite", "lastLocationCheck"] as const;
    const editFields = ["startTime", "endTime", "editNotes"] as const;
    const hasTelemetry = telemetryFields.some((k) => body[k] !== undefined);
    const hasEdit = editFields.some((k) => body[k] !== undefined);

    if (hasTelemetry && hasEdit) {
        return NextResponse.json(
            { error: "Cannot mix telemetry fields with edit fields in one request" },
            { status: 400 }
        );
    }

    if (hasTelemetry) {
        // Telemetry only flows from the owner's own device — even a manager shouldn't
        // be writing geofence data for someone else.
        if (!isOwner) {
            return NextResponse.json(
                { error: "Telemetry can only be reported by the entry owner" },
                { status: 403 }
            );
        }
        const data: Record<string, unknown> = {};
        if (body.offsiteMs !== undefined) {
            if (
                typeof body.offsiteMs !== "number" ||
                !Number.isFinite(body.offsiteMs) ||
                body.offsiteMs < 0
            ) {
                return NextResponse.json({ error: "offsiteMs must be a non-negative number" }, { status: 400 });
            }
            data.offsiteMs = Math.floor(body.offsiteMs);
        }
        if (body.isOffsite !== undefined) {
            if (typeof body.isOffsite !== "boolean") {
                return NextResponse.json({ error: "isOffsite must be a boolean" }, { status: 400 });
            }
            data.isOffsite = body.isOffsite;
        }
        if (body.lastLocationCheck !== undefined) {
            if (typeof body.lastLocationCheck !== "string") {
                return NextResponse.json({ error: "lastLocationCheck must be an ISO string" }, { status: 400 });
            }
            const d = new Date(body.lastLocationCheck);
            if (Number.isNaN(d.getTime())) {
                return NextResponse.json({ error: "Invalid lastLocationCheck" }, { status: 400 });
            }
            data.lastLocationCheck = d;
        }
        if (Object.keys(data).length === 0) {
            return NextResponse.json({ error: "No telemetry fields supplied" }, { status: 400 });
        }
        const updated = await prisma.timeEntry.update({ where: { id }, data });
        return NextResponse.json(JSON.parse(JSON.stringify(updated)));
    }

    // -------- Branch 2: edit with reason. Recompute costs from OWNER's rates. --------
    if (!hasEdit) {
        return NextResponse.json(
            { error: "Provide either telemetry fields or edit fields" },
            { status: 400 }
        );
    }
    if (!body.editNotes || typeof body.editNotes !== "string" || !body.editNotes.trim()) {
        return NextResponse.json({ error: "editNotes is required for time-entry edits" }, { status: 400 });
    }

    const newStart = body.startTime ? new Date(body.startTime) : existing.startTime;
    const newEnd =
        body.endTime === null ? null : body.endTime ? new Date(body.endTime) : existing.endTime;

    if (Number.isNaN(newStart.getTime())) {
        return NextResponse.json({ error: "Invalid startTime" }, { status: 400 });
    }
    if (newEnd && Number.isNaN(newEnd.getTime())) {
        return NextResponse.json({ error: "Invalid endTime" }, { status: 400 });
    }
    if (newEnd && newEnd.getTime() <= newStart.getTime()) {
        return NextResponse.json({ error: "endTime must be after startTime" }, { status: 400 });
    }

    // Owner's labor + burden rates drive cost. A manager editing a field crew's
    // punch must NOT stamp manager rates onto the entry.
    const owner = isOwner
        ? user
        : await prisma.user.findUnique({ where: { id: existing.userId } });
    if (!owner) return NextResponse.json({ error: "Entry owner not found" }, { status: 404 });

    const durationHours = newEnd ? (newEnd.getTime() - newStart.getTime()) / 3_600_000 : null;
    const laborCost = durationHours != null ? durationHours * toNum(owner.hourlyRate) : null;
    const burdenCost = durationHours != null ? durationHours * toNum(owner.burdenRate) : null;

    const data: Record<string, unknown> = {
        startTime: newStart,
        endTime: newEnd,
        durationHours,
        laborCost,
        burdenCost,
        editNotes: body.editNotes.trim(),
        isEdited: true,
    };

    // Capture the as-clocked values exactly once. Subsequent edits update the latest
    // times but never overwrite the original snapshot.
    if (!existing.isEdited) {
        data.originalStartTime = existing.startTime;
        data.originalEndTime = existing.endTime;
    }

    if (isPrivileged && !isOwner) {
        data.editedByManagerId = user.id;
        data.editedAt = new Date();
    }

    const updated = await prisma.timeEntry.update({ where: { id }, data });
    return NextResponse.json(JSON.parse(JSON.stringify(updated)));
}

// Manager/admin only. Field crew correct mistakes via PATCH (with editNotes audit);
// outright deletion is a separate, stronger action that needs the audit-log gap to be
// explicit on the record (we just remove it; payroll already accounts for `isEdited`).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Only managers can delete time entries" }, { status: 403 });
    }

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const existing = await prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });

    await prisma.timeEntry.delete({ where: { id } });
    return NextResponse.json({ ok: true });
}
