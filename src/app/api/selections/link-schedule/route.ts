import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserWithPermissions, canAccessProject } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
    DecisionLinkUnavailableError,
    suggestScheduleLinksForDecisions,
    type DecisionLinkDecisionInput,
    type DecisionLinkTaskInput,
} from "@/lib/decision-schedule-link-core";
import { completeDecisionScheduleLink } from "@/lib/decision-schedule-link-dependencies";

export const maxDuration = 120;

/**
 * Staff-only bulk suggestion run for the "Link to schedule" button
 * (docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
 * Not reachable by portal clients.
 *
 * Ordering: staff session is resolved BEFORE the request body is ever read,
 * so an unauthenticated/portal caller gets 403 without any body validation
 * detail — same ordering as POST /api/selections/ai-sort.
 *
 * Persists nothing — linking only happens through the review modal's Apply
 * (linkDecisionToSchedule). Unlike AI Auto-Sort's suggestedDecisionId chips,
 * there is no ephemeral-suggestion persistence here; the response is
 * consumed entirely client-side by the review modal.
 */
export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUserWithPermissions();
        if (!user) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const projectId = (body as { projectId?: unknown } | null)?.projectId;
        if (typeof projectId !== "string" || !projectId) {
            return NextResponse.json({ error: "projectId is required" }, { status: 400 });
        }

        if (!canAccessProject(user, projectId)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
        if (!project) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        const [decisions, tasks] = await Promise.all([
            // Live, undecided decisions only — Decided/Ordered/Received
            // decisions have nothing left to schedule against. leadTimeDays
            // is selected so the response can carry each decision's EXISTING
            // configured lead time (Codex review round 1, issue 5) — the
            // modal seeds from that rather than clobbering a deliberately
            // configured value with the AI's guess.
            prisma.decision.findMany({
                where: { projectId, deletedAt: null, status: { in: ["Open", "Flagged"] } },
                orderBy: { sortOrder: "asc" },
                select: { id: true, name: true, area: true, templateKey: true, leadTimeDays: true },
            }),
            prisma.scheduleTask.findMany({
                where: { projectId },
                orderBy: { startDate: "asc" },
                select: { id: true, name: true, startDate: true, endDate: true, parentId: true, type: true },
            }),
        ]);

        if (decisions.length === 0) {
            return NextResponse.json({ suggestions: [], failedDecisionIds: [], tasks: [] });
        }

        // Template-provenance scheduleHint (Codex review round 1, issue 5):
        // when a decision was seeded from a DecisionTemplate
        // (templateKey === "decision-template:<templateId>:<itemId>"), its
        // originating DecisionTemplateItem may carry a scheduleHint — free
        // text like "cabinet install" that's specifically FOR helping this
        // AI match a schedule task. Batched, not per-decision.
        const TEMPLATE_KEY_PATTERN = /^decision-template:[^:]+:(.+)$/;
        const templateItemIds = decisions
            .map((d) => d.templateKey?.match(TEMPLATE_KEY_PATTERN)?.[1])
            .filter((id): id is string => !!id);
        const scheduleHintByItemId = templateItemIds.length
            ? new Map(
                  (
                      await prisma.decisionTemplateItem.findMany({
                          where: { id: { in: templateItemIds } },
                          select: { id: true, scheduleHint: true },
                      })
                  ).map((i) => [i.id, i.scheduleHint]),
              )
            : new Map<string, string | null>();

        const decisionInputs: DecisionLinkDecisionInput[] = decisions.map((d) => {
            const itemId = d.templateKey?.match(TEMPLATE_KEY_PATTERN)?.[1];
            const scheduleHint = itemId ? (scheduleHintByItemId.get(itemId) ?? null) : null;
            return { id: d.id, name: d.name, area: d.area, scheduleHint };
        });
        const taskInputs: DecisionLinkTaskInput[] = tasks.map((t) => ({
            id: t.id,
            name: t.name,
            startDate: t.startDate.toISOString(),
            endDate: t.endDate.toISOString(),
            parentId: t.parentId,
            type: t.type,
        }));

        // Batches are independent — a batch that fails after its retry
        // contributes its decision ids to failedDecisionIds rather than
        // aborting the whole run; this only throws (mapped to 502 below)
        // when EVERY batch failed.
        const { suggestions, failedDecisionIds } = await suggestScheduleLinksForDecisions(
            { decisions: decisionInputs, tasks: taskInputs },
            { complete: completeDecisionScheduleLink },
        );

        // The response carries everything the review modal renders (Phase 2
        // lesson) — each suggestion joined with its decision's name, the
        // live tasks list for the selects, and failedDecisionIds.
        const decisionsById = new Map(decisions.map((d) => [d.id, d]));
        return NextResponse.json({
            suggestions: suggestions.map((s) => ({
                decisionId: s.decisionId,
                decisionName: decisionsById.get(s.decisionId)?.name ?? "",
                scheduleTaskId: s.scheduleTaskId,
                leadTimeDays: s.leadTimeDays,
                // The decision's ALREADY-CONFIGURED lead time (e.g. from a
                // template's defaultLeadTimeDays, or a prior manual link) —
                // null if never set. The modal seeds its lead-time input from
                // this when present, falling back to the AI's guess
                // (leadTimeDays above) only when it's null (Codex review
                // round 1, issue 5).
                existingLeadTimeDays: decisionsById.get(s.decisionId)?.leadTimeDays ?? null,
                confidence: s.confidence,
                reason: s.reason,
            })),
            failedDecisionIds,
            tasks: taskInputs.map((t) => ({ id: t.id, name: t.name, startDate: t.startDate })),
        });
    } catch (err) {
        if (err instanceof DecisionLinkUnavailableError) {
            return NextResponse.json({ error: err.message }, { status: 502 });
        }
        console.error("[POST /api/selections/link-schedule]", err);
        return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
}
