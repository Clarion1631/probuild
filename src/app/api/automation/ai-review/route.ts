import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { logAutomationEvent } from "@/lib/automation-events";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Command Center "AI review" — TIERED double-check of a booked receipt.
 *
 * The number that matters is the BANK CHARGE: the booked total must equal
 * what hits Washington Trust to the penny or the bank match fails. QBO does
 * not expose raw bank-feed rows via API, so the verifiable chain is
 * receipt image ⇄ booked values ⇄ live QBO purchase — exactly the amount
 * the bank feed matches against.
 *
 * Tier 1: Gemini Flash independently re-reads the receipt (fast, cheap).
 * Tier 2 ("the big guns"): ONLY when tier 1 flags a mismatch, can't read
 * the document, or fails — Claude Opus 5 arbitrates: reads the receipt
 * carefully, weighs the booked values against tier 1's read, and rules on
 * what the true bank charge should be.
 *
 * Read-only everywhere; the outcome is logged as a journey step.
 */

const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

interface ModelRead {
    vendor: string | null;
    total: number | null; // dollars
    tax: number | null;
    date: string | null; // YYYY-MM-DD
    legible: boolean;
    notes: string | null;
}

interface Arbitration {
    trueTotal: number | null;
    trueTax: number | null;
    bookedIsCorrect: boolean | null;
    explanation: string | null;
}

const READ_PROMPT = `You are auditing a bookkeeping automation for a remodeling company. Independently read this receipt document. Report ONLY what you can actually read on it — never guess or compute values that are not printed.
Respond with STRICT JSON, nothing else:
{"vendor": "string or null", "total": number or null, "tax": number or null, "date": "YYYY-MM-DD or null", "legible": true/false, "notes": "anything odd about this receipt, or null"}
"total" is the FINAL amount paid (after discounts, including tax) — the number that will appear as the bank card charge. "tax" is the sales tax line if printed. "legible" is false if the document is too poor to read confidently.`;

function arbitrationPrompt(booked: BookedValues, tier1: ModelRead | null): string {
    return `You are the senior auditor for a bookkeeping automation. A receipt was booked into QuickBooks and a first-pass model has doubts. Read the attached receipt document CAREFULLY and rule on the truth.

The booked purchase (what will be matched against the bank card charge):
- Vendor: ${booked.vendor ?? "unknown"}
- Total: ${booked.amountCents != null ? "$" + (booked.amountCents / 100).toFixed(2) : "unknown"}
- Sales tax line: ${booked.taxCents != null ? "$" + (booked.taxCents / 100).toFixed(2) : "$0.00"}

First-pass model read: ${tier1 ? JSON.stringify(tier1) : "unavailable (model failed or could not read the document)"}

The booked TOTAL must equal the actual bank charge to the penny or the bank match fails. Determine from the document what the true final total and sales tax are.
Respond with STRICT JSON, nothing else:
{"vendor": "string or null", "total": number or null, "tax": number or null, "date": "YYYY-MM-DD or null", "legible": true/false, "notes": "string or null", "trueTotal": number or null, "trueTax": number or null, "bookedIsCorrect": true/false/null, "explanation": "one or two sentences: what is right, what is wrong, and what to do"}`;
}

interface BookedValues {
    amountCents: number | null;
    taxCents: number | null;
    vendor: string | null;
}

function parseModelJson(text: string): (ModelRead & Partial<Arbitration>) | null {
    try {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        const raw = JSON.parse(match[0]) as Record<string, unknown>;
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
        return {
            vendor: typeof raw.vendor === "string" ? raw.vendor : null,
            total: num(raw.total),
            tax: num(raw.tax),
            date: typeof raw.date === "string" ? raw.date : null,
            legible: raw.legible !== false,
            notes: typeof raw.notes === "string" ? raw.notes : null,
            trueTotal: num(raw.trueTotal),
            trueTax: num(raw.trueTax),
            bookedIsCorrect: typeof raw.bookedIsCorrect === "boolean" ? raw.bookedIsCorrect : null,
            explanation: typeof raw.explanation === "string" ? raw.explanation : null,
        };
    } catch {
        return null;
    }
}

