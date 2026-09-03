export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { applyRateChangeInTx, RateChangeError } from "@/lib/pay-rate-write";
import { withPayrollUserWrite } from "@/lib/payroll-period";
import { checkUserMutation } from "@/lib/user-mutation-guard";

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

    const target = await prisma.user.findUnique({
        where: { id },
        select: { id: true, role: true },
    });
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // THE shared rules (src/lib/user-mutation-guard.ts). They were written HERE
    // and nowhere else, which is how three browser routes ended up with none at
    // all: a manager could promote themselves to ADMIN, grant themselves every
    // permission, or disable the real admins through any of them (round 9,
    // finding 1). Enum validation, the admin-only role change, and "a manager
    // cannot touch an admin" now all come from one function.
    const verdict = checkUserMutation({
        actor: { id: user.id, role: user.role },
        target,
        changes: { role: body.role, status: body.status },
    });
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status });

    // applyRateChange asks whether this caller has financialReports, not just
    // whether they are a manager, so the permissions row has to be loaded.
    const rateActor = await prisma.user.findUnique({
        where: { id: user.id },
        select: { role: true, permissions: true },
    });

    const data: Record<string, unknown> = {};
    if (typeof body.role === "string") data.role = body.role;
    if (typeof body.status === "string") data.status = body.status;
    const touchesRates =
        body.hourlyRate !== undefined || body.burdenRate !== undefined || body.payType !== undefined;
    if (Object.keys(data).length === 0 && !touchesRates) {
        return NextResponse.json({ error: "No mutable fields supplied" }, { status: 400 });
    }

    // Profile fields and rates commit TOGETHER. Rates go through the one
    // validated path (payroll permission, exact decimal, lastRateSyncAt); a
    // refusal rolls the profile half back rather than leaving a half-applied
    // update behind.
    let updated;
    try {
        updated = await prisma.$transaction(async (tx) => {
            const rateResult = await applyRateChangeInTx(
                tx,
                rateActor,
                id,
                { hourlyRate: body.hourlyRate, burdenRate: body.burdenRate, payType: body.payType }
            );
            if (!rateResult.ok) throw new RateChangeError(rateResult.status, rateResult.error);

            if (Object.keys(data).length === 0) {
                return tx.user.findUniqueOrThrow({
                    where: { id },
                    select: {
                        id: true, email: true, name: true, role: true, status: true,
                        hourlyRate: true, burdenRate: true,
                    },
                });
            }
            // The mobile manager screen can activate or disable somebody,
            // and status is half of the Gusto roster predicate. Same tier-1
            // payroll lock as every other export-input writer.
            return withPayrollUserWrite(tx, data, () =>
                tx.user.update({
                    where: { id },
                    data,
                    select: {
                        id: true, email: true, name: true, role: true, status: true,
                        hourlyRate: true, burdenRate: true,
                    },
                })
            );
        });
    } catch (error) {
        if (error instanceof RateChangeError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
    }

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
