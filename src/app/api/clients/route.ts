import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const clients = await prisma.client.findMany({
            orderBy: { name: 'asc' },
            include: {
                projects: true,
                leads: true,
            }
        });
        return NextResponse.json(clients);
    } catch (error) {
        console.error("Error fetching clients:", error);
        return NextResponse.json({ error: "Failed to fetch clients" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const data = await req.json();

        // Validation
        if (!data.name) {
            return NextResponse.json({ error: "Name is required" }, { status: 400 });
        }

        // Generate initials if not provided
        let initials = data.initials;
        if (!initials) {
            const parts = data.name.trim().split(' ');
            if (parts.length > 1) {
                initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
            } else if (parts.length === 1) {
                initials = parts[0].substring(0, 2).toUpperCase();
            } else {
                initials = "??";
            }
        }

        const client = await prisma.client.create({
            data: {
                name: data.name,
                initials,
                email: data.email,
                companyName: data.companyName,
                primaryPhone: data.primaryPhone,
                additionalEmail: data.additionalEmail,
                additionalPhone: data.additionalPhone,
                addressLine1: data.addressLine1,
                addressLine2: data.addressLine2,
                city: data.city,
                state: data.state,
                zipCode: data.zipCode,
                country: data.country,
                internalNotes: data.internalNotes,
            }
        });

        return NextResponse.json(client);
    } catch (error) {
        console.error("Error creating client:", error);
        return NextResponse.json({ error: "Failed to create client" }, { status: 500 });
    }
}
