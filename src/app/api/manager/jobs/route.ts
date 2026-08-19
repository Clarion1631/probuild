export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { OPEN_PROJECT_STATUSES } from "@/lib/project-status";
import { geocodeJobSiteAddress } from "@/lib/geocode";
import { assertLeadAccess } from "@/lib/lead-access";

// Shared geofence-field parsing for POST — used by both the lead-linked and
// plain creation paths below. Returns an error NextResponse to short-circuit
// on bad input, or the parsed fields.
function parseGeoFields(body: any):
    | { error: NextResponse }
    | { radius: number; locationLat: number | null; locationLng: number | null } {
    let radius = 100;
    if (body.geofenceRadiusMeters !== undefined) {
        if (
            typeof body.geofenceRadiusMeters !== "number" ||
            !Number.isFinite(body.geofenceRadiusMeters) ||
            body.geofenceRadiusMeters <= 0 ||
            body.geofenceRadiusMeters > 100_000
        ) {
            return { error: NextResponse.json({ error: "geofenceRadiusMeters must be 1–100000" }, { status: 400 }) };
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
            return { error: NextResponse.json({ error: "locationLat out of range" }, { status: 400 }) };
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
            return { error: NextResponse.json({ error: "locationLng out of range" }, { status: 400 }) };
        }
        locationLng = body.locationLng;
    }

    return { radius, locationLat, locationLng };
}

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

    // Optional comma-separated Project.status filter. Intersected against
    // OPEN_PROJECT_STATUSES so it can only narrow the default open-jobs view,
    // never widen it (e.g. can't be used to pull Closed Complete/Lost jobs here).
    const statusParam = new URL(req.url).searchParams.get("status");
    const requestedStatuses = statusParam
        ? statusParam.split(",").map(s => s.trim()).filter(s => OPEN_PROJECT_STATUSES.includes(s))
        : null;
    if (requestedStatuses && requestedStatuses.length === 0) {
        return NextResponse.json({ error: "invalid status filter" }, { status: 400 });
    }
    const statusFilter = requestedStatuses ?? OPEN_PROJECT_STATUSES;

    const projects = await prisma.project.findMany({
        where: { status: { in: statusFilter } },
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

    if (body.leadId !== undefined && body.leadId !== null && typeof body.leadId !== "string") {
        return NextResponse.json({ error: "leadId must be a string" }, { status: 400 });
    }
    const leadId = typeof body.leadId === "string" && body.leadId.trim() ? body.leadId.trim() : null;

    // ─── Lead-linked creation: build the Project from an existing (unconverted)
    // Lead instead of a synthetic one. Lets Manage Jobs convert a ProBuild lead
    // directly instead of always spawning a fresh Project + throwaway "Won" Lead.
    //
    // Delegates to the canonical convertLeadToProject (src/lib/actions.ts) so the
    // conversion is complete — estimates, contracts, schedules, files, rooms, etc.
    // all get relinked to the new project the same way a web-side conversion does
    // (billing-core.ts's invoice flow reads estimate.projectId, so a lead-owned
    // estimate must actually be relinked to stay invoiceable). Mobile's body
    // overrides are applied as a follow-up update once the project exists. ───
    if (leadId) {
        // MANAGERs may only convert leads they own; ADMINs bypass. 404s if the
        // lead doesn't exist at all — same helper the mobile lead routes use.
        const accessError = await assertLeadAccess(user, leadId);
        if (accessError) return accessError;

        const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { location: true } });

        // Project.leadId is @unique — a lead can only ever back one project.
        const existingProject = await prisma.project.findUnique({
            where: { leadId },
            select: { id: true, name: true },
        });
        if (existingProject) {
            return NextResponse.json(
                { error: `Lead is already linked to project "${existingProject.name}" (${existingProject.id})` },
                { status: 409 }
            );
        }

        const geo = parseGeoFields(body);
        if ("error" in geo) return geo.error;
        let { locationLat, locationLng } = geo;
        // A lone coordinate must not get paired with a lat/lng geocoded from a
        // different address — coords are all-or-nothing on this path.
        if ((locationLat === null) !== (locationLng === null)) {
            return NextResponse.json(
                { error: "locationLat and locationLng must be provided together" },
                { status: 400 }
            );
        }

        // The session-free core, not the actions.ts server action: this route
        // authenticates a mobile token OR a web session and then runs
        // assertLeadAccess above, and the action's gate assumes a NextAuth staff
        // session — which a mobile-token caller does not have.
        const { convertLeadToProjectCore } = await import("@/lib/lead-conversion-core");
        let projectId: string;
        try {
            const result = await convertLeadToProjectCore(leadId);
            projectId = result.id;
        } catch (e: any) {
            // Two concurrent requests can both pass the precheck above; the loser
            // hits Project.leadId's unique constraint inside the conversion's
            // transaction. Map that race to the same 409 the precheck returns.
            if (e?.code === "P2002") {
                const conflict = await prisma.project.findUnique({ where: { leadId }, select: { id: true, name: true } });
                return NextResponse.json(
                    {
                        error: conflict
                            ? `Lead is already linked to project "${conflict.name}" (${conflict.id})`
                            : "Lead is already linked to a project",
                    },
                    { status: 409 }
                );
            }
            throw e;
        }

        const projectShape = {
            id: true,
            name: true,
            status: true,
            location: true,
            locationLat: true,
            locationLng: true,
            geofenceRadiusMeters: true,
            clientId: true,
        } as const;

        // Overrides are best-effort on top of an already-committed conversion: if
        // anything below fails, return the converted project instead of a 500 —
        // otherwise the client is stranded (this request 500s, a retry 409s).
        try {
            // No coords from the request — geocode an address so the new project
            // still gets a usable geofence center. The request's own location
            // override wins over the lead's old address; fail-soft either way.
            const overrideLocation =
                typeof body.location === "string" && body.location.trim() ? body.location.trim() : null;
            if (locationLat === null && locationLng === null) {
                const addressToGeocode = overrideLocation ?? lead?.location ?? null;
                if (addressToGeocode) {
                    const geocoded = await geocodeJobSiteAddress(addressToGeocode);
                    if (geocoded?.lat != null && geocoded?.lng != null) {
                        locationLat = geocoded.lat;
                        locationLng = geocoded.lng;
                    }
                }
            }

            // Apply mobile's overrides on top of the conversion's result.
            const overrides: Record<string, unknown> = { geofenceRadiusMeters: geo.radius };
            if (typeof body.name === "string" && body.name.trim()) overrides.name = body.name.trim();
            if (overrideLocation) overrides.location = overrideLocation;
            if (locationLat !== null) overrides.locationLat = locationLat;
            if (locationLng !== null) overrides.locationLng = locationLng;

            const updated = await prisma.project.update({
                where: { id: projectId },
                data: overrides,
                select: projectShape,
            });
            return NextResponse.json(updated);
        } catch (e) {
            console.error("[manager/jobs] lead conversion succeeded but overrides failed:", e);
            const project = await prisma.project.findUnique({ where: { id: projectId }, select: projectShape });
            return NextResponse.json(project);
        }
    }

    // ─── Plain creation (unchanged): no leadId means mobile only needs the
    // minimum-viable Project. Lead linkage/estimates otherwise happen on the web. ───
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

    const geo = parseGeoFields(body);
    if ("error" in geo) return geo.error;
    const { locationLat, locationLng, radius } = geo;

    const created = await prisma.project.create({
        data: {
            name,
            clientId,
            // Every project birth lands in the pipeline's pre-work stage.
            status: "Waiting to Start",
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

    // Maintain the 1-1 Project↔Lead invariant — the web app relies on every project
    // having a backing lead. Create one and link it (no client-facing side effects).
    const jobLead = await prisma.lead.create({
        data: {
            name,
            clientId,
            location: typeof body.location === "string" ? body.location : null,
            source: "Direct project (mobile)",
            stage: "Won",
            isUnread: false,
        },
    });
    await prisma.project.update({ where: { id: created.id }, data: { leadId: jobLead.id } });

    // Auto-grant access to eligible team members
    const { autoGrantProjectAccessToEligibleUsers } = await import("@/lib/auto-grant-project-access");
    await autoGrantProjectAccessToEligibleUsers(created.id);

    return NextResponse.json(created);
}
