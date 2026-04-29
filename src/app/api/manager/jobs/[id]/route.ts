export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userHasRole } from "@/lib/mobile-auth";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;
    if (!userHasRole(user, ["ADMIN", "MANAGER"])) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const existing = await prisma.project.findUnique({ where: { id } });
    if (!existing) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const {
        name,
        address,
        locationLat,
        locationLng,
        geofenceRadiusMeters,
        status,
    } = body as {
        name?: string;
        address?: string | null;
        locationLat?: number | null;
        locationLng?: number | null;
        geofenceRadiusMeters?: number | null;
        status?: string;
    };

    if (locationLat !== undefined && locationLat !== null) {
        if (!Number.isFinite(locationLat) || locationLat < -90 || locationLat > 90) {
            return NextResponse.json({ error: "locationLat must be between -90 and 90" }, { status: 400 });
        }
    }
    if (locationLng !== undefined && locationLng !== null) {
        if (!Number.isFinite(locationLng) || locationLng < -180 || locationLng > 180) {
            return NextResponse.json({ error: "locationLng must be between -180 and 180" }, { status: 400 });
        }
    }
    if (geofenceRadiusMeters !== undefined && geofenceRadiusMeters !== null) {
        if (
            !Number.isFinite(geofenceRadiusMeters) ||
            !Number.isInteger(geofenceRadiusMeters) ||
            geofenceRadiusMeters <= 0
        ) {
            return NextResponse.json(
                { error: "geofenceRadiusMeters must be a positive integer" },
                { status: 400 },
            );
        }
    }

    const data: Prisma.ProjectUpdateInput = {};
    if (typeof name === "string" && name.trim()) data.name = name.trim();
    if (address !== undefined) data.location = address;
    if (locationLat !== undefined) data.locationLat = locationLat;
    if (locationLng !== undefined) data.locationLng = locationLng;
    if (geofenceRadiusMeters !== undefined) data.geofenceRadiusMeters = geofenceRadiusMeters;
    if (typeof status === "string" && status.trim()) data.status = status;

    const project = await prisma.project.update({
        where: { id },
        data,
        include: {
            client: { select: { id: true, name: true, companyName: true } },
            manager: { select: { id: true, name: true, email: true } },
        },
    });

    return NextResponse.json(JSON.parse(JSON.stringify(project)));
}
