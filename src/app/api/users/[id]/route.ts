import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { applyRateChangeInTx, RateChangeError } from "@/lib/pay-rate-write";
import { deleteParentWithTimeEntries, isTimeEntriesExistError } from "@/lib/payroll-parent-delete";
import { isPeriodLockedError, periodLockedResponse, withPayrollUserWrite } from "@/lib/payroll-period";
import { toSafeUser } from "@/lib/user-serialization";

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

        // Profile fields and rates commit TOGETHER, in one transaction. They
        // were two sequential writes: a rate refusal left the profile half
        // already saved, so a manager without payroll access could rename
        // somebody and get a 403 that made it look like nothing happened.
        if (userInfo || pinCode !== undefined) {
            const data: any = {};
            if (userInfo) {
                if (userInfo.name !== undefined) data.name = userInfo.name;
                if (userInfo.role !== undefined) data.role = userInfo.role;
                if (userInfo.status !== undefined) data.status = userInfo.status;
                // Rates are NOT written here — applyRateChange below owns them
                // (payroll permission, exact decimal, lastRateSyncAt stamp).
                // FINANCE accounts must never be offered as dispatch-board crew —
                // guard server-side even though the Team page hides the toggle.
                if (userInfo.showOnDispatch !== undefined) {
                    const targetRole = userInfo.role !== undefined ? userInfo.role : (await prisma.user.findUnique({ where: { id }, select: { role: true } }))?.role;
                    data.showOnDispatch = targetRole === "FINANCE" ? false : Boolean(userInfo.showOnDispatch);
                }
            }
            if (pinCode !== undefined) data.pinCode = pinCode ? await bcrypt.hash(pinCode, 10) : null;

            try {
                await prisma.$transaction(async (tx) => {
                    if (userInfo) {
                        const rateResult = await applyRateChangeInTx(
                            tx,
                            currentUser,
                            id,
                            {
                                hourlyRate: userInfo.hourlyRate,
                                burdenRate: userInfo.burdenRate,
                                payType: userInfo.payType,
                            }
                        );
                        if (!rateResult.ok) throw new RateChangeError(rateResult.status, rateResult.error);
                    }
                    if (Object.keys(data).length > 0) {
                        // `data` can carry status and name, both EXPORT INPUTS:
                        // activating somebody ADDS a row to the Gusto roster,
                        // and their name is printed in both CSVs. The payroll
                        // advisory lock (tier 1, taken inside withPayrollUserWrite
                        // before the row is touched) is what makes this write
                        // wait for a period being locked instead of committing
                        // between that lock's roster read and its COMMIT.
                        await withPayrollUserWrite(tx, data, () => tx.user.update({ where: { id }, data }));
                    }
                });
            } catch (error) {
                if (error instanceof RateChangeError) {
                    return NextResponse.json({ error: error.message }, { status: error.status });
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

        // Update permissions if provided (allowlisted fields only)
        if (permissions) {
            const ALLOWED_PERMISSION_FIELDS = [
                "manageTeamMembers", "manageSubs", "manageVendors", "companySettings",
                "costCodesCategories", "schedules", "estimates", "invoices", "contracts",
                "roomDesigner", "changeOrders", "financialReports", "timeClock",
                "dailyLogs", "files", "takeoffs", "autoGrantNewProjects",
            ] as const;
            const sanitized: Record<string, boolean> = {};
            for (const key of ALLOWED_PERMISSION_FIELDS) {
                if (key in permissions && typeof permissions[key] === "boolean") {
                    sanitized[key] = permissions[key];
                }
            }
            if (Object.keys(sanitized).length > 0) {
                await prisma.userPermission.upsert({
                    where: { userId: id },
                    create: { userId: id, ...sanitized },
                    update: sanitized,
                });
            }
        }

        // Update project access AND crew assignments if provided
        if (projectIds !== undefined) {
            const newIdSet = new Set(projectIds as string[]);

            // Read current state to compute diffs
            const currentUser = await prisma.user.findUnique({
                where: { id },
                select: {
                    projectAccess: { select: { projectId: true } },
                    assignedProjects: { select: { id: true } },
                },
            });
            const oldAccessIds = new Set(currentUser?.projectAccess.map(pa => pa.projectId) || []);
            const oldCrewIds = new Set(currentUser?.assignedProjects.map(p => p.id) || []);

            // Compute crew diffs: only connect/disconnect what changed via Team Access
            const toConnect = projectIds.filter((pid: string) => !oldCrewIds.has(pid));
            const toDisconnect = [...oldAccessIds].filter(pid => !newIdSet.has(pid) && oldCrewIds.has(pid));

            await prisma.$transaction([
                prisma.projectAccess.deleteMany({ where: { userId: id } }),
                ...(projectIds.length > 0
                    ? [prisma.projectAccess.createMany({
                        data: projectIds.map((pid: string) => ({ userId: id, projectId: pid })),
                        skipDuplicates: true,
                    })]
                    : []),
                ...(toConnect.length > 0 || toDisconnect.length > 0
                    ? [prisma.user.update({
                        where: { id },
                        data: {
                            assignedProjects: {
                                connect: toConnect.map((pid: string) => ({ id: pid })),
                                disconnect: toDisconnect.map(pid => ({ id: pid })),
                            },
                        },
                    })]
                    : []),
            ]);
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

        // Can't delete yourself
        if (id === currentUser.id) {
            return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
        }

        // Only ADMIN can delete other ADMIN accounts
        const targetUser = await prisma.user.findUnique({ where: { id }, select: { role: true } });
        if (!targetUser) {
            return NextResponse.json({ error: "User not found" }, { status: 404 });
        }
        if (targetUser.role === "ADMIN" && currentUser.role !== "ADMIN") {
            return NextResponse.json({ error: "Only admins can delete admin accounts" }, { status: 403 });
        }

        // A user with ANY time entries — locked or not — is refused outright,
        // checked under the payroll lock. The foreign key used to CASCADE, so
        // this endpoint quietly destroyed a former employee's whole payroll
        // history; a lock-only check would still do that for every entry that
        // predates PayrollPeriod, which is most of production's paid history.
        await deleteParentWithTimeEntries({ userId: id }, async (tx) => {
            await (tx as unknown as typeof prisma).user.delete({ where: { id } });
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
        console.error("DELETE /api/users/[id] error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
