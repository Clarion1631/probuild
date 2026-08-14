import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildPhaseOptions, type PhaseOption } from "@/lib/phase-options";

export const dynamic = "force-dynamic";

export type { PhaseOption };

type AuthedUser = { id: string; role: string };
type AuthResult = { ok: true; user: AuthedUser } | { ok: false; status: number; error: string };

export interface PhasesDependencies {
    authenticate(req: Request): Promise<AuthResult>;
    canAccessProject(user: AuthedUser, projectId: string): Promise<boolean>;
    getProject(projectId: string): Promise<{ id: string; status: string } | null>;
    getPhases(projectId: string): Promise<PhaseOption[]>;
}

export function createPhasesHandlers(dependencies: PhasesDependencies) {
    return {
        async GET(req: Request, projectId: string) {
            const auth = await dependencies.authenticate(req);
            if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
            const { user } = auth;

            const canAccess = await dependencies.canAccessProject(user, projectId);
            if (!canAccess) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

            const project = await dependencies.getProject(projectId);
            if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

            if (project.status !== "In Progress") {
                return NextResponse.json(
                    { error: "Project is not In Progress", code: "PROJECT_NOT_IN_PROGRESS" },
                    { status: 409 }
                );
            }

            const phases = await dependencies.getPhases(projectId);
            return NextResponse.json({ phases });
        },
    };
}

const handlers = createPhasesHandlers({
    // Dynamic import: mobile-auth.ts throws at MODULE LOAD if NEXTAUTH_SECRET
    // isn't set (fail-fast for real deployments) — see
    // src/app/api/mobile/pay-period-summary/route.ts for the same pattern.
    authenticate: async (req) => {
        const { authenticateMobileOrSession } = await import("@/lib/mobile-auth");
        const result = await authenticateMobileOrSession(req);
        if (!result.ok) return result;
        return { ok: true, user: { id: result.user.id, role: result.user.role } };
    },
    canAccessProject: async (user, projectId) => {
        const { userCanAccessProject } = await import("@/lib/mobile-auth");
        return userCanAccessProject(user, projectId);
    },
    getProject: async (projectId) => {
        return prisma.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } });
    },
    getPhases: async (projectId) => {
        // Status/archived/project filtering pushed into the query (rather than
        // fetching every cost-coded item on the project and filtering in JS) —
        // only items on Approved, non-archived estimates for this project, with
        // an active cost code, come back at all. The remaining approved-only
        // representative-item selection (and picking ONE canonical estimate
        // when several are Approved) is the pure buildPhaseOptions() reduction
        // (unit-tested directly).
        const items = await prisma.estimateItem.findMany({
            where: {
                costCodeId: { not: null },
                costCode: { isActive: true },
                estimate: { projectId, status: "Approved", archivedAt: null },
            },
            select: {
                id: true,
                order: true,
                costCodeId: true,
                costCode: { select: { code: true, name: true, isActive: true } },
                estimate: { select: { id: true, status: true, archivedAt: true, approvedAt: true, createdAt: true } },
            },
        });

        return buildPhaseOptions(
            items
                .filter((item) => item.costCodeId && item.costCode)
                .map((item) => ({
                    estimateItemId: item.id,
                    order: item.order,
                    costCodeId: item.costCodeId,
                    costCodeActive: item.costCode!.isActive,
                    costCodeCode: item.costCode!.code,
                    costCodeName: item.costCode!.name,
                    estimateStatus: item.estimate.status,
                    estimateArchived: item.estimate.archivedAt != null,
                    estimateId: item.estimate.id,
                    estimateRecencyKey: (item.estimate.approvedAt ?? item.estimate.createdAt).toISOString(),
                }))
        );
    },
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlers.GET(req, id);
}
