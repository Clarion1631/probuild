import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const subs = await prisma.subcontractor.findMany({
            orderBy: { companyName: 'asc' }
        });

        return NextResponse.json(subs);
    } catch (error: any) {
        console.error("GET /api/subcontractors error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const body = await req.json();
        const { companyName, contactName, email, phone, trade, licenseNumber } = body;

        if (!companyName || !email) {
            return NextResponse.json({ error: "Company name and email are required" }, { status: 400 });
        }

        const existing = await prisma.subcontractor.findUnique({
            where: { email }
        });

        if (existing) {
            return NextResponse.json({ error: "A subcontractor with this email already exists" }, { status: 400 });
        }

        const sub = await prisma.subcontractor.create({
            data: {
                companyName,
                contactName,
                email,
                phone,
                trade,
                licenseNumber,
                status: "ACTIVE"
            }
        });

        return NextResponse.json(sub);
    } catch (error: any) {
        console.error("POST /api/subcontractors error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
