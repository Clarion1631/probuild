import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { applyRateChangeInTx, RateChangeError } from "@/lib/pay-rate-write";
import { deleteParentWithTimeEntries, isTimeEntriesExistError } from "@/lib/payroll-parent-delete";
import {
    isPeriodLockedError,
    periodLockedResponse,
    touchesPayrollRateState,
    withPayrollUserWrite,
} from "@/lib/payroll-period";
import { toSafeUser } from "@/lib/user-safe";
import {
    ASSIGNABLE_PERMISSIONS,
    isUserMutationActorInvalidError,
    isUserMutationRefusedError,
    isUserMutationTargetNotFoundError,
    withGuardedUserMutation,
} from "@/lib/user-mutation-guard";

// GET: get user details with permissions and project access
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const currentUser = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const { id } = await params;
        const user = await prisma.user.findUnique({
            where: { id },
            include: {
                permissions: true,
                projectAccess: {
                    include: { project: { select: { id: true, name: true, client: { select: { name: true } }, createdAt: true } } }
                },
                assignedProjects: {
                    select: { id: true },
                },
            },
        });

        if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

        // Get all projects for the access toggle list
        const allProjects = await prisma.project.findMany({
            select: { id: true, name: true, client: { select: { name: true } }, createdAt: true },
            orderBy: { createdAt: "desc" },
        });

        // The include above is a full row — pinCode and all (round 8, finding 1).
        return NextResponse.json({ user: toSafeUser(user), allProjects });
    } catch (error: any) {
        console.error("GET /api/users/[id] error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// PUT: update permissions and project access
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // `permissions` is loaded because applyRateChange below asks whether
        // this user has financialReports, not just whether they are a manager.
        const currentUser = await prisma.user.findUnique({
            where: { email: session.user.email },
            include: { permissions: true },
        });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const { id } = await params;
        const body = await req.json();
        const { permissions, projectIds, userInfo, pinCode } = body;

        // A cheap existence check, decoupled from authority: an unknown id is a
        // 404 regardless of who is asking, so this is safe to answer before the
        // guarded transaction below — it proves nothing about the ROLE the
        // request is authorized against, only that the row is there at all.
        const targetExists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
        if (!targetExists) return NextResponse.json({ error: "User not found" }, { status: 404 });

        // The permission patch is narrowed to its boolean entries BEFORE the
        // check, so an unknown key is a 400 from the guard rather than a silent
        // drop by the writer below.
        const requestedPermissions: Record<string, unknown> | null = permissions
            ? Object.fromEntries(
                  Object.entries(permissions).filter(([, value]) => typeof value === "boolean")
              )
            : null;
        const sanitizedPermissions: Record<string, boolean> = {};
        if (requestedPermissions) {
            for (const key of ASSIGNABLE_PERMISSIONS) {
                if (key in requestedPermissions && typeof requestedPermissions[key] === "boolean") {
                    sanitizedPermissions[key] = requestedPermissions[key] as boolean;
                }
            }
        }

        // Profile fields, rates and permissions commit TOGETHER, in ONE
        // guarded transaction. They used to be sequential writes authorized
        // against a role read taken BEFORE any of them opened: an admin
        // promotion committing in that gap let a manager's already-in-flight
        // request act on the now-admin account, because the row it wrote was
        // not the row it was authorized against (round 12, finding 2).
        // withGuardedUserMutation re-reads the target under FOR UPDATE and
        // re-runs the authority check against THAT row before any write below
        // is allowed to run.
        const data: any = {};
        if (userInfo) {
            if (userInfo.name !== undefined) data.name = userInfo.name;
            if (userInfo.role !== undefined) data.role = userInfo.role;
            if (userInfo.status !== undefined) data.status = userInfo.status;
        }
        if (pinCode !== undefined) data.pinCode = pinCode ? await bcrypt.hash(pinCode, 10) : null;

        // ONE rate payload, built here and used TWICE: to decide whether this
        // request runs at all, and to decide (inside the guard) that the
        // payroll advisory lock has to be taken before the target row. Building
        // a second copy at either site would be a second answer to "does this
        // request write rates".
        const rateChange = userInfo
            ? {
                  hourlyRate: userInfo.hourlyRate,
                  burdenRate: userInfo.burdenRate,
                  payType: userInfo.payType,
              }
            : undefined;

        // A RATE-ONLY body used to fall straight through this condition: `data`
        // is empty for it and there are no permissions, so the transaction never
        // opened and the route answered 200 with the values unchanged — the save
        // silently did nothing (round 13, finding 2). The same predicate the
        // rate writer itself uses now decides it.
        //
        // `projectIds` is in the list for the same reason, one round later: a
        // PROJECT-ONLY body skipped the guarded transaction entirely and wrote
        // project access with no authority check of any kind (round 16,
        // finding 4). Deciding which jobs somebody can see is a permission
        // change; it belongs behind the same locks as every other one.
        if (
            Object.keys(data).length > 0 ||
            Object.keys(sanitizedPermissions).length > 0 ||
            touchesPayrollRateState(rateChange) ||
            projectIds !== undefined ||
            // `showOnDispatch` is written INSIDE the guarded closure (it is
            // derived from the locked target role, because FINANCE may never be
            // offered as dispatch crew). A body carrying only that field
            // therefore never opened the transaction and answered 200 having
            // changed nothing (round 17, P2) — the same silent no-op as the
            // rate-only body in round 13.
            userInfo?.showOnDispatch !== undefined
        ) {
            try {
                await prisma.$transaction(async (tx) => {
                    await withGuardedUserMutation(
                        tx,
                        {
                            actorId: currentUser.id,
                            targetId: id,
                            changes: {
                                role: userInfo?.role,
                                status: userInfo?.status,
                                permissions: requestedPermissions,
                            },
                            data,
                            rateChange,
                        },
                        async (target, actor) => {
                            if (rateChange) {
                                // The LOCKED actor, not the pre-transaction read:
                                // canWriteRates asks for financialReports, and a
                                // revocation that committed a moment ago used to be
                                // invisible here (round 14, finding 3).
                                const rateResult = await applyRateChangeInTx(tx, actor, id, rateChange);
                                if (!rateResult.ok) throw new RateChangeError(rateResult.status, rateResult.error);
                                // Rates are NOT written here — applyRateChange
                                // above owns them (payroll permission, exact
                                // decimal, lastRateSyncAt stamp). FINANCE
                                // accounts must never be offered as
                                // dispatch-board crew — guard server-side even
                                // though the Team page hides the toggle. `target`
                                // is the row THIS transaction just locked, so
                                // this no longer needs its own separate query.
                                if (userInfo.showOnDispatch !== undefined) {
                                    const targetRole = userInfo.role !== undefined ? userInfo.role : target.role;
                                    data.showOnDispatch = targetRole === "FINANCE" ? false : Boolean(userInfo.showOnDispatch);
                                }
                            }
                            if (Object.keys(data).length > 0) {
                                // `data` can carry status and name, both EXPORT
                                // INPUTS: activating somebody ADDS a row to the
                                // Gusto roster, and their name is printed in both
                                // CSVs. The payroll advisory lock (tier 1, taken
                                // inside withPayrollUserWrite before the row is
                                // touched) is what makes this write wait for a
                                // period being locked instead of committing
                                // between that lock's roster read and its COMMIT.
                                await withPayrollUserWrite(tx, data, () => tx.user.update({ where: { id }, data }));
                            }
                            // Permissions commit in the SAME transaction as the
                            // authority check now — they used to be a separate
                            // write after the guarded transaction had already
                            // committed, which is exactly the gap this fix closes.
                            if (Object.keys(sanitizedPermissions).length > 0) {
                                await tx.userPermission.upsert({
                                    where: { userId: id },
                                    create: { userId: id, ...sanitizedPermissions },
                                    update: sanitizedPermissions,
                                });
                            }
                            // PROJECT ACCESS, in the SAME transaction as the
                            // authority check.
                            //
                            // It used to run in its own `prisma.$transaction`
                            // AFTER this one had committed, and a project-only
                            // body never opened this one at all — so which jobs a
                            // person can see was writable by an actor who had
                            // been demoted, disabled or reset to PENDING, and on
                            // a target who had become an ADMIN, in the gap
                            // (round 16, finding 4). `target` is the row this
                            // transaction locked FOR UPDATE.
                            if (projectIds !== undefined) {
                                const newIdSet = new Set(projectIds as string[]);
                                // Read the current state INSIDE the transaction,
                                // under the target lock — the diff below decides
                                // what to disconnect, so reading it outside meant
                                // diffing against a row somebody else could have
                                // moved.
                                const current = await tx.user.findUnique({
                                    where: { id },
                                    select: {
                                        projectAccess: { select: { projectId: true } },
                                        assignedProjects: { select: { id: true } },
                                    },
                                });
                                const oldAccessIds = new Set(current?.projectAccess.map((pa) => pa.projectId) || []);
                                const oldCrewIds = new Set(current?.assignedProjects.map((project) => project.id) || []);

                                // Only connect/disconnect what changed via Team
                                // Access — an untouched crew assignment stays.
                                const toConnect = (projectIds as string[]).filter((pid) => !oldCrewIds.has(pid));
                                const toDisconnect = [...oldAccessIds].filter(
                                    (pid) => !newIdSet.has(pid) && oldCrewIds.has(pid)
                                );

                                await tx.projectAccess.deleteMany({ where: { userId: id } });
                                if ((projectIds as string[]).length > 0) {
                                    await tx.projectAccess.createMany({
                                        data: (projectIds as string[]).map((pid) => ({ userId: id, projectId: pid })),
                                        skipDuplicates: true,
                                    });
                                }
                                if (toConnect.length > 0 || toDisconnect.length > 0) {
                                    await tx.user.update({
                                        where: { id },
                                        data: {
                                            assignedProjects: {
                                                connect: toConnect.map((pid) => ({ id: pid })),
                                                disconnect: toDisconnect.map((pid) => ({ id: pid })),
                                            },
                                        },
                                    });
                                }
                            }
                        }
                    );
                });
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

            if (Object.keys(data).length > 0) {
                // Newly ACTIVATED FIELD_CREW (or CJ) joins every "In Progress"
                // project. Fail-soft inside the helper; never blocks the save.
                // Runs only once the transaction has COMMITTED.
                const { autoAssignProjectsOnUserChange } = await import("@/lib/crew-auto-assign-sync");
                after(() => autoAssignProjectsOnUserChange(id, { role: data.role, status: data.status }));
            }
        }

        // Fetch updated user
        const user = await prisma.user.findUnique({
            where: { id },
            include: {
                permissions: true,
                projectAccess: {
                    include: { project: { select: { id: true, name: true, client: { select: { name: true } }, createdAt: true } } }
                },
                assignedProjects: {
                    select: { id: true },
                },
            },
        });

        return NextResponse.json(user ? toSafeUser(user) : null);
    } catch (error: any) {
        console.error("PUT /api/users/[id] error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// DELETE: remove a user
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const currentUser = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const { id } = await params;

        // Can't delete yourself. A pure comparison against the actor's own
        // session identity — nothing about the TARGET's role, so there is no
        // race to close here.
        if (id === currentUser.id) {
            return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
        }

        // A cheap existence check, decoupled from authority — see the same
        // check in PUT above for why this is safe outside the guarded
        // transaction: it proves the row is there, not what it is allowed.
        const targetExists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
        if (!targetExists) return NextResponse.json({ error: "User not found" }, { status: 404 });

        // A user with ANY time entries — locked or not — is refused outright,
        // checked under the payroll lock. The foreign key used to CASCADE, so
        // this endpoint quietly destroyed a former employee's whole payroll
        // history; a lock-only check would still do that for every entry that
        // predates PayrollPeriod, which is most of production's paid history.
        //
        // "Only ADMIN may delete an ADMIN" used to be authorized against a role
        // read taken BEFORE this whole call — an admin promotion committing in
        // that gap let a manager delete the now-admin account (round 12,
        // finding 2). withGuardedUserMutation re-reads the target under FOR
        // UPDATE, inside the SAME transaction deleteParentWithTimeEntries
        // already opens, and refuses before the row is ever touched if the
        // LOCKED role says a manager may not act on it.
        await deleteParentWithTimeEntries({ userId: id }, async (tx) => {
            await withGuardedUserMutation(
                tx,
                {
                    actorId: currentUser.id,
                    targetId: id,
                    changes: {},
                },
                async () => {
                    await (tx as unknown as typeof prisma).user.delete({ where: { id } });
                }
            );
        });
        return NextResponse.json({ success: true });
    } catch (error: any) {
        // Hours inside a locked period are never deleted. 423, not 500: the
        // request is well-formed and the caller is allowed — the data is frozen.
        if (isPeriodLockedError(error)) return periodLockedResponse(error.period);
        // Same shape, different reason: this user has time entries at all, so
        // deleting them would destroy payroll history. 409, not 500 — the
        // request is well-formed and refused, not broken.
        if (isTimeEntriesExistError(error)) {
            return NextResponse.json({ error: error.message }, { status: 409 });
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
        console.error("DELETE /api/users/[id] error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
