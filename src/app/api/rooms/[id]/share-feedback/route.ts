// /api/rooms/[id]/share-feedback — public endpoint for clients viewing a
// shared room to send "I want these changes" notes back to the contractor.
//
// NO session auth. Gatekeeping is by share token match + shareEnabled=true.
// Invalid/disabled tokens return the SAME 404 shape so the endpoint can't
// be used as an oracle for whether a given token is live vs. disabled.
//
// Delivery uses the existing `sendNotification()` helper (Resend). Recipient
// priority:
//   1. room.project.manager.email
//   2. room.lead.manager.email
//   3. first User.role=ADMIN email (catch-all)
//
// Rate limit: 5 submissions per token per hour, in-memory (per serverless
// instance — Vercel's edge/runtime limits prevent a real abuse wave anyway).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";
import { isValidShareToken } from "@/lib/room-designer/share-url";

export const dynamic = "force-dynamic";

interface RouteParams { params: Promise<{ id: string }> }

// ───── In-memory rate limiter ─────
// Simple: keyed by `${token}::${ip-hash}`; stores timestamps; prunes on each
// access. Not distributed — if infra-level rate limiting fronts this, treat
// it as defence-in-depth rather than the primary shield.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_CAP = 1000; // cap the map so memory doesn't blow up
const rateMap = new Map<string, number[]>();

function rateLimitKey(token: string, ip: string) {
    return `${token}::${ip}`;
}

function checkRateLimit(key: string): { ok: boolean; retryAfterMs?: number } {
    const now = Date.now();
    let hits = rateMap.get(key) ?? [];
    hits = hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (hits.length >= RATE_LIMIT_MAX) {
        return { ok: false, retryAfterMs: RATE_LIMIT_WINDOW_MS - (now - hits[0]) };
    }
    hits.push(now);
    rateMap.set(key, hits);
    // LRU-ish cap: if we blow the cap, drop the oldest half.
    if (rateMap.size > RATE_LIMIT_CAP) {
        const keys = Array.from(rateMap.keys()).slice(0, Math.floor(RATE_LIMIT_CAP / 2));
        for (const k of keys) rateMap.delete(k);
    }
    return { ok: true };
}

function clientIp(req: Request): string {
    // Vercel sets x-forwarded-for — take the first entry (the real client).
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    return "unknown";
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function deepLink(room: { projectId: string | null; leadId: string | null; id: string }): string {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? "";
    const trimmed = base.replace(/\/+$/, "");
    if (room.projectId) return `${trimmed}/projects/${room.projectId}/room-designer/${room.id}`;
    if (room.leadId) return `${trimmed}/leads/${room.leadId}/room-designer/${room.id}`;
    return `${trimmed}/`;
}

export async function POST(req: Request, { params }: RouteParams) {
    const { id } = await params;

    let body: {
        token?: unknown;
        message?: unknown;
        clientName?: unknown;
        clientEmail?: unknown;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const token = typeof body.token === "string" ? body.token : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const clientName = typeof body.clientName === "string" ? body.clientName.trim().slice(0, 120) : "";
    const clientEmail = typeof body.clientEmail === "string" ? body.clientEmail.trim().slice(0, 200) : "";

    // Uniform-error guard: bail with a 404 for any of (bad token format,
    // room missing, shareEnabled=false). Single shape = no disclosure.
    if (!isValidShareToken(token) || !message) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rate = checkRateLimit(rateLimitKey(token, clientIp(req)));
    if (!rate.ok) {
        return NextResponse.json(
            { error: "Too many requests" },
            { status: 429, headers: { "Retry-After": String(Math.ceil((rate.retryAfterMs ?? 0) / 1000)) } },
        );
    }

    const room = await prisma.roomDesign.findFirst({
        where: { id, shareToken: token, shareEnabled: true },
        include: {
            project: { include: { manager: { select: { email: true, name: true } } } },
            lead: { include: { manager: { select: { email: true, name: true } } } },
        },
    });
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let recipient = room.project?.manager?.email ?? room.lead?.manager?.email ?? null;
    if (!recipient) {
        const admin = await prisma.user.findFirst({
            where: { role: "ADMIN" },
            select: { email: true },
        });
        recipient = admin?.email ?? null;
    }
    if (!recipient) {
        // No one to notify → fail closed.
        return NextResponse.json({ error: "No recipient configured" }, { status: 500 });
    }

    const ownerName = room.project?.name ?? room.lead?.name ?? "Untitled";
    const subject = `Change request for ${ownerName} — ${room.name}`;
    const html = [
        `<h2>Change request from ${clientName ? escapeHtml(clientName) : "your client"}</h2>`,
        `<p><strong>Project:</strong> ${escapeHtml(ownerName)}</p>`,
        `<p><strong>Room:</strong> ${escapeHtml(room.name)}</p>`,
        clientEmail ? `<p><strong>Client email:</strong> ${escapeHtml(clientEmail)}</p>` : "",
        `<hr />`,
        `<p style="white-space:pre-wrap;">${escapeHtml(message)}</p>`,
        `<hr />`,
        `<p><a href="${deepLink(room)}">Open this room in ProBuild →</a></p>`,
    ].filter(Boolean).join("\n");

    const result = await sendNotification(
        recipient,
        subject,
        html,
        undefined,
        clientEmail ? { replyTo: clientEmail } : undefined,
    );

    if (!result.success) {
        return NextResponse.json({ error: "Delivery failed" }, { status: 502 });
    }

    return NextResponse.json({ success: true });
}
