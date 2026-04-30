export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

const SELECT = {
    id: true,
    name: true,
    status: true,
    location: true,
    locationLat: true,
    locationLng: true,
    geofenceRadiusMeters: true,
    clientId: true,
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
        const allowed = new Set(["In Progress", "Closed", "Paid Ready to Start"]);
        if (!allowed.has(body.status)) {
            return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
        }
        data.status = body.status;
    }
    if (body.location === null || typeof body.location === "string") data.location = body.location;
    if (body.locationLat === null) {
        data.locationLat = null;
    } else if (typeof body.locationLat === "number") {
        if (!Number.isFinite(body.locationLat) || body.locationLat < -90 || body.locationLat > 90) {
            return NextResponse.json({ error: "locationLat out of range" }, { status: 400 });
        }
        data.locationLat = body.locationLat;
    }
    if (body.locationLng === null) {
        data.locationLng = null;
    } else if (typeof body.locationLng === "number") {
        if (!Number.isFinite(body.locationLng) || body.locationLng < -180 || body.locationLng > 180) {
            return NextResponse.json({ error: "locationLng out of range" }, { status: 400 });
        }
        data.locationLng = body.locationLng;
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

    if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: "No mutable fields supplied" }, { status: 400 });
    }

    const updated = await prisma.project.update({ where: { id }, data, select: SELECT });
    return NextResponse.json(updated);
}
