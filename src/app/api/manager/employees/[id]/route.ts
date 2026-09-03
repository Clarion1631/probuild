export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { applyRateChangeInTx, RateChangeError } from "@/lib/pay-rate-write";
import { touchesPayrollRateState, withPayrollUserWrite } from "@/lib/payroll-period";
import {
    isUserMutationRefusedError,
    isUserMutationTargetNotFoundError,
    withGuardedUserMutation,
} from "@/lib/user-mutation-guard";

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

    // applyRateChange asks whether this caller has financialReports, not just
    // whether they are a manager, so the permissions row has to be loaded.
    const rateActor = await prisma.user.findUnique({
        where: { id: user.id },
        select: { role: true, permissions: true },
    });

    const data: Record<string, unknown> = {};
    if (typeof body.role === "string") data.role = body.role;
    if (typeof body.status === "string") data.status = body.status;
    // ONE rate payload, handed BOTH to the guard (which uses it to decide that
    // the payroll advisory lock must be taken before the target row lock) and to
    // the rate writer itself, and asked with the SAME predicate the writer uses.
    const rateChange = { hourlyRate: body.hourlyRate, burdenRate: body.burdenRate, payType: body.payType };
    const touchesRates = touchesPayrollRateState(rateChange);
    if (Object.keys(data).length === 0 && !touchesRates) {
        return NextResponse.json({ error: "No mutable fields supplied" }, { status: 400 });
    }

    // Profile fields and rates commit TOGETHER. Rates go through the one
    // validated path (payroll permission, exact decimal, lastRateSyncAt); a
    // refusal rolls the profile half back rather than leaving a half-applied
    // update behind.
    //
    // THE shared rules (src/lib/user-mutation-guard.ts). They were written HERE
    // and nowhere else, which is how three browser routes ended up with none at
    // all: a manager could promote themselves to ADMIN, grant themselves every
    // permission, or disable the real admins through any of them (round 9,
    // finding 1). Enum validation, the admin-only role change, and "a manager
    // cannot touch an admin" now all come from one function — and, since round
    // 12, that function is re-run inside the transaction against the row
    // withGuardedUserMutation just locked with FOR UPDATE, not against a role
    // read taken before the transaction opened (round 12, finding 2).
    let updated;
    try {
        updated = await prisma.$transaction(async (tx) => {
            return withGuardedUserMutation(
                tx,
                {
                    actor: { id: user.id, role: user.role },
                    targetId: id,
                    changes: { role: body.role, status: body.status },
                    data,
                    rateChange,
                },
                async () => {
                    const rateResult = await applyRateChangeInTx(tx, rateActor, id, rateChange);
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
                }
            );
        });
    } catch (error) {
        if (error instanceof RateChangeError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        if (isUserMutationRefusedError(error)) {
            return NextResponse.json({ error: error.verdict.error }, { status: error.verdict.status });
        }
        if (isUserMutationTargetNotFoundError(error)) {
            return NextResponse.json({ error: "User not found" }, { status: 404 });
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
