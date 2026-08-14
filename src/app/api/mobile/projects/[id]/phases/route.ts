import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildPhaseOptions, selectCanonicalEstimateId, type PhaseOption } from "@/lib/phase-options";

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
        // Canonical-estimate selection runs FIRST, against every Approved,
        // non-archived estimate for the project — independent of whether any
        // of its items currently have an active cost code. Filtering items
        // down to active cost codes before picking the canonical estimate
        // was the bug: a newer approved estimate whose items had no active
        // cost codes (yet, or at all) was invisible to selection, so an
        // older estimate's stale items leaked through. See
        // selectCanonicalEstimateId / buildPhaseOptions in phase-options.ts
        // for the two-step pure logic (unit-tested directly).
        const estimates = await prisma.estimate.findMany({
            where: { projectId, status: "Approved", archivedAt: null },
            select: { id: true, approvedAt: true, createdAt: true },
        });

        const canonicalEstimateId = selectCanonicalEstimateId(
            estimates.map((estimate) => ({
                estimateId: estimate.id,
                recencyKey: (estimate.approvedAt ?? estimate.createdAt).toISOString(),
            }))
        );
        if (!canonicalEstimateId) return [];

        // Only NOW filter to active cost-coded items — scoped to just the
        // canonical estimate. An empty result here is a legitimate empty
        // phase list, not a signal to fall back to another estimate.
        const items = await prisma.estimateItem.findMany({
            where: {
                estimateId: canonicalEstimateId,
                costCodeId: { not: null },
                costCode: { isActive: true },
            },
            select: {
                id: true,
                order: true,
                costCodeId: true,
                costCode: { select: { code: true, name: true, isActive: true } },
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
                }))
        );
    },
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlers.GET(req, id);
}
