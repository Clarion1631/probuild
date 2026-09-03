import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { applyRateChangeInTx, RateChangeError } from "@/lib/pay-rate-write";
import { withPayrollUserWrite } from "@/lib/payroll-period";
import {
    isUserMutationActorInvalidError,
    isUserMutationRefusedError,
    isUserMutationTargetNotFoundError,
    withGuardedUserCreate,
    withGuardedUserMutation,
} from "@/lib/user-mutation-guard";
import { Resend } from "resend";
import bcrypt from "bcryptjs";
import { toSafeUser } from "@/lib/user-safe";

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy");

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const currentUser = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const users = await prisma.user.findMany({
            orderBy: [{ role: "asc" }, { name: "asc" }],
            select: {
                id: true, name: true, email: true, role: true, status: true,
                showOnDispatch: true, pinCode: true, invitedAt: true,
                permissions: true,
                projectAccess: { select: { projectId: true } },
                assignedProjects: { select: { id: true } },
            },
        });

        // Never expose PIN hash to clients; replace with a boolean indicator.
        // Payroll fields are NOT selected here — this is a MANAGER-level roster
        // endpoint, and pay is gated on ADMIN-or-financialReports. The Payroll
        // rates panel reads its own payroll-scoped GET /api/payroll/roster.
        // The same helper every other User response uses now — this route
        // already did it right, and the rule moved somewhere both can share.
        const safeUsers = users.map(toSafeUser);
        return NextResponse.json(safeUsers);
    } catch (error: any) {
        console.error("GET /api/users error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // `permissions` is loaded because applyRateChange asks whether this
        // caller has financialReports, not just whether they are a manager.
        const currentUser = await prisma.user.findUnique({
            where: { email: session.user.email },
            include: { permissions: true },
        });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const body = await req.json();
        const { name, email, role, hourlyRate, burdenRate, pinCode } = body;

        if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

        // A create cannot demote anybody, but it CAN mint an admin - this route
        // accepted an arbitrary `role` string from any manager (round 9,
        // finding 1). Status is not a parameter: every create starts PENDING.
        //
        // The check now runs INSIDE the transaction below, against the actor's
        // own row locked FOR SHARE. It used to run here, against the actor read
        // taken before the transaction opened, and the insert happened
        // afterwards — so a manager demoted or disabled in that gap still minted
        // an account and still set its pay rates (round 14, finding 3).
        const exactEmailLower = email.toLowerCase().trim();
        const existingUser = await prisma.user.findUnique({ where: { email: exactEmailLower } });
        if (existingUser) return NextResponse.json({ error: "User with this email already exists" }, { status: 400 });

        // Create + set rates in ONE transaction. Rates go through
        // applyRateChange (permission, exact decimal, lastRateSyncAt); creating
        // the user with an inline Number() was a fourth, unguarded rate writer.
        const hashedPin = pinCode ? await bcrypt.hash(pinCode, 10) : null;
        let newUser;
        try {
            newUser = await prisma.$transaction(async (tx) =>
                withGuardedUserCreate(tx, { actorId: currentUser.id, role }, async (actor) => {
                    const created = await tx.user.create({
                        data: {
                            name: name || null,
                            email: exactEmailLower,
                            role: role || "FIELD_CREW",
                            status: "PENDING",
                            pinCode: hashedPin,
                            invitedAt: new Date(),
                        },
                    });
                    // The LOCKED actor, not the pre-transaction read.
                    const rateResult = await applyRateChangeInTx(tx, actor, created.id, {
                        hourlyRate,
                        burdenRate,
                        payType: body.payType,
                    });
                    if (!rateResult.ok) throw new RateChangeError(rateResult.status, rateResult.error);
                    // RE-READ, inside the same transaction. `created` is the row
                    // as it was BEFORE applyRateChangeInTx ran its own update, so
                    // returning it answered 201 with hourlyRate/payType still
                    // null and payrollRevision/lastRateSyncAt still at their
                    // defaults — a body that contradicted the committed row and
                    // sent the caller's UI back to a rate nobody had entered.
                    return tx.user.findUniqueOrThrow({ where: { id: created.id } });
                })
            );
        } catch (error) {
            if (error instanceof RateChangeError) {
                return NextResponse.json({ error: error.message }, { status: error.status });
            }
            // The authority verdict, decided against the actor's LOCKED row.
            if (isUserMutationRefusedError(error) || isUserMutationActorInvalidError(error)) {
                return NextResponse.json({ error: error.verdict.error }, { status: error.verdict.status });
            }
            throw error;
        }

        // Create default permissions record
        const permission = await prisma.userPermission.create({ data: { userId: newUser.id } });

        // Auto-grant access to all existing projects if autoGrantNewProjects is enabled
        if (permission.autoGrantNewProjects) {
            const allProjects = await prisma.project.findMany({ select: { id: true } });
            if (allProjects.length > 0) {
                await prisma.projectAccess.createMany({
                    data: allProjects.map(p => ({ userId: newUser.id, projectId: p.id })),
                    skipDuplicates: true,
                });
            }
        }

        // Send invite email
        const appUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
        const loginUrl = `${appUrl}/login`;

        if (process.env.RESEND_API_KEY) {
            try {
                await resend.emails.send({
                    from: "ProBuild <notifications@goldentouchremodeling.com>",
                    to: exactEmailLower,
                    subject: "Invitation to ProBuild Team",
                    html: `
                    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; margin: 0; color: #0f172a; }
                        .container { padding: 40px 20px; max-width: 600px; margin: 0 auto; }
                        .card { background: #fff; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 4px 6px -1px rgba(0,0,0,.1); border: 1px solid #e2e8f0; }
                        h1 { font-size: 24px; font-weight: 700; margin: 0 0 16px; }
                        p { font-size: 16px; line-height: 1.6; margin: 0 0 32px; color: #475569; }
                        .button { display: inline-block; background: #2563eb; color: #fff !important; font-weight: 600; font-size: 16px; text-decoration: none; padding: 14px 28px; border-radius: 8px; }
                    </style></head><body><div class="container"><div class="card">
                        <h1>Welcome to ProBuild</h1>
                        <p>Hello${name ? " " + name : ""},<br><br>You've been invited as a <strong>${role || "Field Crew"}</strong> member. Sign in with your Google account to get started.</p>
                        <a href="${loginUrl}" class="button">Access ProBuild</a>
                    </div></div></body></html>`,
                });
            } catch (e: any) {
                console.error("Email error:", e);
            }
        }

        // NEVER the raw row: `newUser` is a full findUniqueOrThrow, so this
        // answered 201 with the freshly-hashed pinCode (round 8, finding 1).
        return NextResponse.json(toSafeUser(newUser), { status: 201 });
    } catch (error: any) {
        console.error("POST /api/users error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// PATCH: update a user's role, status, or basic info
export async function PATCH(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const currentUser = await prisma.user.findUnique({
            where: { email: session.user.email },
            include: { permissions: true },
        });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const body = await req.json();
        const { id, name, role, status, hourlyRate, burdenRate, pinCode } = body;

        if (!id) return NextResponse.json({ error: "User id required" }, { status: 400 });

        const data: any = {};
        if (name !== undefined) data.name = name;
        if (role !== undefined) data.role = role;
        if (status !== undefined) data.status = status;
        if (pinCode !== undefined) data.pinCode = pinCode ? await bcrypt.hash(pinCode, 10) : null;

        // ONE rate payload, handed BOTH to the guard (which uses it to decide
        // that the payroll advisory lock must be taken before the target row
        // lock) and to the rate writer itself. Two copies would be two answers
        // to "does this request write rates", which is exactly how the lock
        // order came to be inverted for a rate-only edit (round 13, finding 1).
        const rateChange = { hourlyRate, burdenRate, payType: body.payType };

        // Rates through the one validated path, in the same transaction as the
        // rest of the patch — this route used to write them as raw JS numbers
        // with no permission check and no lastRateSyncAt stamp.
        //
        // The authority check used to run against a role read taken BEFORE
        // this transaction opened - an admin promotion committing in that gap
        // let a manager's already-in-flight request act on the now-admin
        // account (round 12, finding 2). withGuardedUserMutation re-reads the
        // target under FOR UPDATE and re-runs checkUserMutation against THAT
        // row before the write below is allowed to run.
        let user;
        try {
            const updated = await prisma.$transaction(async (tx) => {
                return withGuardedUserMutation(
                    tx,
                    {
                        actorId: currentUser.id,
                        targetId: id,
                        changes: { role, status },
                        data,
                        rateChange,
                    },
                    async (_target, actor) => {
                        // The LOCKED actor, not the pre-transaction read:
                        // canWriteRates asks for financialReports, and a revocation
                        // that committed a moment ago used to be invisible here
                        // (round 14, finding 3).
                        const rateResult = await applyRateChangeInTx(tx, actor, id, rateChange);
                        if (!rateResult.ok) throw new RateChangeError(rateResult.status, rateResult.error);
                        // status and name are EXPORT INPUTS — activating somebody
                        // adds them to the Gusto roster, and their name is printed in
                        // both CSVs. withPayrollUserWrite takes the shared payroll
                        // advisory lock first, so this cannot land between a period
                        // lock's roster read and its COMMIT (see payroll-period.ts).
                        return withPayrollUserWrite(tx, data, () =>
                            tx.user.update({
                                where: { id },
                                data,
                                include: { permissions: true, projectAccess: { select: { projectId: true } } },
                            })
                        );
                    }
                );
            });
            // The RAW row. toSafeUser below is the one place the hash is
            // dropped (#459) — stripping it here as well would leave that
            // helper reporting hasPin:false for a user who has one.
            user = updated as Record<string, unknown>;
        } catch (error) {
            if (error instanceof RateChangeError) {
                return NextResponse.json({ error: error.message }, { status: error.status });
            }
            // An actor demoted, disabled or de-permissioned mid-flight is
            // refused the same way a bad target is — the verdict carries the
            // status (round 14, finding 3).
            if (isUserMutationRefusedError(error) || isUserMutationActorInvalidError(error)) {
                return NextResponse.json({ error: error.verdict.error }, { status: error.verdict.status });
            }
            if (isUserMutationTargetNotFoundError(error)) {
                return NextResponse.json({ error: "User not found" }, { status: 404 });
            }
            throw error;
        }

        // A user who just became ACTIVATED FIELD_CREW (or is CJ) joins every
        // "In Progress" project. Fail-soft inside the helper; never blocks the save.
        const { autoAssignProjectsOnUserChange } = await import("@/lib/crew-auto-assign-sync");
        after(() => autoAssignProjectsOnUserChange(id, { role, status }));

        return NextResponse.json(toSafeUser(user));
    } catch (error: any) {
        console.error("PATCH /api/users error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
