import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
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
        const { notes, photoUrls } = body;

        // Note: For now we're just parsing the shorthand text. In the future, we can add vision capabilities 
        // to parse the photos, or video capabilities by passing the uploaded file URIs to the Gemini API.

        if (!notes) {
            return NextResponse.json({ error: "Notes are required" }, { status: 400 });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
        }

        const ai = new GoogleGenAI({ apiKey });

        const prompt = `You are an expert construction site superintendent. 
Your task is to take rough, shorthand field notes from a worker and turn them into a clear, professional daily log report.
The report will be visible to both the internal team and the customer, so maintain a professional, reassuring tone.

Here are the raw notes from the field today:
"""
${notes}
"""

Please extract and expand upon this information into the following structured format exactly:
- workPerformed: Detail what was done today. Make it read well.
- materialsDelivered: Any materials.
- issues: Any issues or delays.
- weather: If any weather info is included.

Respond ONLY with valid JSON matching the schema provided.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-pro",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: responseSchema as any,
                temperature: 0.3, // Low temp for more factual formatting
            }
        });

        if (!response.text) {
            throw new Error("No response from AI");
        }

        const json = JSON.parse(response.text);

        return NextResponse.json(json);

    } catch (error: any) {
        console.error("AI Daily Log Error:", error);
        return NextResponse.json({ error: "Failed to generate AI report" }, { status: 500 });
    }
}
