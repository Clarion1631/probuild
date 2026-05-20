import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

const responseSchema = {
    type: "OBJECT",
    properties: {
        overallScore: {
            type: "INTEGER",
            description: "Design score from 0 to 100 based on standard design rules (work triangles, dishwasher proximity, clearances)."
        },
        overallAssessment: {
            type: "STRING",
            description: "Professional, premium design audit narrative summarizing the layout quality, strengths, and primary areas of improvement."
        },
        workTriangleLegs: {
            type: "OBJECT",
            properties: {
                fridgeToSink: {
                    type: "OBJECT",
                    properties: {
                        distanceFeet: { type: "NUMBER" },
                        status: { type: "STRING", description: "Must be 'perfect', 'too-close', or 'too-far'" },
                        message: { type: "STRING", description: "Detailed metric analysis for this leg." }
                    },
                    required: ["distanceFeet", "status", "message"]
                },
                sinkToStove: {
                    type: "OBJECT",
                    properties: {
                        distanceFeet: { type: "NUMBER" },
                        status: { type: "STRING", description: "Must be 'perfect', 'too-close', or 'too-far'" },
                        message: { type: "STRING", description: "Detailed metric analysis for this leg." }
                    },
                    required: ["distanceFeet", "status", "message"]
                },
                stoveToFridge: {
                    type: "OBJECT",
                    properties: {
                        distanceFeet: { type: "NUMBER" },
                        status: { type: "STRING", description: "Must be 'perfect', 'too-close', or 'too-far'" },
                        message: { type: "STRING", description: "Detailed metric analysis for this leg." }
                    },
                    required: ["distanceFeet", "status", "message"]
                }
            },
            required: ["fridgeToSink", "sinkToStove", "stoveToFridge"]
        },
        clearanceIssues: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    issue: { type: "STRING" },
                    severity: { type: "STRING", description: "Must be 'warning', 'caution', or 'note'" },
                    fix: { type: "STRING" }
                },
                required: ["issue", "severity", "fix"]
            }
        },
        designRecommendations: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    recommendation: { type: "STRING" },
                    impact: { type: "STRING" }
                },
                required: ["recommendation", "impact"]
            }
        }
    },
    required: ["overallScore", "overallAssessment", "workTriangleLegs", "clearanceIssues", "designRecommendations"]
};

export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const { roomType, layout, assets } = body as {
            roomType: string;
            layout: any;
            assets: any[];
        };

        if (!assets || !Array.isArray(assets)) {
            return NextResponse.json({ error: "Assets list is required" }, { status: 400 });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
        }

        const ai = new GoogleGenAI({ apiKey });

        const prompt = `You are a professional NKBA-certified (National Kitchen & Bath Association) kitchen designer and architect assistant.
Your task is to analyze the 2D/3D spatial room layout and its placed assets, and perform a thorough layout audit.

### Room Type:
${roomType}

### Room Dimensions:
Width: ${layout?.dimensions?.width}m, Length: ${layout?.dimensions?.length}m, Height: ${layout?.dimensions?.height}m

### Placed Assets:
${JSON.stringify(assets.map(a => ({
    id: a.id,
    assetId: a.assetId,
    category: a.assetType,
    position: a.position, // x, y, z coordinates in meters
    rotationY: a.rotationY, // rotation in radians
    metadata: a.metadata
})), null, 2)}

### Professional Rules to Apply (convert positions to calculate distances):
1. **Work Triangle**:
   - Locate the refrigerator, the main sink base (category 'cabinet' or 'fixture' representing sink), and the stove/range/cooktop (category 'appliance' representing range).
   - If any of these 3 critical items are missing, note their absence as a warning or caution, flag their legs as 'too-far' or 'too-close' with a 0 distance and a descriptive message (e.g. 'Stove missing from room designer'), and provide a reduced overallScore.
   - Calculate distances in meters and convert to feet (1m = 3.28084 feet).
   - A standard leg of the triangle should be between 4 and 9 feet (1.2m to 2.7m).
   - The sum of all three legs should be between 12 and 26 feet (3.6m to 8.0m).
2. **Dishwasher Proximity**:
   - If a dishwasher appliance is present, check if it is within 3 feet (0.9m) of the main sink. If it is further or missing entirely, raise a caution or note.
3. **Appliance Front Clearance**:
   - Cooktops, stoves, and refrigerators require at least 36 to 48 inches of open space in front of them. Check for overlapping assets.

Please respond ONLY with valid JSON matching the schema provided. Make the assessment, warnings, and fixes read extremely premium, technical, yet reassuring and professional.`;

        const response = await ai.models.generateContent({
            model: "gemini-3.0-flash-preview",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: responseSchema as any,
                temperature: 0.2,
            }
        });

        if (!response.text) {
            throw new Error("No response from Gemini API");
        }

        const json = JSON.parse(response.text);
        return NextResponse.json(json);

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error("AI Room Design Review Error:", msg);
        return NextResponse.json({ error: "Failed to generate design audit" }, { status: 500 });
    }
}
