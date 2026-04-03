import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Part } from "@google/genai";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

// Define the expected output schema for the AI response
const responseSchema = {
    type: "OBJECT",
    properties: {
        workPerformed: {
            type: "STRING",
            description: "A professional, expansive description of the work performed, formatted properly with paragraphs or bullet points if necessary."
        },
        materialsDelivered: {
            type: "STRING",
            description: "A list of materials delivered. If none mentioned, return empty string."
        },
        issues: {
            type: "STRING",
            description: "Any issues, delays, or concerns mentioned. If none, return empty string."
        },
        weather: {
            type: "STRING",
            description: "Inferred weather conditions if mentioned, otherwise empty string. Must be a short string like 'Sunny, 80F' or 'Rainy'."
        }
    },
    required: ["workPerformed", "materialsDelivered", "issues", "weather"],
};

export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const { notes, photos } = body as {
            notes: string;
            photos?: { data: string; mimeType: string }[];
        };

        // TODO: Video daily logs — use Gemini 1.5 Pro with file URI once video upload is wired

        if (!notes) {
            return NextResponse.json({ error: "Notes are required" }, { status: 400 });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
        }

        const ai = new GoogleGenAI({ apiKey });

        const hasPhotos = Array.isArray(photos) && photos.length > 0;

        const prompt = `You are an expert construction site superintendent.
Your task is to take rough, shorthand field notes${hasPhotos ? " and site photos" : ""} from a worker and turn them into a clear, professional daily log report.
The report will be visible to both the internal team and the customer, so maintain a professional, reassuring tone.

Here are the raw notes from the field today:
"""
${notes}
"""
${hasPhotos ? `\n${photos!.length} site photo(s) are attached. Describe any visible progress, materials, equipment, or conditions you can identify from the photos and incorporate that into the workPerformed description.\n` : ""}
Please extract and expand upon this information into the following structured format exactly:
- workPerformed: Detail what was done today. Make it read well.
- materialsDelivered: Any materials.
- issues: Any issues or delays.
- weather: If any weather info is included.

Respond ONLY with valid JSON matching the schema provided.`;

        const parts: Part[] = [{ text: prompt }];

        if (hasPhotos) {
            for (const photo of photos!) {
                parts.push({
                    inlineData: {
                        mimeType: photo.mimeType,
                        data: photo.data,
                    },
                });
            }
        }

        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: { parts },
            config: {
                responseMimeType: "application/json",
                responseSchema: responseSchema as any,
                temperature: 0.3,
            }
        });

        if (!response.text) {
            throw new Error("No response from AI");
        }

        const json = JSON.parse(response.text);

        return NextResponse.json(json);

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("AI Daily Log Error:", msg);
        return NextResponse.json({ error: "Failed to generate AI report" }, { status: 500 });
    }
}
