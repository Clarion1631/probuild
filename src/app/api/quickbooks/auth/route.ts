import { NextResponse } from "next/server";

const QB_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const SCOPES = "com.intuit.quickbooks.accounting";

export async function GET() {
    const clientId = process.env.QB_CLIENT_ID;
    if (!clientId) {
        return NextResponse.json({ error: "QB_CLIENT_ID not configured in Vercel" }, { status: 500 });
    }

    const baseUrl = process.env.NEXTAUTH_URL || "https://probuild-amber.vercel.app";
    const redirectUri = `${baseUrl}/api/quickbooks/callback`;

    // Cryptographically random state to prevent CSRF
    const state = crypto.randomUUID();

    const url = new URL(QB_AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("state", state);

    const response = NextResponse.redirect(url.toString());
    response.cookies.set("qb_oauth_state", state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 10, // 10 minutes
    });
    return response;
}
