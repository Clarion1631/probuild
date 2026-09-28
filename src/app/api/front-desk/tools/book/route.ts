import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyToolSecret } from "@/lib/front-desk/auth";
import { handleBookTool } from "@/lib/front-desk/booking";
import { frontDeskAgentId, frontDeskIsTest, frontDeskMode, FRONT_DESK_TOOL_BODY_MAX_BYTES } from "@/lib/front-desk/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

// Only conversation_id/agent_id (bound, always present on a genuine call) are
// hard-required here. The LLM-filled read-back fields are deliberately
// optional at THIS layer — a missing or empty one is business logic
// (§2.2: "not_booked:readback_incomplete"), not a transport failure, so it
// must reach handleBookTool's own guard rather than 401 here.
const bodySchema = z.object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    caller_id: z.string().optional().nullable(),
    slot_id: z.string().optional().nullable(),
    confirmed_date: z.string().optional().nullable(),
    confirmed_time: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    callback_phone: z.string().optional().nullable(),
    readback_confirmed: z.unknown().optional(),
}).strict();

function unauthorized() {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
}

/** Front Desk v1 §2.0 + §2.2: `book_call` tool. */
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
        return NextResponse.json({ status: "not_booked:front_desk_off" });
    }

    const outcome = await handleBookTool(prisma, {
        conversationId: parsed.data.conversation_id,
        agentId: parsed.data.agent_id,
        callerId: parsed.data.caller_id ?? null,
        isTest: frontDeskIsTest(),
        slotId: parsed.data.slot_id ?? "",
        confirmedDate: parsed.data.confirmed_date ?? "",
        confirmedTime: parsed.data.confirmed_time ?? "",
        name: parsed.data.name ?? "",
        email: parsed.data.email ?? "",
        callbackPhone: parsed.data.callback_phone ?? "",
        readbackConfirmed: parsed.data.readback_confirmed === true,
    });

    if (outcome.kind === "booked") return NextResponse.json({ status: "booked", spoken: outcome.spoken });
    if (outcome.kind === "uncertain") return NextResponse.json({ status: "uncertain" });
    return NextResponse.json({
        status: `not_booked:${outcome.reason}`,
        ...(outcome.mode ? { mode: outcome.mode } : {}),
        ...(outcome.spoken ? { spoken: outcome.spoken } : {}),
    });
}
