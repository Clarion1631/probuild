export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { isSalariedOwner } from "@/lib/pay-rate-guard";

/**
 * GET /api/payroll/roster — the Payroll rates panel's own data source.
 *
 * Split out from /api/users deliberately. /api/users is a MANAGER-level roster
 * endpoint that returns permissions, project access and PIN state; the rates
 * panel needed pay data, so pay data was being widened onto an endpoint with a
 * different audience and a different gate. This one is scoped to payroll
 * (ADMIN or financialReports) and returns only the columns the panel renders.
 *
 * `salaried` is resolved HERE, not in the browser: the fallback list is env
 * config (PAYROLL_SALARIED_EMAILS) and a client bundle cannot read it, so a
 * client-side copy of the rule would ignore an override.
 *
 * hourlyRate/burdenRate are exact decimal TEXT — money never goes through a JS
 * float on the way to the screen and back into an import.
 */
export async function GET(_req: Request) {
    const viewer = await getCurrentUserWithPermissions();
    if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (viewer.role !== "ADMIN" && !hasPermission(viewer, "financialReports")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // `?historicalFrom=YYYY-MM-DD&historicalTo=YYYY-MM-DD` additionally returns
    // DISABLED members with entries in that window. They are off the roster but
    // still owed a pay type: an unanswered former employee with hours in an
    // unclosed period blocks the export, and re-activating them to fix it would
    // put them back on the dispatch board.
    const url = new URL(_req.url);
    const from = url.searchParams.get("historicalFrom");
    const to = url.searchParams.get("historicalTo");
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    let historicalIds: string[] = [];
    if (from && to && DAY.test(from) && DAY.test(to)) {
        const { resolveCompanyTimeZone } = await import("@/lib/company-timezone");
        const { startOfDateInTimeZone } = await import("@/lib/tz-date");
        const timeZone = await resolveCompanyTimeZone();
        const rows = await prisma.timeEntry.findMany({
            where: {
                startTime: {
                    gte: startOfDateInTimeZone(from, timeZone),
                    lt: startOfDateInTimeZone(to, timeZone),
                },
                user: { status: "DISABLED" },
            },
            select: { userId: true },
            distinct: ["userId"],
        });
        historicalIds = rows.map((row) => row.userId);
    }

    const users = await prisma.user.findMany({
        where: historicalIds.length > 0
            ? { OR: [{ status: "ACTIVATED" }, { id: { in: historicalIds } }] }
            : { status: "ACTIVATED" },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            payType: true,
            hourlyRate: true,
            burdenRate: true,
            lastRateSyncAt: true,
            status: true,
        },
        orderBy: [{ name: "asc" }, { email: "asc" }],
    });

    return NextResponse.json(
        users.map((user) => ({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            payType: user.payType ?? null,
            hourlyRate: user.hourlyRate.toFixed(2),
            burdenRate: user.burdenRate.toFixed(2),
            lastRateSyncAt: user.lastRateSyncAt ? user.lastRateSyncAt.toISOString() : null,
            // The panel splits on this: a former employee gets the historical
            // section, where their pay type can be set without reactivating them.
            historical: user.status === "DISABLED",
            salaried: isSalariedOwner({ role: user.role, email: user.email, payType: user.payType }),
        }))
    );
}
