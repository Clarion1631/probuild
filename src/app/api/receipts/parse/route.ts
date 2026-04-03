import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "@/lib/prisma";

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

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const result = await model.generateContent([
            RECEIPT_PROMPT,
            { inlineData: { data: imageBase64, mimeType } },
        ]);

        const text = result.response.text().trim();
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(text);
        } catch {
            return NextResponse.json({ error: "AI returned invalid JSON", raw: text }, { status: 500 });
        }

        // Auto-create a pending expense if projectId provided
        if (projectId && parsed.vendor && typeof parsed.total === "number") {
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
