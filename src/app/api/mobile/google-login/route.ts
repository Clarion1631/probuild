import { NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";
import { signMobileToken } from "@/lib/mobile-auth";

export const dynamic = "force-dynamic";

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

function audiences(): string[] {
    const ids = [
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_MOBILE_ANDROID_CLIENT_ID,
        process.env.GOOGLE_MOBILE_IOS_CLIENT_ID,
    ];
    return ids.filter((x): x is string => !!x && x.length > 0);
}

const oauthClient = new OAuth2Client();

export async function POST(req: Request) {
    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const idToken: string | undefined = body?.idToken;
    if (!idToken || typeof idToken !== "string") {
        return NextResponse.json({ error: "idToken required" }, { status: 400 });
    }

    const allowedAudiences = audiences();
    if (allowedAudiences.length === 0) {
        return NextResponse.json({ error: "Server OAuth not configured" }, { status: 500 });
    }

    let payload;
    try {
        const ticket = await oauthClient.verifyIdToken({
            idToken,
            audience: allowedAudiences,
        });
        payload = ticket.getPayload();
    } catch {
        return NextResponse.json({ error: "Invalid Google token" }, { status: 401 });
    }

    if (!payload) {
        return NextResponse.json({ error: "Invalid Google token" }, { status: 401 });
    }
    if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
        return NextResponse.json({ error: "Untrusted token issuer" }, { status: 401 });
    }
    if (!payload.email || payload.email_verified !== true) {
        return NextResponse.json({ error: "Email not verified by Google" }, { status: 401 });
    }

    const email = payload.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
        // Mirrors the NextAuth signIn callback policy: only pre-provisioned users can sign in.
        return NextResponse.json({ error: "AccessDenied" }, { status: 403 });
    }
    if (user.status === "DISABLED") {
        return NextResponse.json({ error: "AccessDenied" }, { status: 403 });
    }
    if (user.status === "PENDING") {
        await prisma.user.update({ where: { id: user.id }, data: { status: "ACTIVATED" } });
    }

    const token = await signMobileToken(user, "google");

    return NextResponse.json({
        token,
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
        },
    });
}
