import { NextResponse } from "next/server";
import twilio from "twilio";
import { prisma } from "@/lib/prisma";
import { frontDeskMode, frontDeskMissLineEnabled, frontDeskBridgeNumberE164, frontDeskNumberE164, frontDeskRichardE164 } from "@/lib/front-desk/constants";
import { resolveInboundBridgeClaim, isValidScreenRequest, resolveScreenResult, resolveActionStep, recordInboundRejectIfAbsent } from "@/lib/front-desk/transfer";
import { rejectTwiml, inboundDialTwiml, screenGatherTwiml, screenAcceptedTwiml, screenRejectedTwiml, actionHangupTwiml, actionMissLineTwiml } from "@/lib/front-desk/twiml";
import { logLeadEvent } from "@/lib/speed-to-lead/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const XML_HEADERS = { "Content-Type": "text/xml" };

function xml(body: string, status = 200) {
    return new NextResponse(body, { status, headers: XML_HEADERS });
}

/**
 * Front Desk v1 §3.2 — the bridge number's Voice URL, one route for all four
 * steps via `?step=`. Fails closed in EVERY environment (unlike
 * `/api/twilio/inbound`'s dev leniency): a missing auth token → 503 (Twilio
 * then uses the fallback Bin, J2); a bad signature → 403.
 */
async function handle(request: Request): Promise<NextResponse> {
    const url = new URL(request.url);
    const step = url.searchParams.get("step") ?? "inbound";

    const params: Record<string, string> = {};
    if (request.method === "POST") {
        const contentType = request.headers.get("content-type") ?? "";
        if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
            const formData = await request.formData();
            for (const [k, v] of formData.entries()) params[k] = String(v);
        }
    }

    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
        return new NextResponse("server misconfigured", { status: 503 });
    }
    const signature = request.headers.get("x-twilio-signature") ?? "";
    const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
    const signedUrl = `${base}${url.pathname}${url.search}`;
    if (!twilio.validateRequest(authToken, signature, signedUrl, params)) {
        return new NextResponse("forbidden", { status: 403 });
    }

    if (params.AccountSid && params.AccountSid !== process.env.TWILIO_ACCOUNT_SID) {
        return xml(rejectTwiml());
    }

    if (step === "screen") return handleScreen(url, params);
    if (step === "screen-result") return handleScreenResult(url, params);
    if (step === "action") return handleAction(url, params);
    return handleInbound(params);
}

export async function POST(request: Request): Promise<NextResponse> {
    return handle(request);
}
export async function GET(request: Request): Promise<NextResponse> {
    return handle(request);
}

async function handleInbound(params: Record<string, string>): Promise<NextResponse> {
    // Codex SHIP-BLOCKING finding #4 (round 2 follow-up): CallSid is read
    // FIRST, before any gate below, so every gate that rejects an
    // authenticated request can persist that decision — see
    // recordInboundRejectIfAbsent's own comment for why an unrecorded
    // reject here lets a later replay steal a different caller's transfer.
    const callSid = params.CallSid || null;

    if (frontDeskMode() === "OFF") {
        await logLeadEvent(prisma, { kind: "front-desk-bridge-rejected", detail: { reason: "mode-off" } });
        if (callSid) await recordInboundRejectIfAbsent(prisma, callSid, "mode-off");
        return xml(rejectTwiml());
    }
    const bridgeNumber = frontDeskBridgeNumberE164();
    const frontDeskNumber = frontDeskNumberE164();
    const richardNumber = frontDeskRichardE164();
    if (!bridgeNumber || !frontDeskNumber || !richardNumber) {
        await logLeadEvent(prisma, { kind: "front-desk-bridge-rejected", detail: { reason: "not-configured" } });
        if (callSid) await recordInboundRejectIfAbsent(prisma, callSid, "not-configured");
        return xml(rejectTwiml());
    }
    if (params.To !== bridgeNumber || params.From !== frontDeskNumber) {
        await logLeadEvent(prisma, { kind: "front-desk-bridge-rejected", detail: { reason: "number-mismatch" } });
        if (callSid) await recordInboundRejectIfAbsent(prisma, callSid, "number-mismatch");
        return xml(rejectTwiml());
    }
    if (!callSid) return xml(rejectTwiml());

    const claim = await resolveInboundBridgeClaim(prisma, callSid);
    if (claim.kind === "reject") {
        await logLeadEvent(prisma, { kind: "front-desk-bridge-unmatched", detail: { callSid } });
        return xml(rejectTwiml());
    }

    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
    return xml(inboundDialTwiml({ baseUrl, bridgeE164: bridgeNumber, richardE164: richardNumber, transferId: claim.transferId }));
}

async function handleScreen(url: URL, params: Record<string, string>): Promise<NextResponse> {
    const transferId = url.searchParams.get("t");
    if (!transferId) return xml(screenRejectedTwiml());
    const transfer = await prisma.frontDeskTransfer.findUnique({ where: { id: transferId } });
    const parentCallSid = params.ParentCallSid || null;
    if (!isValidScreenRequest(transfer, parentCallSid)) return xml(screenRejectedTwiml());

    const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
    const firstName = (transfer!.callerName || "").trim().split(/\s+/)[0] || "Caller";
    return xml(screenGatherTwiml({
        baseUrl,
        transferId,
        isTest: transfer!.isTest,
        callerFirstName: firstName,
        project: transfer!.project,
        city: transfer!.city,
        spanish: transfer!.spanish,
    }));
}

async function handleScreenResult(url: URL, params: Record<string, string>): Promise<NextResponse> {
    const transferId = url.searchParams.get("t");
    if (!transferId) return xml(screenRejectedTwiml());
    const accepted = await resolveScreenResult(prisma, transferId, params.Digits ?? null, params.ParentCallSid || null);
    return xml(accepted ? screenAcceptedTwiml() : screenRejectedTwiml());
}

async function handleAction(url: URL, params: Record<string, string>): Promise<NextResponse> {
    const transferId = url.searchParams.get("t");
    const callSid = params.CallSid;
    if (!transferId || !callSid) return xml(actionHangupTwiml());

    const outcome = await resolveActionStep(prisma, {
        transferId,
        bridgeCallSid: callSid,
        dialCallStatus: params.DialCallStatus ?? null,
        dialBridged: params.DialBridged ?? null,
    });

    // A duplicate callback gets the SAME TwiML as the winning transition —
    // re-read the row's resolved status rather than trust this callback's own claim.
    let finalStatus: string | null = outcome === "connected" ? "CONNECTED" : outcome === "missed" ? "MISSED" : null;
    if (finalStatus === null) {
        const row = await prisma.frontDeskTransfer.findUnique({ where: { id: transferId }, select: { status: true } });
        finalStatus = row?.status ?? null;
    }

    if (finalStatus === "MISSED" && frontDeskMissLineEnabled()) return xml(actionMissLineTwiml());
    return xml(actionHangupTwiml());
}
