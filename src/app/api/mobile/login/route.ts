import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { email, pinCode } = body;

        if (!email || !pinCode) {
            return NextResponse.json({ error: "Email and PIN are required" }, { status: 400 });
        }

        // Find user by email and PIN
        const user = await prisma.user.findFirst({
            where: {
                email: email.toLowerCase(),
                pinCode: pinCode
            }
        });

        if (!user) {
            return NextResponse.json({ error: "Invalid email or PIN" }, { status: 401 });
        }

        // Since we are moving away from Supabase, we need a way to authenticate mobile
        // requests. We will return a simple token/identifier for the mobile app to use.
        // In a production app this should be a proper JWT, but for now we'll return 
        // the user ID to be used in an 'Authorization' header as a simple bearer token.
        // We will accept requests where the Authorization header is just the user ID.

        return NextResponse.json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role
            },
            token: user.id // Simplistic token for Next.js API authorization
        });
    } catch (error: any) {
        console.error("Mobile login error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
