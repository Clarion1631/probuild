import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SignJWT } from "jose";
import { sendNotification } from "@/lib/email";

const JWT_SECRET = new TextEncoder().encode(
    process.env.SUB_PORTAL_SECRET || "sub-portal-dev-secret-change-me"
);

export async function POST(req: NextRequest) {
    try {
        const { email } = await req.json();

        if (!email) {
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        const sub = await prisma.subcontractor.findUnique({
            where: { email: email.toLowerCase() },
        });

        if (!sub) {
            // Don't reveal whether the email exists — always return success
            return NextResponse.json({ success: true });
        }

        if (sub.status !== "ACTIVE") {
            return NextResponse.json({ success: true });
        }

        // Generate JWT token with 24hr expiry
        const token = await new SignJWT({ subId: sub.id, email: sub.email })
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt()
            .setExpirationTime("24h")
            .sign(JWT_SECRET);

        const appUrl = process.env.NEXTAUTH_URL || "https://probuild-amber.vercel.app";
        const loginLink = `${appUrl}/api/sub-portal/verify?token=${token}`;

        // Send magic link email
        await sendNotification(
            sub.email,
            "Your Subcontractor Portal Login Link",
            `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Portal Access</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 0; color: #0f172a; }
                    .container { padding: 40px 20px; max-width: 600px; margin: 0 auto; }
                    .card { background-color: #ffffff; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); border: 1px solid #e2e8f0; }
                    .logo { width: 48px; height: 48px; background-color: #4c9a2a; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 24px; }
                    .logo svg { display: block; margin: auto; padding-top: 12px; }
                    h1 { font-size: 24px; font-weight: 700; margin: 0 0 16px; color: #0f172a; letter-spacing: -0.025em; }
                    p { font-size: 16px; line-height: 1.6; margin: 0 0 32px; color: #475569; }
                    .button { display: inline-block; background-color: #4c9a2a; color: #ffffff !important; font-weight: 600; font-size: 16px; text-decoration: none; padding: 14px 28px; border-radius: 8px; }
                    .footer { margin-top: 32px; font-size: 14px; color: #94a3b8; text-align: center; }
                    .note { font-size: 13px; color: #94a3b8; margin-top: 24px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="card">
                        <div class="logo">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/></svg>
                        </div>
                        <h1>Subcontractor Portal</h1>
                        <p>Hello ${sub.contactName || sub.companyName},<br><br>Click the button below to access your subcontractor portal. This link is valid for 24 hours.</p>
                        <a href="${loginLink}" class="button">Access Portal</a>
                        <p class="note">If you did not request this link, you can safely ignore this email.</p>
                    </div>
                    <div class="footer">
                        &copy; ${new Date().getFullYear()} ProBuild. All rights reserved.
                    </div>
                </div>
            </body>
            </html>
            `
        );

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("POST /api/sub-portal/login error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
