import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export interface CrewMember {
    id: string;
    name: string | null;
    email: string;
    role: string;
}

type AuthedUser = { id: string; role: string; name: string | null; email: string };
type AuthResult = { ok: true; user: AuthedUser } | { ok: false; status: number; error: string };

export interface CrewRouteDependencies {
    authenticate(req: Request): Promise<AuthResult>;
    getProject(projectId: string): Promise<{ id: string } | null>;
    getCurrentCrew(projectId: string): Promise<CrewMember[]>;
    /** Returns only the subset of the given ids that are actually assignable (ACTIVATED FIELD_CREW users). */
    getAssignableUsers(userIds: string[]): Promise<CrewMember[]>;
    applyCrew(input: { projectId: string; userIds: string[]; actorName: string }): Promise<CrewMember[]>;
}

function requireManager(user: AuthedUser): NextResponse | null {
    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
}

export function createCrewRouteHandlers(dependencies: CrewRouteDependencies) {
    return {
        async GET(req: Request, projectId: string) {
            const auth = await dependencies.authenticate(req);
            if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
            const forbidden = requireManager(auth.user);
            if (forbidden) return forbidden;

            const project = await dependencies.getProject(projectId);
            if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

            const crew = await dependencies.getCurrentCrew(projectId);
            return NextResponse.json({ crew });
        },

        async POST(req: Request, projectId: string) {
            const auth = await dependencies.authenticate(req);
            if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
            const forbidden = requireManager(auth.user);
            if (forbidden) return forbidden;

            let body: unknown;
            try {
                body = await req.json();
            } catch {
                return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
            }

            const crewUserIds = (body as { crewUserIds?: unknown } | null)?.crewUserIds;
            if (!Array.isArray(crewUserIds) || crewUserIds.some((id) => typeof id !== "string")) {
                return NextResponse.json({ error: "crewUserIds must be an array of user ids" }, { status: 400 });
            }
            const wanted = [...new Set(crewUserIds as string[])];

            const project = await dependencies.getProject(projectId);
            if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

            if (wanted.length > 0) {
                const assignable = await dependencies.getAssignableUsers(wanted);
                const assignableIds = new Set(assignable.map((u) => u.id));
                const invalid = wanted.filter((id) => !assignableIds.has(id));
                if (invalid.length > 0) {
                    return NextResponse.json(
                        { error: `Not assignable as crew (must be an activated field crew user): ${invalid.join(", ")}` },
                        { status: 400 }
                    );
                }
            }

            try {
                const crew = await dependencies.applyCrew({
                    projectId,
                    userIds: wanted,
                    actorName: auth.user.name || auth.user.email,
                });
                return NextResponse.json({ crew });
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : "Failed to update crew";
                return NextResponse.json({ error: msg }, { status: 400 });
            }
        },
    };
}

const handlers = createCrewRouteHandlers({
    // Dynamic import: mobile-auth.ts throws at MODULE LOAD if NEXTAUTH_SECRET
    // isn't set (fail-fast for real deployments) — see
    // src/app/api/mobile/pay-period-summary/route.ts for the same pattern.
    authenticate: async (req) => {
        const { authenticateMobileOrSession } = await import("@/lib/mobile-auth");
        const result = await authenticateMobileOrSession(req);
        if (!result.ok) return result;
        return {
            ok: true,
            user: { id: result.user.id, role: result.user.role, name: result.user.name, email: result.user.email },
        };
    },
    getProject: async (projectId) => {
        return prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    },
    getCurrentCrew: async (projectId) => {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { crew: { select: { id: true, name: true, email: true, role: true } } },
        });
        return project?.crew ?? [];
    },
    getAssignableUsers: async (userIds) => {
        return prisma.user.findMany({
            where: { id: { in: userIds }, status: "ACTIVATED", role: "FIELD_CREW" },
            select: { id: true, name: true, email: true, role: true },
        });
    },
    applyCrew: async ({ projectId, userIds, actorName }) => {
        const { setProjectCrew } = await import("@/lib/schedule-core");
        const result = await setProjectCrew({
            projectId,
            userIds,
            actor: { type: "TEAM", name: actorName },
        });
        // setProjectCrew only returns {id, name} — re-fetch with email/role so
        // the response shape matches GET's.
        const crew = await prisma.user.findMany({
            where: { id: { in: result.crew.map((c) => c.id) } },
            select: { id: true, name: true, email: true, role: true },
        });
        return crew;
    },
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlers.GET(req, id);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return handlers.POST(req, id);
}
