export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { canonicalProjectStatus } from "@/lib/project-status";
import { geocodeJobSiteAddress } from "@/lib/geocode";
import { isValidChatWebhookUrl } from "@/lib/chat-webhook";

const SELECT = {
    id: true,
    name: true,
    status: true,
    location: true,
    locationLat: true,
    locationLng: true,
    geofenceRadiusMeters: true,
    clientId: true,
    // Only safe here because this route is MANAGER/ADMIN-gated; the webhook URL
    // is a credential and must never appear in crew-visible project responses.
    chatWebhookUrl: true,
} as const;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const project = await prisma.project.findUnique({ where: { id }, select: SELECT });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json(project);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const exists = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Whitelist what mobile can change. The web's full /api/projects/[id] PATCH covers
    // the rest (manager, type, etc.).
    const data: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
    if (typeof body.status === "string") {
        // Accept legacy labels from older mobile builds and map them onto the canonical set.
        const canonical = canonicalProjectStatus(body.status);
        if (!canonical) {
            return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
        }
        data.status = canonical;
    }
    if (body.location === null || typeof body.location === "string") data.location = body.location;
    // Coords must be a valid numeric pair, provided together — same rule as POST's
    // parseGeoFields (../route.ts). Only touch data.locationLat/Lng when the client
    // actually sent one of the two fields; a lone or invalid-type coordinate must 400
    // instead of silently mixing a new value with the stale one already in the DB.
    if (body.locationLat !== undefined || body.locationLng !== undefined) {
        let locationLat: number | null = null;
        if (body.locationLat !== undefined && body.locationLat !== null) {
            if (
                typeof body.locationLat !== "number" ||
                !Number.isFinite(body.locationLat) ||
                body.locationLat < -90 ||
                body.locationLat > 90
            ) {
                return NextResponse.json({ error: "locationLat out of range" }, { status: 400 });
            }
            locationLat = body.locationLat;
        }
        let locationLng: number | null = null;
        if (body.locationLng !== undefined && body.locationLng !== null) {
            if (
                typeof body.locationLng !== "number" ||
                !Number.isFinite(body.locationLng) ||
                body.locationLng < -180 ||
                body.locationLng > 180
            ) {
                return NextResponse.json({ error: "locationLng out of range" }, { status: 400 });
            }
            locationLng = body.locationLng;
        }
        if ((locationLat === null) !== (locationLng === null)) {
            return NextResponse.json(
                { error: "locationLat and locationLng must be provided together" },
                { status: 400 }
            );
        }
        data.locationLat = locationLat;
        data.locationLng = locationLng;
    }
    if (body.geofenceRadiusMeters !== undefined) {
        if (
            typeof body.geofenceRadiusMeters !== "number" ||
            !Number.isFinite(body.geofenceRadiusMeters) ||
            body.geofenceRadiusMeters <= 0 ||
            body.geofenceRadiusMeters > 100_000
        ) {
            return NextResponse.json({ error: "geofenceRadiusMeters must be 1–100000" }, { status: 400 });
        }
        data.geofenceRadiusMeters = Math.floor(body.geofenceRadiusMeters);
    }

    // Mobile web can't geocode client-side (expo-location's geocodeAsync returns []
    // on web), so a typed address override would otherwise silently lose its geofence.
    // Geocode server-side when the client changed the location but didn't send coords.
    if (
        typeof body.location === "string" &&
        body.location.trim() &&
        (body.locationLat === undefined || body.locationLat === null) &&
        (body.locationLng === undefined || body.locationLng === null)
    ) {
        const geocoded = await geocodeJobSiteAddress(body.location);
        data.locationLat = geocoded?.lat ?? null;
        data.locationLng = geocoded?.lng ?? null;
    }

    if (body.chatWebhookUrl !== undefined) {
        if (body.chatWebhookUrl === null || body.chatWebhookUrl === "") {
            data.chatWebhookUrl = null;
        } else if (typeof body.chatWebhookUrl === "string" && isValidChatWebhookUrl(body.chatWebhookUrl)) {
            data.chatWebhookUrl = body.chatWebhookUrl.trim();
        } else {
            return NextResponse.json(
                { error: "chatWebhookUrl must be a Google Chat incoming webhook (https://chat.googleapis.com/v1/spaces/...)" },
                { status: 400 }
            );
        }
    }

    if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: "No mutable fields supplied" }, { status: 400 });
    }

    const updated = await prisma.project.update({ where: { id }, data, select: SELECT });
    // Auto-assign ACTIVATED FIELD_CREW (+ CJ) when a job moves to "In Progress".
    // Fail-soft inside the helper; never blocks the save.
    const { autoAssignCrewOnStatusChange } = await import("@/lib/crew-auto-assign-sync");
    after(() => autoAssignCrewOnStatusChange(id, updated.status));
    return NextResponse.json(updated);
}
