import { NextResponse } from "next/server";

const GUSTO_AUTH_URL = "https://api.gusto.com/oauth/authorize";
const SCOPES = "employees:read payrolls:read";

export async function GET() {
    const clientId = process.env.GUSTO_CLIENT_ID;
    if (!clientId) {
        return NextResponse.json({ error: "GUSTO_CLIENT_ID not configured in Vercel" }, { status: 500 });
    }

    const baseUrl = process.env.NEXTAUTH_URL || "https://probuild-amber.vercel.app";
    const redirectUri = `${baseUrl}/api/gusto/callback`;

    // Cryptographically random state to prevent CSRF
    const state = crypto.randomUUID();

    const url = new URL(GUSTO_AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);

    const response = NextResponse.redirect(url.toString());
    response.cookies.set("gusto_oauth_state", state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 10, // 10 minutes
    });
    return response;
}
