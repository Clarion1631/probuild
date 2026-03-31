import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const JWT_SECRET = new TextEncoder().encode(
    process.env.SUB_PORTAL_SECRET || "sub-portal-dev-secret-change-me"
);

export async function GET(req: NextRequest) {
    try {
        const token = req.nextUrl.searchParams.get("token");

        if (!token) {
            return NextResponse.redirect(new URL("/sub-portal/login?error=missing_token", req.url));
        }

        const { payload } = await jwtVerify(token, JWT_SECRET);

        if (!payload.subId || !payload.email) {
            return NextResponse.redirect(new URL("/sub-portal/login?error=invalid_token", req.url));
        }

        let nextUrl = req.nextUrl.searchParams.get("next") || "/sub-portal";
        if (!nextUrl.startsWith("/sub-portal")) nextUrl = "/sub-portal";

        // Set httpOnly cookie with the subcontractor ID
        const response = NextResponse.redirect(new URL(nextUrl, req.url));
        response.cookies.set("sub_portal_token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            path: "/",
            maxAge: 60 * 60 * 24, // 24 hours
        });

        return response;
    } catch (error: any) {
        console.error("GET /api/sub-portal/verify error:", error);
        return NextResponse.redirect(new URL("/sub-portal/login?error=expired_token", req.url));
    }
}
