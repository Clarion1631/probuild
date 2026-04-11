import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

const ALLOWED_IMAGE_HOSTS = [
    process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname : null,
    "images.unsplash.com",
    "source.unsplash.com",
].filter(Boolean) as string[];

function isAllowedImageUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return false;
        return ALLOWED_IMAGE_HOSTS.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    } catch {
        return false;
    }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

export async function POST(request: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { projectId, prompt, baseImageUrl } = await request.json();

        if (!projectId || !prompt) {
            return NextResponse.json({ error: "projectId and prompt are required" }, { status: 400 });
        }

        if (baseImageUrl && !isAllowedImageUrl(baseImageUrl)) {
            return NextResponse.json({ error: "Invalid image URL" }, { status: 400 });
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
        }

        type ContentBlock =
            | { type: "text"; text: string }
            | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } };

        const contentBlocks: ContentBlock[] = [];

        // If a base image is provided, include it for Claude Vision
        if (baseImageUrl) {
            try {
                const response = await fetch(baseImageUrl);
                const arrayBuffer = await response.arrayBuffer();
                const base64String = Buffer.from(arrayBuffer).toString("base64");
                const rawMime = response.headers.get("content-type") || "image/jpeg";
                const mimeType = (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(rawMime)
                    ? rawMime
                    : "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

                contentBlocks.push({
                    type: "image",
                    source: { type: "base64", media_type: mimeType, data: base64String },
                });
            } catch (e) {
                console.error("Failed to fetch image for Claude Vision", e);
            }
        }

        const textPrompt = `You are an expert interior designer. Create a mood board conceptualization based on this theme/prompt: "${prompt}".

Return a JSON object containing:
1. "title": A catchy, elegant title for the mood board.
2. "items": An array of EXACTLY 6 to 8 elements that represent this theme.
   Each item in the array MUST be an object with:
     - "type": "IMAGE" | "SWATCH" | "TEXT"
     - "content": For IMAGE, return an Unsplash source URL: "https://source.unsplash.com/featured/?interior,${prompt.replace(/ /g, ',')}"
     - "x": float coordinate (0-800 for canvas width)
     - "y": float coordinate (0-600 for canvas height)
     - "width": float (suggested 150-300)
     - "height": float (suggested 150-300)
     - "zIndex": integer (1-10)

Arrange them aesthetically in a mosaic-like grid overlapping slightly.
${baseImageUrl ? "Also incorporate styling elements that complement the provided photo of the space." : ""}
Return ONLY raw JSON, with no markdown formatting or backticks.`;

        contentBlocks.push({ type: "text", text: textPrompt });

        const result = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 2048,
            messages: [{ role: "user", content: contentBlocks }],
        });

        let text = (result.content[0] as { type: "text"; text: string }).text;

        // Strip markdown backticks if present
        if (text.includes("```json")) text = text.replace(/```json/g, "");
        if (text.includes("```")) text = text.replace(/```/g, "");

        let parsed: { title?: string; items?: Array<{ type?: string; content?: string; x?: number; y?: number; width?: number; height?: number; zIndex?: number }> };
        try {
            parsed = JSON.parse(text.trim());
        } catch {
            console.error("Failed to parse Claude generated json:", text);
            return NextResponse.json({ error: "Failed to generate mood board" }, { status: 500 });
        }

        // Save to DB
        const board = await prisma.moodBoard.create({
            data: {
                projectId,
                title: parsed.title || "AI Generated Mood Board",
                items: {
                    create: (parsed.items || []).map((item) => ({
                        type: item.type || "TEXT",
                        content: item.content || "",
                        x: item.x || 0,
                        y: item.y || 0,
                        width: item.width || 200,
                        height: item.height || 200,
                        zIndex: item.zIndex || 1
                    }))
                }
            },
            include: { items: true }
        });

        return NextResponse.json(board);

    } catch (e) {
        console.error("AI Mood Board error:", e);
        const message = e instanceof Error ? e.message : "Failed to process AI request";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
