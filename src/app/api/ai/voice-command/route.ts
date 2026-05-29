import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Structured JSON schema for voice command actions
const responseSchema = {
    type: "OBJECT",
    properties: {
        action: {
            type: "STRING",
            enum: ["log_time", "add_expense", "daily_log", "add_estimate_item", "unknown"],
            description: "The action class inferred from the spoken words."
        },
        transcription: {
            type: "STRING",
            description: "The verbatim text transcription of the spoken audio."
        },
        feedbackText: {
            type: "STRING",
            description: "A professional, friendly audio-playback/text response confirming the action taken (e.g., 'Got it! Logged 4 hours of drywall framing for the Patio project.')."
        },
        timeLog: {
            type: "OBJECT",
            description: "Payload for log_time action.",
            properties: {
                hours: { type: "NUMBER" },
                task: { type: "STRING" },
                projectName: { type: "STRING" }
            }
        },
        expense: {
            type: "OBJECT",
            description: "Payload for add_expense action.",
            properties: {
                amount: { type: "NUMBER" },
                vendor: { type: "STRING" },
                item: { type: "STRING" },
                projectName: { type: "STRING" }
            }
        },
        dailyLog: {
            type: "OBJECT",
            description: "Payload for daily_log action.",
            properties: {
                notes: { type: "STRING" },
                projectName: { type: "STRING" }
            }
        },
        estimateItem: {
            type: "OBJECT",
            description: "Payload for add_estimate_item action.",
            properties: {
                quantity: { type: "NUMBER" },
                material: { type: "STRING" },
                unitPrice: { type: "NUMBER" },
                projectName: { type: "STRING" }
            }
        }
    },
    required: ["action", "transcription", "feedbackText"]
};

export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const formData = await req.formData();
        const audioFile = formData.get("audio") as File;
        const projectId = formData.get("projectId") as string | null;

        if (!audioFile) {
            return NextResponse.json({ error: "No audio file provided" }, { status: 400 });
        }

        const bytes = await audioFile.arrayBuffer();
        const buffer = Buffer.from(bytes);

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
        }

        const ai = new GoogleGenAI({ apiKey });

        const audioMime = audioFile.type || "audio/webm";

        const promptText = `
You are ProBuild's intelligent voice-first agent. Analyze the spoken audio and map it to a structured action payload.
Infer the action, create a verbatim transcription of what was said, and provide a helpful, conversational feedbackText that would sound natural when spoken back.

Available Actions and their fields:
1. 'log_time': For logging labor hours. Requires timeLog object (hours, task, projectName).
2. 'add_expense': For recording materials/job costs. Requires expense object (amount, vendor, item, projectName).
3. 'daily_log': For recording site notes or logs. Requires dailyLog object (notes, projectName).
4. 'add_estimate_item': For appending materials to estimates. Requires estimateItem object (quantity, material, unitPrice, projectName).

Respond ONLY with a valid JSON object matching the provided responseSchema.
`;

        let aiText = "";
        try {
            const aiResponse = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: [
                    {
                        inlineData: {
                            data: buffer.toString("base64"),
                            mimeType: audioMime
                        }
                    },
                    promptText
                ],
                config: {
                    responseMimeType: "application/json",
                    responseSchema: responseSchema as any,
                    temperature: 0.2
                }
            });
            aiText = aiResponse.text || "";
        } catch (genError) {
            console.warn("Primary model gemini-3-flash-preview failed for audio, falling back to gemini-2.5-flash...", genError);
            const aiResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: [
                    {
                        inlineData: {
                            data: buffer.toString("base64"),
                            mimeType: audioMime
                        }
                    },
                    promptText
                ],
                config: {
                    responseMimeType: "application/json",
                    responseSchema: responseSchema as any,
                    temperature: 0.2
                }
            });
            aiText = aiResponse.text || "";
        }

        if (!aiText) {
            throw new Error("No transcription or action response from Gemini");
        }

        const actionJson = JSON.parse(aiText);

        return NextResponse.json(actionJson);

    } catch (error: any) {
        console.error("[Voice Action API Error]:", error);
        return NextResponse.json({ error: error.message || "Failed to process voice command" }, { status: 500 });
    }
}
