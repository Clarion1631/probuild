import { NextResponse } from "next/server";
import { GoogleGenAI, Part } from "@google/genai";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";

export const dynamic = "force-dynamic";

// POST /api/mobile/photo-suggest
// Body: { photo: { data: string /* base64 */, mimeType: string }, taskName?: string }
// Returns: { suggestion: string } — a short comment starter (1-2 sentences) the
// field crew can edit before sending.
export async function POST(req: Request) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const photo = body?.photo;
    const taskName: string | null = typeof body?.taskName === "string" ? body.taskName : null;
    if (!photo || typeof photo.data !== "string" || typeof photo.mimeType !== "string") {
        return NextResponse.json({ error: "photo.data and photo.mimeType (base64) are required" }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 503 });
    }

    const prompt = `You are looking at a photo a field crew member just took at a construction site${taskName ? ` for the task "${taskName}"` : ""}.
Write ONE short comment (1-2 sentences, plain English, no headings) that the crew member could send as a quick site update. Mention what you see and call out anything that looks like a problem, safety issue, or completion milestone. Do not invent facts. If the photo is ambiguous, say what is visible plainly. Output the comment text only — no quotes, no labels.`;

    const parts: Part[] = [
        { text: prompt },
        { inlineData: { mimeType: photo.mimeType, data: photo.data } },
    ];

    try {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: { parts },
            config: { temperature: 0.4 },
        });
        const suggestion = (response.text ?? "").trim();
        if (!suggestion) {
            return NextResponse.json({ error: "AI returned no suggestion" }, { status: 502 });
        }
        return NextResponse.json({ suggestion });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("photo-suggest error:", msg);
        return NextResponse.json({ error: "Failed to generate suggestion" }, { status: 500 });
    }
}
