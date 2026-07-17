// Dev-only: drive the approveEstimate server action for QA of the signing →
// project → invoice → QuickBooks pipeline. Background/hidden preview tabs
// throttle the portal's client-side PDF-capture chain, so local tooling posts
// here instead. Hard-disabled outside development.

import { NextResponse } from "next/server";
import { approveEstimate } from "@/lib/actions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
    if (process.env.NODE_ENV !== "development") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    let body: { estimateId?: string; signatureName?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!body.estimateId) return NextResponse.json({ error: "estimateId required" }, { status: 400 });

    const result = await approveEstimate(
        body.estimateId,
        body.signatureName || "QA Signature",
        "dev-approve-route",
        undefined,
        undefined
    );
    return NextResponse.json({ done: true, result: result ?? null });
}
