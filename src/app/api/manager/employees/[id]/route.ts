export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userHasRole } from "@/lib/mobile-auth";

type Params = { params: Promise<{ id: string }> };

const ALLOWED_ROLES = new Set(["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE"]);
const ALLOWED_STATUSES = new Set(["PENDING", "ACTIVATED", "DISABLED"]);

const MAX_RATE = new Prisma.Decimal("100000"); // sanity ceiling, $100k/hr is plenty

function parseDecimal(value: unknown, field: string): Prisma.Decimal | null | undefined | { error: string } {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "string" && typeof value !== "number") {
        return { error: `${field} must be a number or numeric string` };
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
        return { error: `${field} must be finite` };
    }
    try {
        const dec = new Prisma.Decimal(typeof value === "number" ? value.toString() : value);
        if (!dec.isFinite()) return { error: `${field} must be finite` };
        if (dec.isNegative()) return { error: `${field} must be >= 0` };
        if (dec.greaterThan(MAX_RATE)) return { error: `${field} exceeds maximum allowed` };
        return dec;
    } catch {
        return { error: `${field} is not a valid decimal` };
    }
}

/** ADMIN-only edits to role + rates + status. */
export async function PATCH(req: NextRequest, { params }: Params) {
    const auth = await authenticateMobileOrSession(req);
    if ("error" in auth) return auth.error;
    const { user } = auth;
    if (!userHasRole(user, ["ADMIN"])) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
        return NextResponse.json({ error: "Employee not found" }, { status: 404 });
    }

    const { role, hourlyRate, burdenRate, status } = body as {
        role?: string;
        hourlyRate?: string | number | null;
        burdenRate?: string | number | null;
        status?: string;
    };

    const data: Prisma.UserUpdateInput = {};

    if (role !== undefined) {
        if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
            return NextResponse.json({ error: `Invalid role: ${role}` }, { status: 400 });
        }
        data.role = role;
    }
    if (status !== undefined) {
        if (typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
            return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
        }
        data.status = status;
    }

    const hourly = parseDecimal(hourlyRate, "hourlyRate");
    if (hourly && typeof hourly === "object" && "error" in hourly) {
        return NextResponse.json({ error: hourly.error }, { status: 400 });
    }
    if (hourly !== undefined) data.hourlyRate = hourly ?? new Prisma.Decimal(0);

    const burden = parseDecimal(burdenRate, "burdenRate");
    if (burden && typeof burden === "object" && "error" in burden) {
        return NextResponse.json({ error: burden.error }, { status: 400 });
    }
    if (burden !== undefined) data.burdenRate = burden ?? new Prisma.Decimal(0);

    const updated = await prisma.user.update({
        where: { id },
        data,
        select: {
            id: true,
            email: true,
            name: true,
            role: true,
            status: true,
            hourlyRate: true,
            burdenRate: true,
        },
    });

    return NextResponse.json(JSON.parse(JSON.stringify(updated)));
}
