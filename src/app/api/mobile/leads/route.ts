// /api/mobile/leads — lead intake from the field app.
// GET: leads the caller can work (ADMIN: all active; others: leads they manage).
// POST: create a lead (+client, + optional first note) and kick off its Drive folder.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { ensureLeadFolder, isDriveConnected } from "@/lib/lead-drive";
import { geocodeJobSiteAddress } from "@/lib/geocode";

export const dynamic = "force-dynamic";

function canWorkLeads(role: string) {
    return role === "ADMIN" || role === "MANAGER";
}

export async function GET(req: NextRequest) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    if (!canWorkLeads(user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const leads = await prisma.lead.findMany({
        where: {
            isArchived: false,
            ...(user.role === "ADMIN" ? {} : { managerId: user.id }),
        },
        orderBy: { lastActivityAt: "desc" },
        take: 100,
        select: {
            id: true,
            number: true,
            name: true,
            stage: true,
            location: true,
            projectType: true,
            lastActivityAt: true,
            driveFolderUrl: true,
            client: { select: { name: true, primaryPhone: true } },
            // Mobile Manage Jobs shows unconverted leads and lets a manager convert
            // one directly (POST /api/manager/jobs with leadId) — it needs to know
            // whether that lead already has a linked project (Project.leadId is @unique).
            project: { select: { id: true } },
        },
    });
    return NextResponse.json({
        leads: leads.map(({ project, ...lead }) => ({
            ...lead,
            hasProject: !!project,
            projectId: project?.id ?? null,
        })),
    });
}

export async function POST(req: NextRequest) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    if (!canWorkLeads(user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let body: {
        clientName?: unknown;
        clientPhone?: unknown;
        clientEmail?: unknown;
        name?: unknown;
        projectType?: unknown;
        location?: unknown;
        note?: unknown;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const clientName = typeof body.clientName === "string" ? body.clientName.trim() : "";
    if (clientName.length < 2) {
        return NextResponse.json({ error: "Client name is required" }, { status: 400 });
    }
    const clientEmail = typeof body.clientEmail === "string" && body.clientEmail.includes("@")
        ? body.clientEmail.trim()
        : null;
    const clientPhone = typeof body.clientPhone === "string" ? body.clientPhone.trim() || null : null;
    const projectType = typeof body.projectType === "string" ? body.projectType.trim() || null : null;
    const rawLocation = typeof body.location === "string" ? body.location.trim() || null : null;
    // Mobile intake bypasses the web form's Places autocomplete entirely —
    // normalize server-side (fail-soft keeps the raw string).
    const location = (await geocodeJobSiteAddress(rawLocation))?.formattedAddress ?? rawLocation;
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const leadName = (typeof body.name === "string" && body.name.trim())
        || `${clientName}${projectType ? ` - ${projectType}` : ""}`;

    // Reuse an existing client on exact email match; otherwise create one.
    const existing = clientEmail
        ? await prisma.client.findFirst({ where: { email: clientEmail }, select: { id: true } })
        : null;
    const client = existing
        ?? (await prisma.client.create({
            data: {
                name: clientName,
                initials: clientName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase(),
                email: clientEmail,
                primaryPhone: clientPhone,
            },
            select: { id: true },
        }));

    const lead = await prisma.lead.create({
        data: {
            name: leadName.slice(0, 120),
            clientId: client.id,
            stage: "New",
            source: "Mobile intake",
            projectType,
            location,
            managerId: user.id,
            isUnread: false,
            ...(note
                ? { notes: { create: { content: note.slice(0, 4000), createdBy: user.name ?? user.email } } }
                : {}),
        },
        select: { id: true, number: true, name: true },
    });

    // Drive folder: best-effort - lead creation must not fail when Drive is
    // disconnected or slow. The folder also self-heals on first media upload.
    let driveFolderUrl: string | null = null;
    if (await isDriveConnected()) {
        try {
            driveFolderUrl = (await ensureLeadFolder(lead.id)).url;
        } catch (e) {
            console.error("[mobile/leads] Drive folder create failed:", e instanceof Error ? e.message : e);
        }
    }

    return NextResponse.json({ lead: { ...lead, driveFolderUrl } }, { status: 201 });
}
