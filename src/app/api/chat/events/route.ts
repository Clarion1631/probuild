import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ingestChatSpaceToDailyLogs, isChatIngestConfigured } from "@/lib/chat-field-ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Google Chat app event endpoint — the URL the "ProBuild" Chat app
 * (GCP probuild-487805) is configured to POST to.
 *
 * A Chat app only receives MESSAGE events when @mentioned, so this route is
 * NOT the ingestion path — the nightly /api/cron/field-progress pull is. This
 * route acks membership events and gives the crew an on-demand "@ProBuild
 * sync" that ingests the space's recent posts immediately.
 *
 * Auth: Google signs every event request with a bearer ID token issued by
 * chat@system.gserviceaccount.com whose audience is the app's GCP project
 * number. Fail closed: no GOOGLE_CHAT_APP_AUDIENCE configured → nothing is
 * accepted.
 */

const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const CHAT_JWKS_URL = new URL(`https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_ISSUER}`);

type ChatEvent = {
    type?: string;
    space?: { name?: string; displayName?: string };
    message?: { text?: string; argumentText?: string; space?: { name?: string } };
};

async function verifyChatBearer(request: Request): Promise<boolean> {
    const audience = process.env.GOOGLE_CHAT_APP_AUDIENCE;
    if (!audience) return false;
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return false;
    try {
        const { jwtVerify, createRemoteJWKSet } = await import("jose");
        const jwks = createRemoteJWKSet(CHAT_JWKS_URL);
        await jwtVerify(header.slice("Bearer ".length), jwks, {
            issuer: CHAT_ISSUER,
            audience,
        });
        return true;
    } catch {
        return false;
    }
}

export async function POST(request: Request) {
    if (!(await verifyChatBearer(request))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let event: ChatEvent;
    try {
        event = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const spaceName = event.space?.name ?? event.message?.space?.name ?? null;
    const project = spaceName
        ? await prisma.project.findUnique({
            where: { googleChatSpaceId: spaceName },
            select: { id: true, name: true, googleChatSpaceId: true },
        })
        : null;

    // The returned JSON body is posted into the space as the app's reply.
    if (event.type === "ADDED_TO_SPACE") {
        const text = project
            ? `Connected — this space feeds daily logs for "${project.name}". Posts here sync into ProBuild nightly; mention me with "sync" to pull them in now.`
            : `Connected. This space isn't mapped to a ProBuild project yet — once it is, posts here sync into the project's daily logs automatically.`;
        return NextResponse.json({ text });
    }

    if (event.type === "MESSAGE") {
        // argumentText is the message with the @mention stripped.
        const command = (event.message?.argumentText ?? event.message?.text ?? "").trim().toLowerCase();
        if (!project) {
            return NextResponse.json({ text: "This space isn't mapped to a ProBuild project yet, so I can't sync it." });
        }
        if (!command.includes("sync")) {
            return NextResponse.json({ text: `I sync this space's posts into "${project.name}" daily logs nightly. Mention me with "sync" to run it now.` });
        }
        if (!isChatIngestConfigured()) {
            return NextResponse.json({ text: "Sync isn't configured yet (missing service-account credential). Posts will be picked up once it is." });
        }
        try {
            // Chat expects a reply within its interaction deadline; photos are
            // the slow part, so the interactive sync skips them — the nightly
            // run backfills photos for zero-photo logs.
            const result = await ingestChatSpaceToDailyLogs(
                { id: project.id, googleChatSpaceId: project.googleChatSpaceId! },
                { skipPhotos: true, lookbackHours: 24 },
            );
            return NextResponse.json({
                text: `Synced: ${result.created} new daily log${result.created === 1 ? "" : "s"}, ${result.updated} updated. Photos come in on the nightly pass.`,
            });
        } catch (err) {
            console.error("[chat/events] sync failed", err);
            return NextResponse.json({ text: "Sync hit an error — it'll be retried on the nightly run." });
        }
    }

    // REMOVED_FROM_SPACE and anything else: acknowledge silently.
    return NextResponse.json({});
}
