import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserWithPermissions, canAccessProject } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
    AiSortUnavailableError,
    suggestDecisionsForItems,
    type AiSortDecisionInput,
    type AiSortItemInput,
} from "@/lib/selection-ai-sort-core";
import { completeSelectionAiSort } from "@/lib/selection-ai-sort-dependencies";

export const maxDuration = 120;

/**
 * Staff-only bulk suggestion run for the "Sort with AI" button
 * (docs/superpowers/plans/2026-07-30-selection-ai-sort.md). Not reachable by
 * portal clients — assertDecisionActorAccess is deliberately NOT used here,
 * unlike every other Decisions action that's shared with the portal.
 *
 * Ordering: staff session is resolved BEFORE the request body is ever read,
 * so an unauthenticated/portal caller gets 403 without any body validation
 * detail. canAccessProject then gates per-project access the same way every
 * other staff-only project route does (see api/ai/change-order-detect).
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

        const [decisions, unsortedItems] = await Promise.all([
            prisma.decision.findMany({
                where: { projectId, deletedAt: null },
                select: { id: true, name: true, area: true },
            }),
            // Unsorted only — decisionId: null. Manually filed items (already
            // in a decision) are never touched or suggested against; manual
            // filing may be a deliberate override.
            prisma.selectionProposal.findMany({
                where: { projectId, decisionId: null, deletedAt: null, status: "Idea" },
                select: { id: true, name: true, imageUrl: true, description: true, clientNote: true, vendorUrl: true },
            }),
        ]);

        // Empty unsorted → short-circuit without ever calling the AI.
        if (unsortedItems.length === 0) {
            return NextResponse.json({ suggestions: [], failedItemIds: [], decisions: [] });
        }

        const decisionInputs: AiSortDecisionInput[] = decisions.map((d) => ({
            id: d.id,
            name: d.name,
            area: d.area,
        }));
        const itemInputs: AiSortItemInput[] = unsortedItems.map((it) => ({
            id: it.id,
            name: it.name,
            description: it.description,
            clientNote: it.clientNote,
            vendorUrl: it.vendorUrl,
        }));

        // Batches are independent (see suggestDecisionsForItems) — a batch
        // that fails after its retry contributes its item ids to
        // failedItemIds rather than aborting the whole run; this only
        // throws (mapped to 502 below) when EVERY batch failed and there is
        // nothing to persist or return at all.
        const { suggestions, failedItemIds } = await suggestDecisionsForItems(
            { decisions: decisionInputs, items: itemInputs },
            { complete: completeSelectionAiSort },
        );

        // Conditional persist — decisionId: null in the WHERE so a
        // concurrent manual assignment (staff filed it themselves mid-run)
        // wins and is never clobbered by a stale suggestion. Only the
        // successful suggestions are persisted; a failed batch's items are
        // left untouched (no suggestion written for them).
        await Promise.all(
            suggestions.map((s) =>
                prisma.selectionProposal.updateMany({
                    where: { id: s.itemId, decisionId: null, deletedAt: null },
                    data: { suggestedDecisionId: s.decisionId, suggestedAt: new Date() },
                }),
            ),
        );

        // The response carries everything the review modal renders — the
        // item's own {name, imageUrl} (from the same query above) and the
        // live {id, name} decisions list — so the modal never has to join
        // fresh suggestions against a stale client-side snapshot of
        // unsorted items or decisions.
        const decisionNames = new Map(decisions.map((d) => [d.id, d.name]));
        const unsortedItemsById = new Map(unsortedItems.map((it) => [it.id, it]));
        return NextResponse.json({
            suggestions: suggestions.map((s) => {
                const item = unsortedItemsById.get(s.itemId);
                return {
                    itemId: s.itemId,
                    name: item?.name ?? "",
                    imageUrl: item?.imageUrl ?? null,
                    decisionId: s.decisionId,
                    decisionName: s.decisionId ? (decisionNames.get(s.decisionId) ?? null) : null,
                    confidence: s.confidence,
                    reason: s.reason,
                };
            }),
            failedItemIds,
            decisions: decisions.map((d) => ({ id: d.id, name: d.name })),
        });
    } catch (err) {
        if (err instanceof AiSortUnavailableError) {
            return NextResponse.json({ error: err.message }, { status: 502 });
        }
        console.error("[POST /api/selections/ai-sort]", err);
        return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
}
