import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { message, stack, isFatal, deviceModel, osVersion, emailAddress } = body;

        console.error("TestFlight Crash Received:", {
            message,
            stack,
            isFatal,
            deviceModel,
            osVersion,
            emailAddress,
        });

        // 1. Find or create the special crash reporter client
        let client = await prisma.client.findFirst({
            where: { email: "crash@goldentouchremodeling.com" },
        });

        if (!client) {
            client = await prisma.client.create({
                data: {
                    name: "TestFlight Crash Reporter",
                    initials: "TC",
                    email: "crash@goldentouchremodeling.com",
                    primaryPhone: "555-0199",
                },
            });
        }

        // 2. Create a Lead to represent the crash report
        const lead = await prisma.lead.create({
            data: {
                name: `Crash: ${String(message).slice(0, 100)}`,
                clientId: client.id,
                stage: "New",
                projectType: `Device: ${deviceModel ?? "Unknown"} | OS: ${osVersion ?? "Unknown"}`,
                location: `User: ${emailAddress ?? "Unknown"}`,
                tags: "CRASH_LOG",
            },
        });

        // 3. Add the stack trace as a comment or note by creating a note/lead task or putting it in the client notes
        await prisma.client.update({
            where: { id: client.id },
            data: {
                internalNotes: `Latest Crash Stack:\n${stack}\n\nFatal: ${isFatal}\nTime: ${new Date().toISOString()}`,
            },
        });

        return NextResponse.json({ success: true, leadId: lead.id });
    } catch (err: any) {
        console.error("Failed to log crash:", err);
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
