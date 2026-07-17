import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// TestFlight crash intake. Gated by a shared secret header so random traffic
// can't create Clients/Leads — the mobile app sends x-crash-key with every
// report. Fail loud (401) when the env is missing rather than falling back.

const MAX_FIELD = 200;
const MAX_STACK = 8_000;

export async function POST(req: NextRequest) {
    const secret = process.env.CRASH_LOG_INGEST_SECRET;
    if (!secret || req.headers.get("x-crash-key") !== secret) {
        return NextResponse.json({ success: false, reason: "unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const message = String(body.message ?? "Unknown crash").slice(0, MAX_FIELD);
        const stack = String(body.stack ?? "").slice(0, MAX_STACK);
        const isFatal = Boolean(body.isFatal);
        const deviceModel = String(body.deviceModel ?? "Unknown").slice(0, MAX_FIELD);
        const osVersion = String(body.osVersion ?? "Unknown").slice(0, MAX_FIELD);
        const emailAddress = String(body.emailAddress ?? "Unknown").slice(0, MAX_FIELD);

        console.error("TestFlight Crash Received:", {
            message,
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
                name: `Crash: ${message.slice(0, 100)}`,
                clientId: client.id,
                stage: "New",
                projectType: `Device: ${deviceModel} | OS: ${osVersion}`,
                location: `User: ${emailAddress}`,
                tags: "CRASH_LOG",
            },
        });

        // 3. Keep the latest stack on the shared crash client for quick triage
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
