export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { applyRateChange } from "@/lib/pay-rate-write";

const VALID_ROLES = new Set(["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE"]);
const VALID_STATUSES = new Set(["PENDING", "ACTIVATED", "DISABLED"]);

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Guard the role/status enums on the server — we never want a typo from the mobile
    // app to land an invalid value in the DB. Treat unknown values as 400, not silent drop.
    if (typeof body.role === "string" && !VALID_ROLES.has(body.role)) {
        return NextResponse.json({ error: `Invalid role: ${body.role}` }, { status: 400 });
    }
    if (typeof body.status === "string" && !VALID_STATUSES.has(body.status)) {
        return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
    }

    // Privilege rules:
    //   - Only ADMINs may grant the ADMIN role.
    //   - MANAGERs cannot modify ADMIN users at all (would let a manager demote/disable
    //     an admin and hijack the org). ADMINs can edit anyone, including themselves,
    //     but the lone-admin recovery case is the org's responsibility.
    if (typeof body.role === "string" && body.role === "ADMIN" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Only admins can grant the ADMIN role" }, { status: 403 });
    }

    const target = await prisma.user.findUnique({
        where: { id },
        select: { id: true, role: true },
    });
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

    if (target.role === "ADMIN" && user.role !== "ADMIN") {
        return NextResponse.json(
            { error: "Only admins can modify an ADMIN user" },
            { status: 403 }
        );
    }

    // applyRateChange asks whether this caller has financialReports, not just
    // whether they are a manager, so the permissions row has to be loaded.
    const rateActor = await prisma.user.findUnique({
        where: { id: user.id },
        select: { role: true, permissions: true },
    });

    const data: Record<string, unknown> = {};
    if (typeof body.role === "string") data.role = body.role;
    if (typeof body.status === "string") data.status = body.status;
    // Rates go through the ONE validated path: payroll permission, exact
    // decimal, lastRateSyncAt stamped. This route used to write them as raw JS
    // numbers with no stamp and only a manager-level gate.
    const rateResult = await applyRateChange(rateActor, id, {
        hourlyRate: body.hourlyRate,
        burdenRate: body.burdenRate,
        payType: body.payType,
    });
    if (!rateResult.ok) {
        return NextResponse.json({ error: rateResult.error }, { status: rateResult.status });
    }

    if (Object.keys(data).length === 0) {
        if (rateResult.changed) {
            const row = await prisma.user.findUnique({
                where: { id },
                select: { id: true, email: true, name: true, role: true, status: true },
            });
            return NextResponse.json(row);
        }
        return NextResponse.json({ error: "No mutable fields supplied" }, { status: 400 });
    }

    const updated = await prisma.user.update({
        where: { id },
        data,
        select: {
            id: true,
            email: true,
            name: true,
            role: true,
            status: true,
            hourlyRate: true,
            burdenRate: true,
        },
    });

    // Newly ACTIVATED FIELD_CREW (or CJ) joins every "In Progress" project.
    // Fail-soft inside the helper; never blocks the save.
    const { autoAssignProjectsOnUserChange } = await import("@/lib/crew-auto-assign-sync");
    after(() => autoAssignProjectsOnUserChange(id, { role: data.role, status: data.status }));

    return NextResponse.json({
        ...updated,
        hourlyRate: toNum(updated.hourlyRate),
        burdenRate: toNum(updated.burdenRate),
    });
}
