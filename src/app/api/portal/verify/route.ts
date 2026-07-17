import { NextRequest, NextResponse } from "next/server";
import { verifyClientPortalToken } from "@/lib/client-portal-auth";

export async function GET(req: NextRequest) {
    const token = req.nextUrl.searchParams.get("token");

    if (!token) {
        return NextResponse.redirect(new URL("/portal?error=missing_token", req.url));
    }

    const payload = await verifyClientPortalToken(token);
    if (!payload) {
        return NextResponse.redirect(new URL("/portal?error=invalid_token", req.url));
    }

    const rawNext = req.nextUrl.searchParams.get("next") || "/portal";
    // Open-redirect guard: only allow same-origin paths under /portal. Anything
    // else (absolute URLs, //host, /portalish, /portal/../escape) falls back to /portal.
    const candidate = new URL(rawNext, req.url);
    const isSafeNext =
        candidate.origin === req.nextUrl.origin &&
        (candidate.pathname === "/portal" || candidate.pathname.startsWith("/portal/"));
    const resolved = new URL(isSafeNext ? candidate.pathname + candidate.search : "/portal", req.url);

    const response = NextResponse.redirect(resolved);
    response.cookies.set("client_portal_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
    });

    return response;
}
