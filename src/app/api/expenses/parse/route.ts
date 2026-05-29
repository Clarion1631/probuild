export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";


export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("receipt") as File;

        if (!file) {
            return NextResponse.json({ error: "No receipt file provided" }, { status: 400 });
        }

        // Save file locally for now
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        // Create uploads directory if it doesn't exist
        const uploadDir = path.join(process.cwd(), "public", "uploads", "receipts");
        await mkdir(uploadDir, { recursive: true });

        const extension = file.name.split(".").pop() || "jpg";
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.${extension}`;
        const filePath = path.join(uploadDir, filename);
        await writeFile(filePath, buffer);

        const publicUrl = `/uploads/receipts/${filename}`;

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error("GEMINI_API_KEY is missing");
            return NextResponse.json({ error: "AI Parsing is not configured on this server." }, { status: 500 });
        }

        const safeMime = (["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"].includes(file.type)
            ? file.type
            : "image/jpeg");

        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({ apiKey });

        const promptText = "Extract the following from this receipt: amount (number), vendor name, date (YYYY-MM-DD), and a brief description of what was purchased. Return ONLY a valid JSON object with the keys 'amount', 'vendor', 'date', and 'description'.";

        let aiText = "";
        try {
            const aiResponse = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: [
                    {
                        inlineData: {
                            data: buffer.toString("base64"),
                            mimeType: safeMime
                        }
                    },
                    promptText
                ],
                config: {
                    responseMimeType: "application/json"
                }
            });
            aiText = aiResponse.text || "";
        } catch (genError) {
            console.error("Primary model gemini-3-flash-preview failed, falling back...", genError);
            const aiResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: [
                    {
                        inlineData: {
                            data: buffer.toString("base64"),
                            mimeType: safeMime
                        }
                    },
                    promptText
                ],
                config: {
                    responseMimeType: "application/json"
                }
            });
            aiText = aiResponse.text || "";
        }
        // Extremely simple JSON extraction just in case it's wrapped in markdown
        const jsonMatch = aiText.match(/```json\n([\s\S]*?)\n```/) || aiText.match(/\{[\s\S]*\}/);
        let entryData = {};
        if (jsonMatch) {
            try {
                entryData = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            } catch (e) {
                console.error("Failed to parse Claude JSON:", e);
            }
        }

        return NextResponse.json({
            receiptUrl: publicUrl,
            parsedData: entryData,
            rawAiText: aiText // for debugging if needed
        });

    } catch (error) {
        console.error("Error parsing receipt:", error);
        return NextResponse.json({ error: "Failed to parse receipt" }, { status: 500 });
    }
}
