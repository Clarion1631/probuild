import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

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

        return NextResponse.json({ user, allProjects });
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

        const currentUser = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const { id } = await params;
        const body = await req.json();
        const { permissions, projectIds, userInfo, pinCode } = body;

        // Update user info if provided
        if (userInfo || pinCode !== undefined) {
            const data: any = {};
            if (userInfo) {
                if (userInfo.name !== undefined) data.name = userInfo.name;
                if (userInfo.role !== undefined) data.role = userInfo.role;
                if (userInfo.status !== undefined) data.status = userInfo.status;
                if (userInfo.hourlyRate !== undefined) data.hourlyRate = Number(userInfo.hourlyRate);
                if (userInfo.burdenRate !== undefined) data.burdenRate = Number(userInfo.burdenRate);
            }
            if (pinCode !== undefined) data.pinCode = pinCode ? await bcrypt.hash(pinCode, 10) : null;
            if (Object.keys(data).length > 0) {
                await prisma.user.update({ where: { id }, data });
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
            // Sync ProjectAccess records
            await prisma.projectAccess.deleteMany({ where: { userId: id } });
            if (projectIds.length > 0) {
                await prisma.projectAccess.createMany({
                    data: projectIds.map((pid: string) => ({ userId: id, projectId: pid })),
                    skipDuplicates: true,
                });
            }
            // Sync crew assignments (many-to-many) so Time Clock sees the same projects
            await prisma.user.update({
                where: { id },
                data: {
                    assignedProjects: {
                        set: projectIds.map((pid: string) => ({ id: pid })),
                    },
                },
            });
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

        return NextResponse.json(user);
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

        await prisma.user.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("DELETE /api/users/[id] error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
