import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getGustoSettings } from "@/lib/integration-store";

/**
 * Generates a Gusto-compatible CSV for time entries.
 * Gusto payroll import format:
 * Employee Name, Hours, Date, Project
 */
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId") || undefined;
    const projectId = searchParams.get("projectId") || undefined;
    const dateFrom = searchParams.get("dateFrom") || undefined;
    const dateTo = searchParams.get("dateTo") || undefined;

    const gustoSettings = await getGustoSettings();
    const employeeMappings = gustoSettings.employeeMappings || {};

    const where: Record<string, unknown> = {};
    if (userId) where.userId = userId;
    if (projectId) where.projectId = projectId;
    if (dateFrom || dateTo) {
        where.startTime = {};
        if (dateFrom) (where.startTime as Record<string, unknown>).gte = new Date(dateFrom);
        if (dateTo) (where.startTime as Record<string, unknown>).lte = new Date(dateTo + "T23:59:59");
    }

    const entries = await prisma.timeEntry.findMany({
        where,
        include: { user: true, project: true, costCode: true },
        orderBy: { startTime: "asc" },
    });

    // Build CSV
    const rows: string[] = [
        "Employee Name,Gusto Employee ID,Hours,Date,Project,Cost Code,Notes",
    ];

    for (const entry of entries) {
        const name = entry.user?.name || "Unknown";
        const gustoId = entry.userId ? (employeeMappings[entry.userId] || "") : "";
        const hours = (entry.durationHours || 0).toFixed(2);
        const date = entry.startTime
            ? new Date(entry.startTime).toLocaleDateString("en-US")
            : "";
        const project = (entry.project?.name || "").replace(/,/g, " ");
        const costCode = (entry.costCode?.code || "").replace(/,/g, " ");
        const notes = "";

        rows.push(`"${name}","${gustoId}","${hours}","${date}","${project}","${costCode}","${notes}"`);
    }

    const csv = rows.join("\n");
    const filename = `gusto-export-${new Date().toISOString().split("T")[0]}.csv`;

    return new NextResponse(csv, {
        headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
    });
}
