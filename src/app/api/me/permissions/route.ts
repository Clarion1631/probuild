import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET: return current user's permissions for client-side gating
export async function GET() {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            include: {
                permissions: true,
                projectAccess: true,
            },
        });

        if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

        const isAdmin = user.role === "ADMIN" || user.role === "MANAGER";

        // Build a flat permissions object for the client
        const perms: any = user.permissions || {};
        const effectivePermissions: Record<string, boolean> = {
            // Administrative
            manageTeamMembers: isAdmin || !!perms.manageTeamMembers,
            manageSubs: isAdmin || !!perms.manageSubs,
            manageVendors: isAdmin || !!perms.manageVendors,
            companySettings: isAdmin || !!perms.companySettings,
            costCodesCategories: isAdmin || !!perms.costCodesCategories,
            // Project screens
            schedules: isAdmin || !!perms.schedules,
            estimates: isAdmin || !!perms.estimates,
            invoices: isAdmin || !!perms.invoices,
            contracts: isAdmin || !!perms.contracts,
            floorPlans: isAdmin || !!perms.floorPlans,
            changeOrders: isAdmin || !!perms.changeOrders,
            financialReports: isAdmin || !!perms.financialReports,
            timeClock: isAdmin || !!perms.timeClock,
            dailyLogs: isAdmin || !!perms.dailyLogs,
            files: isAdmin || !!perms.files,
            takeoffs: isAdmin || !!perms.takeoffs,
            // Leads
            createLead: isAdmin || !!perms.createLead,
            clientCommunication: isAdmin || !!perms.clientCommunication,
            leadAccess: isAdmin || !!perms.leadAccess,
        };

        return NextResponse.json({
            role: user.role,
            isAdmin,
            permissions: effectivePermissions,
            projectIds: (user.projectAccess || []).map((pa: any) => pa.projectId),
        });
    } catch (error: any) {
        console.error("GET /api/me/permissions error:", error);
        return NextResponse.json({ error: "Internal server error", details: error.message }, { status: 500 });
    }
}
