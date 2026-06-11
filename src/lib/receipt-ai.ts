/**
 * AI receipt parsing shared by the upload endpoint and the Drive ingestion cron.
 * Accepts images (jpeg/png/gif/webp) AND PDFs (Claude document blocks).
 */
import Anthropic from "@anthropic-ai/sdk";

export const RECEIPT_PROMPT = `You are an AI receipt parser for a construction company.
Analyze this receipt and extract the following information as JSON:

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

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface ParsedReceipt {
    vendor?: string;
    date?: string | null;
    total?: number;
    subtotal?: number;
    tax?: number;
    category?: string;
    confidence?: number;
    notes?: string;
    [k: string]: unknown;
}

export async function parseReceiptWithAI(base64: string, mimeType: string): Promise<ParsedReceipt> {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const mediaBlock = mimeType === "application/pdf"
        ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: base64 } }
        : {
            type: "image" as const,
            source: {
                type: "base64" as const,
                media_type: (IMAGE_MIME.has(mimeType) ? mimeType : "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: base64,
            },
        };

    const result = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: [mediaBlock, { type: "text", text: RECEIPT_PROMPT }] }],
    });

    const text = (result.content[0] as { type: "text"; text: string }).text.trim();
    return JSON.parse(text) as ParsedReceipt;
}
