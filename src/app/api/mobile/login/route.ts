import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { signMobileToken } from "@/lib/mobile-auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { email, pinCode } = body;

        if (!email || !pinCode) {
            return NextResponse.json({ error: "Email and PIN are required" }, { status: 400 });
        }

        // Throttle PIN guessing: short numeric PINs are brute-forceable. Cap attempts per
        // email+IP. (In-memory / per-instance — see lib/rate-limit caveat.)
        const rl = rateLimit(`pin-login:${String(email).toLowerCase()}:${clientIp(req)}`, 8, 10 * 60 * 1000);
        if (!rl.allowed) {
            return NextResponse.json(
                { error: "Too many login attempts. Please wait a few minutes and try again." },
                { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
            );
        }

        const user = await prisma.user.findFirst({
            where: { email: email.toLowerCase() }
        });

        // Constant-time PIN verification (only meaningful when user.pinCode is set)
        const pinValid = user?.pinCode ? await bcrypt.compare(pinCode, user.pinCode) : false;
        if (!user || !pinValid || user.status === "DISABLED") {
            return NextResponse.json({ error: "Invalid email or PIN" }, { status: 401 });
        }

        // Mirror /api/mobile/google-login + NextAuth signIn callback: a successful first
        // sign-in flips PENDING -> ACTIVATED. Without this the PIN path is inconsistent
        // with Google and PENDING users would be silently auth'd without activation.
        if (user.status === "PENDING") {
            await prisma.user.update({ where: { id: user.id }, data: { status: "ACTIVATED" } });
        }

        const token = await signMobileToken(user, "pin");

        return NextResponse.json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role
            },
            token
        });
    } catch (error: any) {
        console.error("Mobile login error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
