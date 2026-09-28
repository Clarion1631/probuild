import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyToolSecret } from "@/lib/front-desk/auth";
import { handleAvailabilityTool } from "@/lib/front-desk/booking";
import { frontDeskAgentId, frontDeskIsTest, frontDeskMode, FRONT_DESK_TOOL_BODY_MAX_BYTES } from "@/lib/front-desk/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const bodySchema = z.object({
    conversation_id: z.string().min(1),
    agent_id: z.string().min(1),
    preferred_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    part_of_day: z.enum(["morning", "afternoon", "any"]).optional(),
}).strict();

function unauthorized() {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
}

/** Front Desk v1 §2.0 + §2.1: `open_times` tool. */
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

    // §2.0: OFF short-circuits before any DB access. Availability's own
    // reason enum (§2.1) has no "front_desk_off" member — the bare status.
    if (frontDeskMode() === "OFF") {
        return NextResponse.json({ status: "take_preferred_times" });
    }

    const result = await handleAvailabilityTool(prisma, {
        conversationId: parsed.data.conversation_id,
        agentId: parsed.data.agent_id,
        isTest: frontDeskIsTest(),
        preferredDate: parsed.data.preferred_date ?? null,
        partOfDay: parsed.data.part_of_day ?? null,
    });
    return NextResponse.json(result);
}
