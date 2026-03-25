import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// POST /api/takeoffs/convert-to-estimate
// Converts AI-generated takeoff data into a real Estimate with line items
export async function POST(req: NextRequest) {
    const body = await req.json();
    const { takeoffId } = body;

    if (!takeoffId) {
        return NextResponse.json({ error: "takeoffId is required" }, { status: 400 });
    }

    const takeoff = await prisma.takeoff.findUnique({
        where: { id: takeoffId },
        include: { files: true },
    });

    if (!takeoff) {
        return NextResponse.json({ error: "Takeoff not found" }, { status: 404 });
    }

    if (!takeoff.aiEstimateData) {
        return NextResponse.json({ error: "No AI estimate data to convert. Generate an AI estimate first." }, { status: 400 });
    }

    // Parse the AI estimate data
    let aiData: any;
    try {
        aiData = JSON.parse(takeoff.aiEstimateData);
    } catch {
        return NextResponse.json({ error: "Invalid AI estimate data" }, { status: 400 });
    }

    const items = aiData.items || [];
    const milestones = aiData.paymentMilestones || [];
    const totalEstimate = aiData.totalEstimate || items.reduce((s: number, i: any) => s + (i.total || 0), 0);

    const code = `EST-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        // Create the Estimate
        const estimate = await prisma.estimate.create({
            data: {
                title: `${takeoff.name} — AI Estimate`,
                projectId: takeoff.projectId || null,
                leadId: takeoff.leadId || null,
                code,
                status: "Draft",
                totalAmount: totalEstimate,
                balanceDue: totalEstimate,
                privacy: "Shared",
            },
        });

        // Create all estimate line items
        for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx];
            await prisma.estimateItem.create({
                data: {
                    estimateId: estimate.id,
                    name: item.name || "Unnamed Item",
                    description: item.description || "",
                    type: item.type || item.costType || "Material",
                    quantity: parseFloat(item.quantity) || 1,
                    unitCost: parseFloat(item.unitCost) || 0,
                    total: parseFloat(item.total) || 0,
                    order: idx,
                    parentId: null,
                    costCodeId: item.costCodeId || null,
                    costTypeId: item.costTypeId || null,
                },
            });
        }

        // Create payment schedules
        for (let idx = 0; idx < milestones.length; idx++) {
            const m = milestones[idx];
            await prisma.estimatePaymentSchedule.create({
                data: {
                    estimateId: estimate.id,
                    name: m.name || `Payment ${idx + 1}`,
                    percentage: parseFloat(m.percentage) || 0,
                    amount: parseFloat(m.amount) || 0,
                    dueDate: null,
                    order: idx,
                },
            });
        }

        // Link the takeoff to the new estimate
        await prisma.takeoff.update({
            where: { id: takeoffId },
            data: {
                estimateId: estimate.id,
                status: "Completed",
            },
        });

        // Build the redirect URL
        const redirectUrl = takeoff.projectId
            ? `/projects/${takeoff.projectId}/estimates/${estimate.id}`
            : `/leads/${takeoff.leadId}/estimates/${estimate.id}`;

        return NextResponse.json({
            estimateId: estimate.id,
            code: estimate.code,
            totalAmount: totalEstimate,
            itemCount: items.length,
            redirectUrl,
        });
    } catch (err: any) {
        console.error("Convert to Estimate error:", err);
        return NextResponse.json({ error: err.message || "Failed to create estimate" }, { status: 500 });
    }
}
