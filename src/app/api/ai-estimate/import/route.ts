import { NextRequest, NextResponse } from "next/server";
import { transformPhasesToItems, type AiPhase } from "@/lib/ai-estimate-transform";

// Accepts an estimate authored outside ProBuild (e.g. pasted from ChatGPT) in the
// { phases: [...], paymentMilestones: [...] } shape and converts it — via the same
// transform the AI generator uses — into the grouped EstimateItem[] the editor merges.
// No DB writes here: the editor's normal save path persists the returned items.
export async function POST(req: NextRequest) {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Could not read request — invalid JSON body." }, { status: 400 });
    }

    const { phases, paymentMilestones, costCodes, costTypes } = (body || {}) as {
        phases?: unknown;
        paymentMilestones?: unknown;
        costCodes?: unknown;
        costTypes?: unknown;
    };

    if (!Array.isArray(phases) || phases.length === 0) {
        return NextResponse.json(
            { error: 'JSON must contain a non-empty "phases" array. Paste ChatGPT\'s full output — it should start with { and end with }.' },
            { status: 400 },
        );
    }

    // Keep only phases that actually carry line items.
    const validPhases = (phases as AiPhase[]).filter(
        (p) => p && typeof p === "object" && Array.isArray(p.items) && p.items.length > 0,
    );
    if (validPhases.length === 0) {
        return NextResponse.json(
            { error: 'No phases with line items found. Each phase needs an "items" array with at least one item.' },
            { status: 400 },
        );
    }

    const result = transformPhasesToItems(
        { phases: validPhases, paymentMilestones: Array.isArray(paymentMilestones) ? paymentMilestones : [] },
        Array.isArray(costCodes) ? costCodes : [],
        Array.isArray(costTypes) ? costTypes : [],
    );

    return NextResponse.json(result);
}
