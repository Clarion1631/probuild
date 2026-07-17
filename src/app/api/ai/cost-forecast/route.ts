import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAnthropicText } from "@/lib/anthropic";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

    const { projectId } = await req.json();
    if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

    const [project, estimates, timeEntries, expenses, purchaseOrders] = await Promise.all([
        prisma.project.findUnique({
            where: { id: projectId },
            include: { client: true },
        }),
        prisma.estimate.findMany({
            where: { projectId },
            select: {
                id: true, code: true, title: true, status: true,
                totalAmount: true, balanceDue: true, createdAt: true, projectId: true,
                items: { where: { parentId: null }, select: { name: true, type: true, total: true, unitCost: true, quantity: true } },
            },
        }),
        prisma.timeEntry.findMany({
            where: { projectId },
            select: { durationHours: true, laborCost: true, burdenCost: true },
        }),
        prisma.expense.findMany({
            where: { estimate: { is: { projectId } } },
            select: { amount: true, vendor: true, status: true },
        }),
        prisma.purchaseOrder.findMany({
            where: { projectId },
            include: { items: true },
        }),
    ]);

    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const APPROVED_STATUSES = ["Approved", "Invoiced", "Partially Paid", "Paid"];
    const approvedEstimate = estimates.find(e => APPROVED_STATUSES.includes(e.status)) || estimates[0];
    const budget = Number(approvedEstimate?.totalAmount || 0);
    const totalHours = timeEntries.reduce((s, e) => s + (e.durationHours || 0), 0);
    const laborActual = timeEntries.reduce((s, e) => s + Number(e.laborCost || 0) + Number(e.burdenCost || 0), 0);
    const expenseActual = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const poCommitted = purchaseOrders.reduce((s, po) => s + Number(po.totalAmount || 0), 0);
    const totalActual = laborActual + expenseActual;

    const context = `
Project: ${project.name} (${project.type || "General"})
Client: ${project.client?.name}
Status: ${project.status}

Budget (approved estimate): $${budget.toLocaleString()}
Actual costs to date: $${totalActual.toLocaleString()}
  - Labor: $${laborActual.toLocaleString()} (${totalHours.toFixed(0)} hours)
  - Expenses: $${expenseActual.toLocaleString()}
Committed (open POs): $${poCommitted.toLocaleString()}
Total exposed: $${(totalActual + poCommitted).toLocaleString()}
Remaining budget: $${(budget - totalActual - poCommitted).toLocaleString()}
Budget consumed: ${budget > 0 ? Math.round(((totalActual + poCommitted) / budget) * 100) : 0}%

Estimate line items:
${(approvedEstimate?.items || []).map(i => `- ${i.name}: $${Number(i.total).toLocaleString()} (${i.type})`).join("\n") || "None"}
`;

    const prompt = `You are an expert construction project cost analyst for a residential remodeling company in Vancouver, WA.

Analyze this project's cost data and forecast the final cost at completion.

${context}

Provide your analysis in this exact format:

FORECAST AT COMPLETION: $[amount]
BUDGET STATUS: [Under Budget | On Budget | At Risk | Over Budget]
VARIANCE: [+/- $amount] ([+/- X]%)

COST DRIVERS (top issues impacting cost):
- [driver 1 with estimated impact]
- [driver 2]
- [driver 3]

OVERRUN RISKS:
- [risk 1: description and probability]
- [risk 2]

SAVINGS OPPORTUNITIES:
- [opportunity 1]
- [opportunity 2]

RECOMMENDED ACTIONS:
1. [specific action to control costs]
2. [action 2]
3. [action 3]`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
    });
    const analysis = getAnthropicText(response.content);

    return NextResponse.json({ success: true, analysis, budget, actualToDate: totalActual, committed: poCommitted });
}