type VerdictState = "agree" | "flag" | "unknown";
function fieldVerdicts(read: ModelRead, booked: BookedValues) {
    const verdicts: Array<{ field: string; state: VerdictState; note?: string }> = [];
    const centsOf = (v: number | null) => (v == null ? null : Math.round(v * 100));
    const cmp = (field: string, bookedCents: number | null, readDollars: number | null) => {
        const readCents = centsOf(readDollars);
        if (bookedCents == null || readCents == null) verdicts.push({ field, state: "unknown" });
        else if (bookedCents === readCents) verdicts.push({ field, state: "agree" });
        else verdicts.push({ field, state: "flag", note: `model read $${(readCents / 100).toFixed(2)}, booked $${(bookedCents / 100).toFixed(2)}` });
    };
    cmp("total", booked.amountCents, read.total);
    cmp("tax", booked.taxCents ?? 0, read.tax ?? 0);
    if (booked.vendor && read.vendor) {
        const a = booked.vendor.trim().toLowerCase();
        const b = read.vendor.trim().toLowerCase();
        verdicts.push(a === b || a.includes(b) || b.includes(a)
            ? { field: "vendor", state: "agree" }
            : { field: "vendor", state: "flag", note: `model read "${read.vendor}"` });
    } else {
        verdicts.push({ field: "vendor", state: "unknown" });
    }
    return verdicts;
}

function claudeContent(base64: string, mediaType: string, prompt: string): Anthropic.ContentBlockParam[] {
    return [
        mediaType === "application/pdf"
            ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
            : { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: base64 } },
        { type: "text", text: prompt },
    ];
}

async function tier1Gemini(base64: string, mediaType: string): Promise<ModelRead | null> {
    if (!process.env.GEMINI_API_KEY) return null;
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
        model: "gemini-3.0-flash-preview",
        contents: [{
            role: "user",
            parts: [
                { inlineData: { mimeType: mediaType, data: base64 } },
                { text: READ_PROMPT },
            ],
        }],
    });
    return parseModelJson(response.text ?? "");
}

async function tier2Claude(base64: string, mediaType: string, booked: BookedValues, tier1: ModelRead | null): Promise<(ModelRead & Partial<Arbitration>) | null> {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 2048,
        messages: [{ role: "user", content: claudeContent(base64, mediaType, arbitrationPrompt(booked, tier1)) }],
    });
    const text = response.content.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("");
    return parseModelJson(text);
}

