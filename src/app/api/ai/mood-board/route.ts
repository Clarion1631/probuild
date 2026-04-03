import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "@/lib/prisma";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export async function POST(request: Request) {
    try {
        const { projectId, prompt, baseImageUrl } = await request.json();

        if (!projectId || !prompt) {
            return NextResponse.json({ error: "projectId and prompt are required" }, { status: 400 });
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        type GeminiPart = { text: string } | { inlineData: { data: string; mimeType: string }; text?: string };
        const parts: GeminiPart[] = [
            { text: `You are an expert interior designer. Create a mood board conceptualization based on this theme/prompt: "${prompt}". 
            
            Return a JSON object containing:
            1. "title": A catchy, elegant title for the mood board.
            2. "items": An array of EXACTLY 6 to 8 elements that represent this theme.
               Each item in the array MUST be an object with:
                 - "type": "IMAGE" | "SWATCH" | "TEXT"
                 - "content": For IMAGE, a valid public image URL related to the theme (e.g. from an unsplash source: 'https://images.unsplash.com/photo-X' or simply return descriptive keywords and we will map it, actually, just return a robust unsplash source.unsplash.com direct URL!). Update: Wait, source.unsplash.com is deprecated. Please return a realistic sample interior design image URL from standard places, or realistically just descriptive solid colors or simple placeholder texts for now. 
                 BETTER YET: For image, return an Unsplash source URL: "https://source.unsplash.com/featured/?interior,${prompt.replace(/ /g, ',')}"
                 - "x": float coordinate (0-800 for canvas width)
                 - "y": float coordinate (0-600 for canvas height)
                 - "width": float (suggested 150-300)
                 - "height": float (suggested 150-300)
                 - "zIndex": integer (1-10)
                 
            Arrange them aesthetically in a mosaic-like grid overlapping slightly.
            Return ONLY raw JSON, with no markdown formatting or backticks.` }
        ];

        // If a base image is provided, let Gemini Vision read it
        if (baseImageUrl) {
            try {
                const response = await fetch(baseImageUrl);
                const arrayBuffer = await response.arrayBuffer();
                const base64String = Buffer.from(arrayBuffer).toString('base64');
                const mimeType = response.headers.get("content-type") || "image/jpeg";
                
                parts.unshift({
                    inlineData: {
                        data: base64String,
                        mimeType
                    }
                });
                parts[1].text += "\nAlso incorporate styling elements that complement the provided photo of the space.";
            } catch (e) {
                console.error("Failed to fetch image for Gemini Vision", e);
            }
        }

        const result = await model.generateContent(parts);
        let text = result.response.text();
        
        // Strip markdown backticks
        if (text.includes('```json')) text = text.replace(/```json/g, '');
        if (text.includes('```')) text = text.replace(/```/g, '');
        
        let parsed;
        try {
            parsed = JSON.parse(text.trim());
        } catch {
            console.error("Failed to parse Gemini generated json:", text);
            return NextResponse.json({ error: "Failed to generate mood board" }, { status: 500 });
        }

        // Save to DB
        const board = await prisma.moodBoard.create({
            data: {
                projectId,
                title: parsed.title || "AI Generated Mood Board",
                items: {
                    create: parsed.items.map((item: { type?: string; content?: string; x?: number; y?: number; width?: number; height?: number; zIndex?: number }) => ({
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
