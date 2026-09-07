import { NextResponse } from "next/server";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { prisma } from "@/lib/prisma";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { isPeriodLockedError, periodLockedResponse } from "@/lib/payroll-period";
import { voidTimeEntry } from "@/lib/time-entry-void-db";
import { TimeEntryVoidError, validateVoidRequest } from "@/lib/time-entry-void";
import { serializeTimeEntryJson } from "@/lib/time-entry-projection";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    try {
        const body = validateVoidRequest(auth.user.role, await req.json());
        const { id } = await params;
        const row = await voidTimeEntry(prisma, { id, actorId: auth.user.id, ...body, timeZone: await resolveCompanyTimeZone() });
        return NextResponse.json(serializeTimeEntryJson(row as never, false));
    } catch (error) {
        if (error instanceof TimeEntryVoidError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
        if (isPeriodLockedError(error)) return periodLockedResponse(error.period);
        if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
        throw error;
    }
}