export async function POST(request: Request) {
    const user = await getCurrentUserWithPermissions();
    if (!user) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    if (!hasPermission(user, "financialReports")) {
        return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    let parsed: unknown;
    try {
        parsed = await request.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    if (typeof parsed !== "object" || parsed === null) {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    const docNumber = typeof (parsed as { docNumber?: unknown }).docNumber === "string"
        ? ((parsed as { docNumber: string }).docNumber).trim()
        : null;
    if (!docNumber || docNumber.length > 30) {
        return NextResponse.json({ ok: false, reason: "invalid-doc-number" }, { status: 400 });
    }

    // Booked values (original created event — same evidence rule as verify).
    const pushEvent =
        (await prisma.automationEvent.findFirst({
            where: { kind: "receipt-push", docNumber, status: "created" },
            orderBy: { createdAt: "asc" },
        })) ??
        (await prisma.automationEvent.findFirst({
            where: { kind: "receipt-push", docNumber, status: "already-exists" },
            orderBy: { createdAt: "desc" },
        }));
    if (!pushEvent) {
        return NextResponse.json({ ok: false, reason: "no-booking-on-record" }, { status: 404 });
    }

    // The reviewable image is the ProBuild-stored copy (public Supabase URL,
    // fetchable server-side). It exists once the 4-hour sync has landed.
    const expense = await prisma.expense.findFirst({
        where: {
            qbPurchaseId: { not: null },
            description: { contains: `[gtr-file:${docNumber}` },
            receiptUrl: { not: null },
        },
        select: { receiptUrl: true },
    });
    if (!expense?.receiptUrl) {
        return NextResponse.json({ ok: false, reason: "no-stored-copy" });
    }

    try {
        const fileRes = await fetch(expense.receiptUrl);
        if (!fileRes.ok) {
            return NextResponse.json({ ok: false, reason: "receipt-fetch-failed" }, { status: 502 });
        }
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        if (buffer.byteLength > MAX_RECEIPT_BYTES) {
            return NextResponse.json({ ok: false, reason: "receipt-too-large" });
        }
        const contentType = (fileRes.headers.get("content-type") ?? "application/pdf").split(";")[0].trim();
        const allowed = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"]);
        const mediaType = allowed.has(contentType) ? contentType : "application/pdf";
        const base64 = buffer.toString("base64");

        const booked: BookedValues = { amountCents: pushEvent.amountCents, taxCents: pushEvent.taxCents, vendor: pushEvent.vendor };

        // ── Tier 1: fast, cheap, automatic ──
        let tier1: ModelRead | null = null;
        try {
            tier1 = await tier1Gemini(base64, mediaType);
        } catch (error) {
            console.error("ai-review tier1 failed", error instanceof Error ? error.name : "UnknownError");
        }
        const tier1Verdicts = tier1 ? fieldVerdicts(tier1, booked) : null;
        const tier1Flagged = tier1Verdicts?.some(v => v.state === "flag") ?? false;
        const needBigGuns = !tier1 || !tier1.legible || tier1Flagged;

        // ── Tier 2: the big guns, only when something doesn't line up ──
        let tier2: (ModelRead & Partial<Arbitration>) | null = null;
        if (needBigGuns) {
            try {
                tier2 = await tier2Claude(base64, mediaType, booked, tier1);
            } catch (error) {
                console.error("ai-review tier2 failed", error instanceof Error ? error.name : "UnknownError");
            }
        }

        const models: Array<{
            model: string;
            tier: "first-pass" | "big-guns";
            read: ModelRead;
            verdicts: ReturnType<typeof fieldVerdicts>;
            arbitration?: Arbitration;
        }> = [];
        if (tier1) {
            models.push({ model: "Gemini 3.0 Flash", tier: "first-pass", read: tier1, verdicts: tier1Verdicts! });
        }
        if (tier2) {
            models.push({
                model: "Claude Opus 5",
                tier: "big-guns",
                read: tier2,
                verdicts: fieldVerdicts(tier2, booked),
                arbitration: {
                    trueTotal: tier2.trueTotal ?? null,
                    trueTax: tier2.trueTax ?? null,
                    bookedIsCorrect: tier2.bookedIsCorrect ?? null,
                    explanation: tier2.explanation ?? null,
                },
            });
        }
        if (models.length === 0) {
            return NextResponse.json({ ok: false, reason: "no-reviewers-available" }, { status: 502 });
        }

        // Final ruling: when the big guns ran, THEIR verdict decides; a tier-1
        // flag that Opus overrules is a caught false alarm, not a mismatch.
        const anyFlag = tier2
            ? tier2.bookedIsCorrect === false || (tier2.bookedIsCorrect === null && models.some(m => m.verdicts.some(v => v.state === "flag")))
            : tier1Flagged;

        await logAutomationEvent({
            kind: "receipt-stage",
            stage: "ai-review",
            status: anyFlag ? "mismatch" : "ok",
            reason: anyFlag
                ? (tier2?.explanation ?? models.flatMap(m => m.verdicts.filter(v => v.state === "flag").map(v => `${m.model}: ${v.field}`)).join("; ")).slice(0, 400)
                : (tier2 ? "escalated — Claude Opus 5 confirmed the booking" : "first pass agrees with the booking"),
            source: `manual:${user.id}`,
            docNumber,
        });

        return NextResponse.json({
            ok: true,
            reviewedAt: new Date().toISOString(),
            anyFlag,
            escalated: Boolean(tier2),
            // What the bank feed will try to match — the whole point.
            expectedBankChargeCents: pushEvent.amountCents,
            models,
        });
    } catch (error) {
        console.error("ai-review failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "review-failed" }, { status: 500 });
    }
}
