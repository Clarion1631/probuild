export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

// Manager wrapper around `Project`. The mobile app uses these to list / create / edit
// jobs; the response shape matches `ManagerJob` in the mobile `lib/api-types.ts`.
//
// We intentionally don't use the rich /api/projects POST flow here: mobile only needs
// to create the minimum-viable Project (name + address + geofence coords). Lead linkage,
// estimates, etc. happen on the web.

export async function GET(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const projects = await prisma.project.findMany({
        where: { status: { not: "Closed" } },
        orderBy: { name: "asc" },
        select: {
            id: true,
            name: true,
            status: true,
            location: true,
            locationLat: true,
            locationLng: true,
            geofenceRadiusMeters: true,
            clientId: true,
        },
    });

    return NextResponse.json(projects);
}

export async function POST(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;

    if (user.role !== "MANAGER" && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

    // ProBuild's Project model requires a clientId — every project belongs to a client.
    // If the caller didn't provide one (mobile MVP doesn't pick clients), fall back to
    // the first existing client. If there are zero clients, error explicitly so the
    // operator knows to set one up on the web first rather than getting a Prisma FK error.
    let clientId: string | null = typeof body.clientId === "string" ? body.clientId : null;
    if (!clientId) {
        const fallback = await prisma.client.findFirst({ select: { id: true }, orderBy: { name: "asc" } });
        if (!fallback) {
            return NextResponse.json(
                {
                    error:
                        "No clients exist yet. Add a client on the web (/clients) before creating a project from mobile.",
                },
                { status: 400 }
            );
        }
        clientId = fallback.id;
    }

    let radius = 100;
    if (body.geofenceRadiusMeters !== undefined) {
        if (
            typeof body.geofenceRadiusMeters !== "number" ||
            !Number.isFinite(body.geofenceRadiusMeters) ||
            body.geofenceRadiusMeters <= 0 ||
            body.geofenceRadiusMeters > 100_000
        ) {
            return NextResponse.json({ error: "geofenceRadiusMeters must be 1–100000" }, { status: 400 });
        }
        radius = Math.floor(body.geofenceRadiusMeters);
    }

    let locationLat: number | null = null;
    let locationLng: number | null = null;
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

    const created = await prisma.project.create({
        data: {
            name,
            clientId,
            location: typeof body.location === "string" ? body.location : null,
            locationLat,
            locationLng,
            geofenceRadiusMeters: radius,
        },
        select: {
            id: true,
            name: true,
            status: true,
            location: true,
            locationLat: true,
            locationLng: true,
            geofenceRadiusMeters: true,
            clientId: true,
        },
    });

    return NextResponse.json(created);
}
