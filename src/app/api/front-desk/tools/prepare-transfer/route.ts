import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyToolSecret } from "@/lib/front-desk/auth";
import { handlePrepareTransferTool } from "@/lib/front-desk/transfer";
import { frontDeskAgentId, frontDeskIsTest, frontDeskMode, FRONT_DESK_TOOL_BODY_MAX_BYTES } from "@/lib/front-desk/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

// Only conversation_id/agent_id (bound) are hard-required — a missing or
// empty read-back field is §3.1's own "readback_incomplete" business
// outcome, not a transport failure, so it must reach handlePrepareTransferTool.
const bodySchema = z.object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    caller_name: z.string().optional().nullable(),
    callback_phone: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    project: z.string().optional().nullable(),
    spanish: z.unknown().optional(),
    readback_confirmed: z.unknown().optional(),
}).strict();

function unauthorized() {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
}

/**
 * Front Desk v1 §2.0 + §3.1: `prepare_transfer` tool — the flagged addition
 * the bridge cannot work without (a conference transfer carries no caller
 * details of its own).
 */
export async function POST(request: Request) {
    if (!verifyToolSecret(request.headers.get("x-front-desk-key"), process.env.FRONT_DESK_TOOL_SECRET)) {
        return unauthorized();
    }

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > FRONT_DESK_TOOL_BODY_MAX_BYTES) return unauthorized();

    let json: unknown;
    try {
        json = JSON.parse(rawBody);
    } catch {
        return unauthorized();
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return unauthorized();

    const expectedAgentId = frontDeskAgentId();
    if (!expectedAgentId || parsed.data.agent_id !== expectedAgentId) return unauthorized();

    if (frontDeskMode() === "OFF") {
        return NextResponse.json({ status: "no_transfer:front_desk_off" });
    }

    const outcome = await handlePrepareTransferTool(prisma, {
        conversationId: parsed.data.conversation_id,
        agentId: parsed.data.agent_id,
        isTest: frontDeskIsTest(),
        callerName: parsed.data.caller_name ?? "",
        callbackPhone: parsed.data.callback_phone ?? "",
        city: parsed.data.city ?? "",
        project: parsed.data.project ?? "",
        spanish: parsed.data.spanish === true,
        readbackConfirmed: parsed.data.readback_confirmed === true,
    });

    if (outcome.kind === "transfer_ready") return NextResponse.json({ status: "transfer_ready" });
    return NextResponse.json({ status: `no_transfer:${outcome.reason}` });
}
