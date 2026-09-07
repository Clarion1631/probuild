import { timeEntryVoidedResponse } from "@/lib/time-entry-void";
export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withPayrollWrite, withPeriodLockedRoute } from "@/lib/payroll-period";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { PROJECT_STATUS_IN_PROGRESS } from "@/lib/project-status";
import { z } from "zod";
import { LOGISTICS_CATEGORIES, LOGISTICS_COST_CODE, OWNER_ROUTING_WINDOW_HOURS, ownerMayRoute } from "@/lib/logistics-formalize";

const BodySchema = z.object({
    formalizedNote: z.string().max(4000).optional(),
    category: z.string().max(64).optional(),
    routeToProjectId: z.string().min(1).max(64).nullable().optional(),
});

// The worker's tap after "Clean this up" (plan 02): store the formalized note
// + category on the entry and, when they accept a suggested job, ROUTE the
// entry to that job — it becomes that job's labor under the 31-LOGISTICS phase
// (so job costing picks it up with no new plumbing) and remembers where it
// came from (routedFromProjectId) so a manager can send it back to overhead.
//
//   PATCH /api/time-entries/[id]/logistics
//   { formalizedNote?, category?, routeToProjectId?: string | null }
//   - owner: note/category any time; ROUTING only as the one-time clock-out
//     decision — while the entry is open or within OWNER_ROUTING_WINDOW_HOURS
//     of its close, and never after a manager has routed it (Codex review)
//   - MANAGER/ADMIN: any time (the manager page is the canonical re-route)
//   - routeToProjectId null = keep (or return to) overhead

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
    // A payroll write inside: a locked period is a 423, never a 500.
    return withPeriodLockedRoute(() => PATCHHandler(req, context));
}

