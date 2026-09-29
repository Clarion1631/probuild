// /api/studio-library/import — AI extraction of finishes/products from pasted
// catalog text (a vendor PDF's text, a Home Depot/Lowe's product page, a
// spec sheet email...). Returns CANDIDATES for the user to review; nothing is
// saved until they confirm via POST /api/studio-library.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildImportRequest, findToolInput } from "@/lib/studio-library-import";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const caller = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    let body: { text?: string; vendor?: string; hint?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length < 40) {
        return NextResponse.json({ error: "Paste at least a few lines of catalog text" }, { status: 400 });
    }
    const clipped = text.slice(0, 250_000);

    const anthropic = new Anthropic();
    const request = buildImportRequest({ text: clipped, vendor: body.vendor, hint: body.hint });

    // Sonnet 5.5 rejects a forced tool_choice, so the tool is steered by the
    // prompt (tool_choice auto) and a call is not guaranteed: retry once when
    // the model answers in text instead.
    let msg = await anthropic.messages.create(request);
    let input = msg.stop_reason === "refusal" ? null : findToolInput(msg.content);
    if (!input && msg.stop_reason !== "refusal") {
        msg = await anthropic.messages.create(request);
        input = msg.stop_reason === "refusal" ? null : findToolInput(msg.content);
    }
    if (msg.stop_reason === "refusal") {
        return NextResponse.json({ error: "The AI declined to extract from this text" }, { status: 422 });
    }
    if (!input) {
        return NextResponse.json({ error: "Extraction produced no structured output" }, { status: 502 });
    }
    return NextResponse.json({
        finishes: Array.isArray(input.finishes) ? input.finishes.slice(0, 300) : [],
        products: Array.isArray(input.products) ? input.products.slice(0, 300) : [],
        model: msg.model,
        usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
    });
}
