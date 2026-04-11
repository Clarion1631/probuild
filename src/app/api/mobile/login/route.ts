import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";

export const dynamic = 'force-dynamic';

const JWT_SECRET = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
const TOKEN_EXPIRY = "24h";

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { email, pinCode } = body;

        if (!email || !pinCode) {
            return NextResponse.json({ error: "Email and PIN are required" }, { status: 400 });
        }

        const user = await prisma.user.findFirst({
            where: { email: email.toLowerCase() }
        });

        // Use bcrypt.compare for constant-time PIN verification
        const pinValid = user?.pinCode ? await bcrypt.compare(pinCode, user.pinCode) : false;
        if (!user || !pinValid || user.status === "DISABLED") {
            return NextResponse.json({ error: "Invalid email or PIN" }, { status: 401 });
        }

        const token = await new SignJWT({ sub: user.id, role: user.role })
            .setProtectedHeader({ alg: "HS256" })
            .setIssuedAt()
            .setExpirationTime(TOKEN_EXPIRY)
            .sign(JWT_SECRET);

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
