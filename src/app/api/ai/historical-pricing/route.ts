import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { estimateId, query } = body as {
            estimateId?: string;
            query?: string;
        };

        // Fetch all estimate items across all projects with their relations
        const allItems = await prisma.estimateItem.findMany({
            where: { parentId: null }, // top-level items only (skip sub-items to avoid double-counting)
            include: {
                estimate: {
                    select: {
                        id: true, code: true, title: true, status: true, totalAmount: true,
                        project: { select: { id: true, name: true, type: true, status: true } },
                    },
                },
                costCode: { select: { id: true, name: true, code: true } },
                costType: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        if (allItems.length === 0) {
            return NextResponse.json({
                success: true,
                analysis:
                    "No historical pricing data found yet. As you create more estimates across projects, this tool will analyze your pricing patterns, average costs by category, markup trends, and give you recommendations for competitive yet profitable pricing.",
            });
        }

        // Aggregate pricing data by item type / category
        const categoryMap: Record<
            string,
            {
                count: number;
                totalCost: number;
                totalUnitCost: number;
                markups: number[];
                names: string[];
                projectTypes: string[];
            }
        > = {};

        for (const item of allItems) {
            const category = item.type || "Uncategorized";
            if (!categoryMap[category]) {
                categoryMap[category] = {
                    count: 0,
                    totalCost: 0,
                    totalUnitCost: 0,
                    markups: [],
                    names: [],
                    projectTypes: [],
                };
            }
            const entry = categoryMap[category];
            entry.count++;
            entry.totalCost += Number(item.total) || 0;
            entry.totalUnitCost += Number(item.unitCost) || 0;
            entry.markups.push(item.markupPercent || 0);
            if (!entry.names.includes(item.name)) {
                entry.names.push(item.name);
            }
            const pType = item.estimate?.project?.type;
            if (pType && !entry.projectTypes.includes(pType)) {
                entry.projectTypes.push(pType);
            }
        }

        // Build summary for Claude
        const categorySummaries = Object.entries(categoryMap).map(
            ([cat, data]) => ({
                category: cat,
                itemCount: data.count,
                averageCost: data.totalCost / data.count,
                averageUnitCost: data.totalUnitCost / data.count,
                averageMarkup:
                    data.markups.reduce((a, b) => a + b, 0) / data.markups.length,
                minMarkup: Math.min(...data.markups),
                maxMarkup: Math.max(...data.markups),
                sampleItems: data.names.slice(0, 10),
                projectTypes: data.projectTypes.slice(0, 5),
            })
        );

        // If estimateId provided, include current estimate context
        let currentEstimateContext = "";
        if (estimateId) {
            const currentEstimate = await prisma.estimate.findUnique({
                where: { id: estimateId },
                select: {
                    id: true, code: true, title: true, status: true,
                    totalAmount: true, balanceDue: true, createdAt: true, projectId: true,
                    items: { orderBy: { order: "asc" }, select: { name: true, type: true, quantity: true, unitCost: true, total: true, markupPercent: true } },
                    project: {
                        select: { name: true, type: true, location: true },
                    },
                },
            });
            if (currentEstimate) {
                currentEstimateContext = `
Current Estimate: "${currentEstimate.title}" (${currentEstimate.project?.type || "General"} project)
Location: ${currentEstimate.project?.location || "Not specified"}
Current items: ${currentEstimate.items
                    .map(
                        (i) =>
                            `${i.name} (${i.type}) - qty: ${i.quantity}, unit: $${Number(i.unitCost).toFixed(2)}, total: $${Number(i.total).toFixed(2)}, markup: ${i.markupPercent}%`
                    )
                    .join("; ")}
Total estimate: $${currentEstimate.items.reduce((sum, i) => sum + (Number(i.total) || 0), 0).toFixed(2)}
`;
            }
        }

        const prompt = `Analyze historical pricing data from this contractor's past projects. Provide: average costs by category, markup patterns, price trends, and recommendations for competitive yet profitable pricing.

Historical Data Summary (${allItems.length} total line items across all projects):
${JSON.stringify(categorySummaries, null, 2)}

${currentEstimateContext}
${query ? `User's specific question: ${query}` : ""}

Format your response in clear sections with headers. Use dollar amounts and percentages. Be specific and actionable. If there is a current estimate, compare its pricing to historical averages and flag any items that are significantly above or below typical costs.`;

        const anthropic = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
        });

        const message = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 2048,
            messages: [
                {
                    role: "user",
                    content: prompt,
                },
            ],
        });

        const analysis =
            message.content[0].type === "text"
                ? message.content[0].text
                : "Unable to generate analysis.";

        return NextResponse.json({ success: true, analysis });
    } catch (error: any) {
        console.error("Historical pricing error:", error);
        return NextResponse.json(
            {
                success: false,
                error: error.message || "Failed to analyze historical pricing",
            },
            { status: 500 }
        );
    }
}
