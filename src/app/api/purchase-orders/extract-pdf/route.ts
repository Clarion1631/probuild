import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicText } from "@/lib/anthropic";

// Simple in-memory rate limit: 10 extractions per user per hour
const rateLimitMap = new Map<string, number[]>();
function checkRateLimit(email: string): boolean {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const timestamps = (rateLimitMap.get(email) || []).filter((t) => now - t < windowMs);
    if (timestamps.length >= 10) return false;
    timestamps.push(now);
    rateLimitMap.set(email, timestamps);
    return true;
}

function normalizeVendorName(name: string): string {
    return name
        .toLowerCase()
        .replace(/\b(inc|llc|co|corp|ltd|company|services|group|contractors?)\b\.?/gi, "")
        .replace(/[^a-z0-9]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!checkRateLimit(session.user.email)) {
        return NextResponse.json({ error: "Too many extractions — try again in an hour" }, { status: 429 });
    }

    let base64: string;
    let filename: string;
    let fileSize: number;
    try {
        const body = await req.json();
        base64 = body.base64;
        filename = body.filename || "upload.pdf";
        fileSize = body.fileSize || 0;
        if (!base64 || typeof base64 !== "string") throw new Error("missing base64");
    } catch {
        return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    // Rough size check (~5MB base64 ≈ 3.75MB binary)
    if (base64.length > 7 * 1024 * 1024) {
        return NextResponse.json({ error: "File too large — max 5MB" }, { status: 413 });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let extracted: {
        vendor: { name: string; email: string | null; phone: string | null; address: string | null };
        lineItems: { description: string; quantity: number; unitCost: number; total: number }[];
        notes: string | null;
        terms: string | null;
    };

    try {
        const response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 2048,
            system: `You are a construction procurement assistant. Extract purchase order or invoice data from the attached PDF.
Return ONLY valid JSON with this exact shape — no markdown fences, no extra commentary:
{
  "vendor": { "name": string, "email": string|null, "phone": string|null, "address": string|null },
  "lineItems": [ { "description": string, "quantity": number, "unitCost": number, "total": number } ],
  "notes": string|null,
  "terms": string|null
}
Rules:
- quantity and unitCost must be positive numbers; total = quantity * unitCost
- If a field cannot be determined, use null
- Extract ALL line items visible in the document
- Do not invent data not present in the document`,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "document",
                            source: { type: "base64", media_type: "application/pdf", data: base64 },
                        } as any,
                        { type: "text", text: "Extract the purchase order data from this document." },
                    ],
                },
            ],
        });

        const text = getAnthropicText(response.content)
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();

        extracted = JSON.parse(text);

        // Validate shape
        if (!extracted.vendor || !Array.isArray(extracted.lineItems)) {
            throw new Error("Unexpected response shape");
        }
    } catch (err: any) {
        console.error("[extract-pdf] Claude error:", err?.message || err);
        return NextResponse.json(
            { error: "Couldn't read PDF — please fill in the form manually" },
            { status: 422 }
        );
    }

    // Vendor matching — search existing vendors
    let vendorMatch: {
        matched: boolean;
        vendorId: string | null;
        vendorName: string;
        isNew: boolean;
        confidence: number;
    } = {
        matched: false,
        vendorId: null,
        vendorName: extracted.vendor?.name || "",
        isNew: false,
        confidence: 0,
    };

    if (extracted.vendor?.name) {
        const extNorm = normalizeVendorName(extracted.vendor.name);
        const vendors = await prisma.vendor.findMany({ select: { id: true, name: true } });

        let best: { id: string; name: string } | null = null;
        let bestScore = 0;

        for (const v of vendors) {
            const vNorm = normalizeVendorName(v.name);
            if (vNorm === extNorm) {
                best = v;
                bestScore = 1.0;
                break;
            }
            if (vNorm.length > 2 && extNorm.length > 2) {
                const longer = Math.max(vNorm.length, extNorm.length);
                const overlap = vNorm.includes(extNorm) || extNorm.includes(vNorm);
                if (overlap) {
                    const score = Math.min(vNorm.length, extNorm.length) / longer;
                    if (score > bestScore) {
                        bestScore = score;
                        best = v;
                    }
                }
            }
        }

        if (best && bestScore >= 0.7) {
            vendorMatch = { matched: true, vendorId: best.id, vendorName: best.name, isNew: false, confidence: bestScore };
        } else {
            // Will need to create vendor on save
            vendorMatch = { matched: false, vendorId: null, vendorName: extracted.vendor.name, isNew: true, confidence: 0 };
        }
    }

    return NextResponse.json({
        vendor: extracted.vendor,
        lineItems: extracted.lineItems,
        notes: extracted.notes,
        terms: extracted.terms,
        vendorMatch,
    });
}
