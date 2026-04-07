import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function escapeIcal(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function formatIcalDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export async function GET(req: NextRequest) {
    const projectId = req.nextUrl.searchParams.get("projectId");
    if (!projectId) {
        return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

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

    const now = formatIcalDate(new Date());
    const calName = escapeIcal(`${project.name} — Schedule`);

    const events = tasks.map((task) => {
        const start = formatIcalDate(new Date(task.startDate));
        const end = formatIcalDate(new Date(task.endDate));
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

        return [
            "BEGIN:VEVENT",
            `UID:${task.id}@probuild`,
            `DTSTAMP:${now}`,
            `DTSTART:${start}`,
            `DTEND:${end}`,
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

    const filename = `${project.name.replace(/[^a-zA-Z0-9]/g, "_")}_schedule.ics`;

    return new NextResponse(ical, {
        status: 200,
        headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
    });
}
