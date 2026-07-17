import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

export const dynamic = "force-dynamic";

function escapeIcal(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// Full UTC datetime, e.g. 20260717T000000Z — used for regular (non all-day) tasks.
function formatIcalDateTime(date: Date): string {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Date-only, e.g. 20260717 — used for all-day (milestone) VEVENTs.
// Reads UTC calendar components directly so a date stored as a UTC-midnight
// DateTime renders as the same calendar day, regardless of server timezone.
function formatIcalDateOnly(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
}

function addUTCDays(date: Date, days: number): Date {
    const d = new Date(date.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

function isSameUTCDay(a: Date, b: Date): boolean {
    return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

export async function GET(req: NextRequest) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const projectId = req.nextUrl.searchParams.get("projectId");
    if (!projectId) {
        return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const fail = await assertProjectAccess(auth.user, projectId);
    if (fail) return fail;

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true },
    });
    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const tasks = await prisma.scheduleTask.findMany({
        where: { projectId },
        orderBy: { startDate: "asc" },
        select: {
            id: true,
            name: true,
            startDate: true,
            endDate: true,
            status: true,
            type: true,
            assignee: true,
            progress: true,
        },
    });

    const now = formatIcalDateTime(new Date());
    const calName = escapeIcal(`${project.name} — Schedule`);

    const events = tasks.map((task) => {
        const start = new Date(task.startDate);
        const end = new Date(task.endDate);
        const summary = escapeIcal(task.name);
        const desc = escapeIcal(
            [
                `Status: ${task.status}`,
                task.assignee ? `Assignee: ${task.assignee}` : null,
                `Progress: ${task.progress}%`,
                task.type === "milestone" ? "Type: Milestone" : null,
            ]
                .filter(Boolean)
                .join("\\n")
        );

        // Milestones and zero/one-day tasks render as all-day events so they
        // land on the correct calendar day instead of a timed midnight block.
        const isAllDay = task.type === "milestone" || isSameUTCDay(start, end);

        const dtLines = isAllDay
            ? [
                  `DTSTART;VALUE=DATE:${formatIcalDateOnly(start)}`,
                  // All-day DTEND is exclusive per RFC 5545, so a one-day event's
                  // end is the day after its start.
                  `DTEND;VALUE=DATE:${formatIcalDateOnly(addUTCDays(start, 1))}`,
              ]
            : [
                  `DTSTART:${formatIcalDateTime(start)}`,
                  `DTEND:${formatIcalDateTime(end)}`,
              ];

        return [
            "BEGIN:VEVENT",
            `UID:${task.id}@probuild`,
            `DTSTAMP:${now}`,
            ...dtLines,
            `SUMMARY:${summary}`,
            `DESCRIPTION:${desc}`,
            `STATUS:${task.status === "Complete" ? "COMPLETED" : "CONFIRMED"}`,
            "END:VEVENT",
        ].join("\r\n");
    });

    const ical = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//ProBuild//Schedule//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        `X-WR-CALNAME:${calName}`,
        ...events,
        "END:VCALENDAR",
    ].join("\r\n");

    const slug = project.name.trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const filename = `${slug}-schedule.ics`;

    return new NextResponse(ical, {
        status: 200,
        headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
    });
}
