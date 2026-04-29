export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userHasRole } from "@/lib/mobile-auth";

function validateGeofence(
    lat: number | undefined,
    lng: number | undefined,
    radius: number | undefined,
): string | null {
    if (lat !== undefined) {
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
            return "locationLat must be between -90 and 90";
        }
    }
    if (lng !== undefined) {
        if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
            return "locationLng must be between -180 and 180";
        }
    }
    if (radius !== undefined) {
        if (!Number.isFinite(radius) || !Number.isInteger(radius) || radius <= 0) {
            return "geofenceRadiusMeters must be a positive integer";
        }
    }
    return null;
}

export async function GET(req: NextRequest) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;
    if (!userHasRole(user, ["ADMIN", "MANAGER"])) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");

    const where: Prisma.ProjectWhereInput = {};
    if (status) where.status = status;

    const projects = await prisma.project.findMany({
        where,
        include: {
            client: { select: { id: true, name: true, companyName: true } },
            manager: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(JSON.parse(JSON.stringify(projects)));
}

export async function POST(req: NextRequest) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;
    if (!userHasRole(user, ["ADMIN", "MANAGER"])) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const {
        name,
        clientId,
        address,
        locationLat,
        locationLng,
        geofenceRadiusMeters,
    } = body as {
        name?: string;
        clientId?: string;
        address?: string;
        locationLat?: number;
        locationLng?: number;
        geofenceRadiusMeters?: number;
    };

    if (!name || typeof name !== "string" || !name.trim()) {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!clientId || typeof clientId !== "string") {
        return NextResponse.json({ error: "clientId is required" }, { status: 400 });
    }

    const geofenceError = validateGeofence(locationLat, locationLng, geofenceRadiusMeters);
    if (geofenceError) {
        return NextResponse.json({ error: geofenceError }, { status: 400 });
    }

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
        return NextResponse.json({ error: "Client not found" }, { status: 400 });
    }

    const project = await prisma.project.create({
        data: {
            name: name.trim(),
            clientId,
            location: address ?? undefined,
            locationLat: typeof locationLat === "number" ? locationLat : undefined,
            locationLng: typeof locationLng === "number" ? locationLng : undefined,
            geofenceRadiusMeters:
                typeof geofenceRadiusMeters === "number" ? geofenceRadiusMeters : undefined,
        },
        include: {
            client: { select: { id: true, name: true, companyName: true } },
        },
    });

    return NextResponse.json(JSON.parse(JSON.stringify(project)));
}
