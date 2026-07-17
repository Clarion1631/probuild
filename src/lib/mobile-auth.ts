import { jwtVerify, SignJWT } from "jose";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { User } from "@prisma/client";

// Fail fast if the signing secret is missing — never sign or verify with empty key.
const SECRET_RAW = process.env.NEXTAUTH_SECRET;
if (!SECRET_RAW) {
    throw new Error("NEXTAUTH_SECRET must be set; mobile JWTs cannot be issued/verified without it.");
}
const JWT_SECRET = new TextEncoder().encode(SECRET_RAW);

// Class binding: mobile tokens are tagged so they can't be confused with NextAuth JWTs
// (which use the same secret) or any future tokens we mint.
const MOBILE_TOKEN_ISSUER = "probuild";
const MOBILE_TOKEN_AUDIENCE = "probuild-mobile";

export const MOBILE_TOKEN_EXPIRY_GOOGLE = "7d";
export const MOBILE_TOKEN_EXPIRY_PIN = "24h";

export type MobileTokenVia = "google" | "pin";

export type MobileTokenClaims = {
    sub: string;
    role: string;
    email?: string;
    via: MobileTokenVia;
};

export async function signMobileToken(
    user: Pick<User, "id" | "role" | "email">,
    via: MobileTokenVia
): Promise<string> {
    const exp = via === "google" ? MOBILE_TOKEN_EXPIRY_GOOGLE : MOBILE_TOKEN_EXPIRY_PIN;
    return new SignJWT({ role: user.role, email: user.email, via })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.id)
        .setIssuer(MOBILE_TOKEN_ISSUER)
        .setAudience(MOBILE_TOKEN_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(JWT_SECRET);
}

async function verifyMobileToken(token: string): Promise<MobileTokenClaims | null> {
    try {
        const { payload } = await jwtVerify(token, JWT_SECRET, {
            algorithms: ["HS256"],
            issuer: MOBILE_TOKEN_ISSUER,
            audience: MOBILE_TOKEN_AUDIENCE,
        });
        if (typeof payload.sub !== "string" || typeof payload.role !== "string") return null;
        if (payload.via !== "google" && payload.via !== "pin") return null;
        return {
            sub: payload.sub,
            role: payload.role,
            email: typeof payload.email === "string" ? payload.email : undefined,
            via: payload.via,
        };
    } catch {
        return null;
    }
}

export type MobileAuthResult =
    | { ok: true; user: User; via: "mobile-jwt" | "next-auth"; claims?: MobileTokenClaims }
    | { ok: false; status: number; error: string };

/**
 * Hybrid authenticator for routes shared between the mobile app and the web UI.
 *
 * If `Authorization: Bearer <token>` is present it MUST verify — no fall-through to
 * NextAuth on a malformed/expired token. Otherwise, fall back to a NextAuth session.
 * This makes auth source explicit; no silent ambiguity between mobile and web.
 */
export async function authenticateMobileOrSession(req: Request): Promise<MobileAuthResult> {
    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice("Bearer ".length).trim();
        if (!token) return { ok: false, status: 401, error: "Empty bearer token" };
        const claims = await verifyMobileToken(token);
        if (!claims) return { ok: false, status: 401, error: "Invalid or expired token" };
        const user = await prisma.user.findUnique({ where: { id: claims.sub } });
        if (!user) return { ok: false, status: 401, error: "User not found" };
        if (user.status === "DISABLED") return { ok: false, status: 403, error: "Account disabled" };
        return { ok: true, user, via: "mobile-jwt", claims };
    }

    const session = await getServerSession(authOptions);
    if (session?.user?.email) {
        const user = await prisma.user.findUnique({
            where: { email: session.user.email.toLowerCase() },
        });
        if (!user) return { ok: false, status: 401, error: "User not found" };
        if (user.status === "DISABLED") return { ok: false, status: 403, error: "Account disabled" };
        return { ok: true, user, via: "next-auth" };
    }

    return { ok: false, status: 401, error: "Unauthorized" };
}

/**
 * Mobile-only authenticator. Use on routes that should NEVER accept a browser session
 * (e.g. /api/mobile/me).
 */
export async function authenticateMobileOnly(req: Request): Promise<MobileAuthResult> {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return { ok: false, status: 401, error: "Missing bearer token" };
    }
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) return { ok: false, status: 401, error: "Empty bearer token" };
    const claims = await verifyMobileToken(token);
    if (!claims) return { ok: false, status: 401, error: "Invalid or expired token" };
    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user) return { ok: false, status: 401, error: "User not found" };
    if (user.status === "DISABLED") return { ok: false, status: 403, error: "Account disabled" };
    return { ok: true, user, via: "mobile-jwt", claims };
}

export function userHasRole(user: Pick<User, "role">, roles: string[]): boolean {
    return roles.includes(user.role);
}

const FULL_ACCESS_ROLES = ["ADMIN", "MANAGER"];

/**
 * ADMIN/MANAGER always pass. Others must have either a `ProjectAccess` row OR be on
 * the project's crew assignment list (matches the fallback used by GET /api/projects).
 */
export async function userCanAccessProject(
    user: Pick<User, "id" | "role">,
    projectId: string
): Promise<boolean> {
    if (FULL_ACCESS_ROLES.includes(user.role)) return true;

    const access = await prisma.projectAccess.findFirst({
        where: { userId: user.id, projectId },
        select: { id: true },
    });
    if (access) return true;

    const crew = await prisma.project.findFirst({
        where: { id: projectId, crew: { some: { id: user.id } } },
        select: { id: true },
    });
    return !!crew;
}

/**
 * Returns null on success, or a 403 NextResponse on failure. Usage:
 *   const fail = await assertProjectAccess(user, projectId);
 *   if (fail) return fail;
 */
export async function assertProjectAccess(
    user: Pick<User, "id" | "role">,
    projectId: string
): Promise<NextResponse | null> {
    const ok = await userCanAccessProject(user, projectId);
    if (ok) return null;
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
