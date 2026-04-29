import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { jwtVerify } from "jose";
import type { User } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccessProject } from "@/lib/permissions";

export const MOBILE_TOKEN_TYPE = "mobile-access";

export function getMobileJwtSecret(): Uint8Array {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
        throw new Error("NEXTAUTH_SECRET is not configured");
    }
    return new TextEncoder().encode(secret);
}

export type AuthFailure = NextResponse;
export type AuthedUser = User;
export type AuthResult = { user: AuthedUser } | { error: AuthFailure };

function unauthorized(message = "Unauthorized"): AuthFailure {
    return NextResponse.json({ error: message }, { status: 401 });
}

function forbidden(message = "Forbidden"): AuthFailure {
    return NextResponse.json({ error: message }, { status: 403 });
}

async function userFromBearer(authHeader: string | null): Promise<AuthedUser | null> {
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) return null;

    let secret: Uint8Array;
    try {
        secret = getMobileJwtSecret();
    } catch {
        return null;
    }

    try {
        const { payload } = await jwtVerify(token, secret, {
            algorithms: ["HS256"],
            requiredClaims: ["exp", "sub"],
        });

        // Reject any signed JWT minted for a different purpose (sub/client portal tokens
        // are signed with the same secret but use different shapes; refuse them outright).
        if (payload.typ !== MOBILE_TOKEN_TYPE) return null;

        const userId = typeof payload.sub === "string" ? payload.sub : null;
        if (!userId) return null;

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.status === "DISABLED") return null;
        return user;
    } catch {
        return null;
    }
}

async function userFromSession(): Promise<AuthedUser | null> {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) return null;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.status === "DISABLED") return null;
    return user;
}

/**
 * Authenticate a request using either a mobile JWT (Authorization: Bearer)
 * or an active NextAuth web session. Returns `{ user }` on success or
 * `{ error }` (a NextResponse) on failure. Routes used by both the mobile
 * client and the web app should call this.
 */
export async function authenticateMobileOrSession(req: Request): Promise<AuthResult> {
    const bearerUser = await userFromBearer(req.headers.get("authorization"));
    if (bearerUser) return { user: bearerUser };

    const sessionUser = await userFromSession();
    if (sessionUser) return { user: sessionUser };

    return { error: unauthorized() };
}

/**
 * Authenticate a request using only a mobile JWT (Authorization: Bearer).
 * Use for endpoints that exist exclusively for the mobile app.
 */
export async function authenticateMobileOnly(req: Request): Promise<AuthResult> {
    const bearerUser = await userFromBearer(req.headers.get("authorization"));
    if (bearerUser) return { user: bearerUser };
    return { error: unauthorized() };
}

/** True if the user holds any of the listed roles. */
export function userHasRole(user: AuthedUser, roles: string[]): boolean {
    return roles.includes(user.role);
}

/**
 * Confirm the user can read/write a given project. Admins and managers
 * see everything; field crew + finance must have a `ProjectAccess` row
 * or be on the `crew` assignment list. Returns null on success or a
 * NextResponse error to short-circuit the route.
 */
export async function assertProjectAccess(
    user: AuthedUser,
    projectId: string,
): Promise<AuthFailure | null> {
    if (!projectId) return NextResponse.json({ error: "Project id required" }, { status: 400 });

    if (userHasRole(user, ["ADMIN", "MANAGER"])) return null;

    const access = await prisma.projectAccess.findUnique({
        where: { userId_projectId: { userId: user.id, projectId } },
    });
    if (access) return null;

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, crew: { where: { id: user.id }, select: { id: true } } },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.crew.length > 0) return null;

    if (canAccessProject({ role: user.role, projectAccess: [] }, projectId)) return null;

    return forbidden("You do not have access to this project");
}