async function PATCHHandler(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    const { id } = await params;

    const entry = await prisma.timeEntry.findUnique({
        where: { id },
        select: {
            voidedAt: true, id: true, userId: true, projectId: true, routedFromProjectId: true, rawNote: true, notes: true,
            invoiceId: true, invoicedAt: true, endTime: true, routedAt: true, routedById: true,
            changeOrderId: true,
            project: { select: { isLogistics: true } },
        },
    });
    if (!entry) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });
    const isOwner = entry.userId === user.id;
    const isPrivileged = user.role === "MANAGER" || user.role === "ADMIN";
    if (!isOwner && !isPrivileged) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    if (entry.voidedAt) return timeEntryVoidedResponse();

    // Provenance: the first route remembers the Logistics job it came from;
    // later re-routes keep that origin so "back to overhead" always works.
    const originProjectId = entry.routedFromProjectId ?? entry.projectId;
    if (!entry.project.isLogistics && !entry.routedFromProjectId) {
        return NextResponse.json({ error: "Not a logistics entry" }, { status: 400 });
    }

    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    const body = parsed.data;
    const data: Record<string, unknown> = {};

    if (typeof body.formalizedNote === "string") {
        const note = body.formalizedNote.trim().slice(0, 1000);
        if (note) {
            data.formalizedNote = note;
            // The formalized text is what the office reads — keep `notes` (the
            // legacy single field) in step so every existing report shows it.
            data.notes = note;
        }
    }
    if (typeof body.category === "string") {
        if (!(LOGISTICS_CATEGORIES as readonly string[]).includes(body.category)) {
            return NextResponse.json({ error: "Unknown category" }, { status: 400 });
        }
        data.logisticsCategory = body.category;
    }

    if (body.routeToProjectId !== undefined) {
        // Billed labor never moves between jobs after the fact — the invoice
        // and the job-cost "unbilled" filter would both be wrong.
        if (entry.invoiceId != null || entry.invoicedAt != null) {
            return NextResponse.json({ error: "This time was already invoiced and cannot be re-routed", code: "ALREADY_INVOICED" }, { status: 409 });
        }
        // A change-order tag belongs to the job the entry is ON. Moving the
        // entry and leaving the tag behind would bill this job's hours against
        // another job's change order — the same wrong outcome the tagging
        // path's own race guard refuses (tagTimeEntriesToChangeOrderCore).
        // REFUSED rather than cleared: dropping somebody's cost-plus tag as a
        // silent side effect of a re-route is not a decision this route gets to
        // make. Untag on /time-expenses first, then re-route.
        if (entry.changeOrderId != null) {
            return NextResponse.json(
                { error: "This time is tagged to a change order — remove the change-order tag before re-routing it", code: "CHANGE_ORDER_TAGGED" },
                { status: 409 }
            );
        }
        // A worker's routing is the clock-out decision, not a standing power to
        // re-cost history: open or freshly closed entries only, and never after
        // a manager has already placed it.
        if (!isPrivileged && !ownerMayRoute({ endTime: entry.endTime, routedById: entry.routedById, now: new Date(), selfId: user.id })) {
            return NextResponse.json(
                { error: `Only a manager can re-route this entry now (worker routing is allowed within ${OWNER_ROUTING_WINDOW_HOURS}h of clock-out)`, code: "ROUTING_LOCKED" },
                { status: 403 }
            );
        }
        if (!isPrivileged && entry.routedById && entry.routedById !== user.id) {
            return NextResponse.json({ error: "A manager already routed this entry", code: "ROUTING_LOCKED" }, { status: 403 });
        }
        const target = body.routeToProjectId;
        if (target === null) {
            // Back to (or stay on) overhead.
            if (entry.routedFromProjectId) {
                data.projectId = entry.routedFromProjectId;
                data.costCodeId = null;
                data.routedFromProjectId = null;
                data.routedAt = null;
                data.routedById = null;
            }
        } else if (typeof target === "string" && target) {
            const job = await prisma.project.findUnique({ where: { id: target }, select: { id: true, isLogistics: true, status: true } });
            if (!job || job.isLogistics || job.status !== PROJECT_STATUS_IN_PROGRESS) {
                return NextResponse.json({ error: "That job is not available for routing", code: "JOB_NOT_ROUTABLE" }, { status: 400 });
            }
            const costCode = await prisma.costCode.findUnique({ where: { code: LOGISTICS_COST_CODE }, select: { id: true } });
            if (!costCode) return NextResponse.json({ error: `${LOGISTICS_COST_CODE} cost code is missing` }, { status: 500 });
            data.projectId = job.id;
            data.costCodeId = costCode.id;
            data.estimateItemId = null;
            data.routedFromProjectId = originProjectId;
            data.routedAt = new Date();
            data.routedById = user.id;
        } else {
            return NextResponse.json({ error: "routeToProjectId must be a project id or null" }, { status: 400 });
        }
    }

    if (Object.keys(data).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

    const resultSelect = {
        id: true, projectId: true, costCodeId: true, notes: true, rawNote: true, formalizedNote: true,
        logisticsCategory: true, routedFromProjectId: true, routedAt: true, routedById: true,
        project: { select: { id: true, name: true, isLogistics: true } },
    } as const;

    // Routing writes are CONDITIONAL at write time (Codex): the row must still
    // be un-invoiced and, for a worker, still routed by nobody or by themselves.
    // Two concurrent PATCHes (or a manager landing between our read and write)
    // cannot both win. A lost-response retry that finds its own routing already
    // applied gets a 200, not a false failure.
    const routing = body.routeToProjectId !== undefined;
    // Payroll write: goes through the advisory-lock protocol so a locked
    // period refuses it (src/lib/payroll-period.ts).
    const claim = await withPayrollWrite({ entryIds: [id] }, async (tx) =>
        (tx as unknown as typeof prisma).timeEntry.updateMany({
        where: {
            id,
            // changeOrderId pinned for the same reason invoiceId is: a tag
            // landing between the read above and this write must win, or the
            // entry leaves the job its change order belongs to.
            ...(routing ? { invoiceId: null, invoicedAt: null, changeOrderId: null } : {}),
            ...(routing && !isPrivileged ? { OR: [{ routedById: null }, { routedById: user.id }] } : {}),
        },
        data,
        })
    );
    const current = await prisma.timeEntry.findUnique({ where: { id }, select: resultSelect });
    if (!current) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });
    if (claim.count === 0) {
        // "Already applied" only if EVERY requested field is already what we asked for.
        const wantedProject = body.routeToProjectId === null ? originProjectId : body.routeToProjectId;
        const alreadyApplied =
            routing &&
            current.projectId === wantedProject &&
            (data.formalizedNote === undefined || current.formalizedNote === data.formalizedNote) &&
            (data.logisticsCategory === undefined || current.logisticsCategory === data.logisticsCategory);
        if (alreadyApplied) return NextResponse.json({ ...current, alreadyApplied: true });
        return NextResponse.json({ error: "This entry changed underneath you — reload", code: "ROUTING_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json(current);
}
