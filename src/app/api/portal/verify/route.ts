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
    const resolved = new URL(rawNext, req.url);
    if (!resolved.pathname.startsWith("/portal")) resolved.pathname = "/portal";

    const response = NextResponse.redirect(resolved);
    response.cookies.set("client_portal_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
    });

    return response;
}
