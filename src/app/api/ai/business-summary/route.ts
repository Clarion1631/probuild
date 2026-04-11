import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAnthropicText } from "@/lib/anthropic";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [projects, estimates, invoices, leads, timeEntries, expenses] = await Promise.all([
        prisma.project.findMany({
            include: { client: true, estimates: { select: { totalAmount: true, status: true } } },
        }),
        prisma.estimate.findMany({
            where: { createdAt: { gte: thirtyDaysAgo } },
            select: { totalAmount: true, status: true, createdAt: true },
        }),
        prisma.invoice.findMany({
            select: {
                totalAmount: true,
                status: true,
                createdAt: true,
                payments: { select: { amount: true, status: true } },
            },
        }),
        prisma.lead.findMany({
            select: { stage: true, targetRevenue: true, createdAt: true },
        }),
        prisma.timeEntry.findMany({
            where: { startTime: { gte: thirtyDaysAgo } },
            select: { durationHours: true, laborCost: true, burdenCost: true },
        }),
        prisma.expense.findMany({
            where: { createdAt: { gte: thirtyDaysAgo } },
            select: { amount: true },
        }),
    ]);

    const activeProjects = projects.filter(p => p.status === "Active" || p.status === "In Progress");
    const totalPipeline = leads.reduce((s, l) => s + Number(l.targetRevenue || 0), 0);
    const wonLeads = leads.filter(l => l.stage === "Won");
    const totalRevenue = invoices.reduce((s, i) => s + Number(i.totalAmount || 0), 0);
    const totalPaid = invoices.reduce(
        (sum, invoice) =>
            sum + invoice.payments.reduce((invoiceSum, payment) => {
                return payment.status === "Paid" ? invoiceSum + Number(payment.amount || 0) : invoiceSum;
            }, 0),
        0
    );
    const outstandingAR = totalRevenue - totalPaid;
    const recentEstimatesTotal = estimates.reduce((s, e) => s + Number(e.totalAmount || 0), 0);
    const laborCost30d = timeEntries.reduce((s, e) => s + Number(e.laborCost || 0) + Number(e.burdenCost || 0), 0);
    const expenseCost30d = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const totalHours30d = timeEntries.reduce((s, e) => s + (e.durationHours || 0), 0);

    const projectMargins = projects.map(p => {
        const approved = p.estimates.find(e => e.status === "Approved" || e.status === "Sent");
        return { name: p.name, status: p.status, budget: Number(approved?.totalAmount || 0), client: p.client?.name || "N/A" };
    });

    const context = `
Business: Golden Touch Remodeling (Vancouver, WA — residential remodeling)
Report period: Last 30 days (${thirtyDaysAgo.toLocaleDateString()} — ${now.toLocaleDateString()})

PROJECTS:
- Active projects: ${activeProjects.length}
- Total projects: ${projects.length}
${projectMargins.map(p => `  - ${p.name} (${p.status}) — Budget: $${p.budget.toLocaleString()} — Client: ${p.client}`).join("\n")}

REVENUE & CASH FLOW:
- Total invoiced (all time): $${totalRevenue.toLocaleString()}
- Total collected: $${totalPaid.toLocaleString()}
- Outstanding AR: $${outstandingAR.toLocaleString()}
- Estimates sent (30d): $${recentEstimatesTotal.toLocaleString()} across ${estimates.length} estimates

COSTS (30 days):
- Labor: $${laborCost30d.toLocaleString()} (${totalHours30d.toFixed(0)} hours)
- Expenses/materials: $${expenseCost30d.toLocaleString()}
- Total spend: $${(laborCost30d + expenseCost30d).toLocaleString()}

PIPELINE:
- Total leads: ${leads.length}
- Won: ${wonLeads.length}
- Pipeline value: $${totalPipeline.toLocaleString()}
`;

    const prompt = `You are the AI business advisor for Golden Touch Remodeling, a residential remodeling company.

Generate a concise, plain-English monthly business summary for the owner. Be direct, specific, and actionable.

${context}

Format your response exactly like this:

MONTHLY SNAPSHOT
[2-3 sentence executive summary — revenue health, project load, cash position]

REVENUE & MARGINS
- [key metric or trend]
- [key metric or trend]
- [concern or highlight]

CASH FLOW OUTLOOK
- [AR status and collection outlook]
- [upcoming cost commitments]
- [net cash position assessment]

PROJECT HEALTH
- [project status summary]
- [any at-risk projects]

PIPELINE & GROWTH
- [lead conversion trends]
- [pipeline value assessment]

TOP 3 ACTIONS THIS WEEK
1. [specific, actionable recommendation]
2. [specific, actionable recommendation]
3. [specific, actionable recommendation]

TOP RISKS
- [risk 1 with severity]
- [risk 2 with severity]`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
    });
    const summary = getAnthropicText(response.content);

    return NextResponse.json({
        success: true,
        summary,
        metrics: {
            activeProjects: activeProjects.length,
            totalRevenue,
            outstandingAR,
            laborCost30d,
            expenseCost30d,
            pipelineValue: totalPipeline,
            totalLeads: leads.length,
            wonLeads: wonLeads.length,
        },
    });
}
