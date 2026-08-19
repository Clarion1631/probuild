export const dynamic = 'force-dynamic';
import { NextResponse } from "next/server";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";
import { resolveProjectPhaseCodes } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";

// The crew's clock-in phase list: the distinct cost codes used by this
// project's ELIGIBLE estimates (Approved/Invoiced/Partially Paid/Paid, not
// archived), plus the Safety Meeting phase on an In Progress project.
//
// The rules live in src/lib/project-phases.ts and are shared verbatim with the
// clock-in validation in src/app/api/time-entries/route.ts — what this returns
// is exactly what that route accepts, by construction.
//
// Response shape is unchanged (a bare array of cost codes), so older clients
// that read `[{id, code, name, ...}]` keep working.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const projectId = (await params).id;
    const fail = await assertProjectAccess(auth.user, projectId);
    if (fail) return fail;

    const costCodes = await resolveProjectPhaseCodes(prismaPhaseDataSource, projectId);

    return NextResponse.json(costCodes);
}
