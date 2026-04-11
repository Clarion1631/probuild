import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

const RECEIPT_PROMPT = `You are an AI receipt parser for a construction company.
Analyze this receipt image and extract the following information as JSON:

{
  "vendor": "Store or vendor name",
  "date": "YYYY-MM-DD or null if unclear",
  "total": 0.00,
  "subtotal": 0.00,
  "tax": 0.00,
  "items": [
    { "description": "Item name", "quantity": 1, "unitPrice": 0.00, "total": 0.00 }
  ],
  "category": "Materials | Labor | Equipment | Subcontractor | Other",
  "confidence": 0.95,
  "notes": "Any additional notes or caveats"
}

Return ONLY valid JSON, no markdown, no explanation.`;

export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const contentType = req.headers.get("content-type") || "";

        let imageBase64: string;
        let mimeType: string;
        let projectId: string | null = null;

        if (contentType.includes("multipart/form-data")) {
            const formData = await req.formData();
            const file = formData.get("file") as File | null;
            projectId = (formData.get("projectId") as string) || null;
            if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
            const buffer = await file.arrayBuffer();
            imageBase64 = Buffer.from(buffer).toString("base64");
            mimeType = file.type || "image/jpeg";
        } else {
            const body = await req.json();
            imageBase64 = body.imageBase64;
            mimeType = body.mimeType || "image/jpeg";
            projectId = body.projectId || null;
        }

        if (!imageBase64) {
            return NextResponse.json({ error: "No image data provided" }, { status: 400 });
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
        }

        const safeMime = (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)
            ? mimeType
            : "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const result = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            messages: [{
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", media_type: safeMime, data: imageBase64 } },
                    { type: "text", text: RECEIPT_PROMPT },
                ],
            }],
        });

        const text = (result.content[0] as { type: "text"; text: string }).text.trim();
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(text);
        } catch {
            return NextResponse.json({ error: "AI returned invalid JSON", raw: text }, { status: 500 });
        }

        // Auto-create a pending expense if projectId provided
        if (projectId && parsed.vendor && typeof parsed.total === "number") {
            // Verify caller has access to the project before creating the expense
            const callerUser = await prisma.user.findUnique({
                where: { email: session.user.email },
                select: { role: true, projectAccess: { where: { projectId }, select: { projectId: true } } }
            });
            const isAdmin = callerUser && ["ADMIN", "MANAGER"].includes(callerUser.role);
            if (!callerUser || (!isAdmin && callerUser.projectAccess.length === 0)) {
                return NextResponse.json({ success: true, parsed }); // silently skip expense creation
            }

            const estimate = await prisma.estimate.findFirst({
                where: { projectId },
                select: { id: true },
            });

            if (estimate) {
                const confidence = ((parsed.confidence as number || 0) * 100).toFixed(0);
                const expense = await prisma.expense.create({
                    data: {
                        estimateId: estimate.id,
                        description: `[AI ${confidence}%] ${parsed.vendor} receipt — pending bookkeeper review`,
                        amount: parsed.total as number,
                        date: parsed.date ? new Date(parsed.date as string) : new Date(),
                        vendor: parsed.vendor as string,
                        status: "Pending",
                    },
                });
                return NextResponse.json({ success: true, parsed, expenseId: expense.id });
            }
        }

        return NextResponse.json({ success: true, parsed });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Parse failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
