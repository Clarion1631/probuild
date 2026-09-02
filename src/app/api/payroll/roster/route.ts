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
export async function GET() {
    const viewer = await getCurrentUserWithPermissions();
    if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (viewer.role !== "ADMIN" && !hasPermission(viewer, "financialReports")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const users = await prisma.user.findMany({
        where: { status: "ACTIVATED" },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            payType: true,
            hourlyRate: true,
            burdenRate: true,
            lastRateSyncAt: true,
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
            salaried: isSalariedOwner({ role: user.role, email: user.email, payType: user.payType }),
        }))
    );
}
