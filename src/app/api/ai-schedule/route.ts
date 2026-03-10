import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
    }

    const { projectId, estimateId } = await req.json();
    if (!projectId) {
        return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    // Gather context
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { client: true },
    });
    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Get estimate items if an estimate is provided, otherwise get all estimates
    let estimateItems: { name: string; type: string; total: number; quantity: number }[] = [];
    if (estimateId) {
        const estimate = await prisma.estimate.findUnique({
            where: { id: estimateId },
            include: {
                items: {
                    where: { parentId: null },
                    orderBy: { order: "asc" },
                },
            },
        });
        if (estimate) {
            estimateItems = estimate.items.map(i => ({
                name: i.name,
                type: i.type,
                total: i.total,
                quantity: i.quantity,
            }));
        }
    } else {
        // Get all estimates for this project
        const estimates = await prisma.estimate.findMany({
            where: { projectId },
            include: {
                items: {
                    where: { parentId: null },
                    orderBy: { order: "asc" },
                },
            },
        });
        estimateItems = estimates.flatMap(e =>
            e.items.map(i => ({
                name: i.name,
                type: i.type,
                total: i.total,
                quantity: i.quantity,
            }))
        );
    }

    // Get existing schedule tasks
    const existingTasks = await prisma.scheduleTask.findMany({
        where: { projectId },
        orderBy: { order: "asc" },
    });

    const today = new Date().toISOString().split("T")[0];

    const prompt = `You are an expert construction project scheduler. Generate a realistic construction schedule for this project.

PROJECT: "${project.name}"
TYPE: ${project.type || "General Remodeling"}
LOCATION: ${project.location || "Not specified"}
TODAY'S DATE: ${today}

${estimateItems.length > 0 ? `ESTIMATE LINE ITEMS (use these as the basis for tasks):
${estimateItems.map((item, i) => `${i + 1}. ${item.name} (${item.type}, $${item.total.toFixed(2)})`).join("\n")}` : "No estimate items available. Create a general construction schedule for this project type."}

${existingTasks.length > 0 ? `EXISTING SCHEDULE (do NOT duplicate these):
${existingTasks.map(t => `- ${t.name} (${t.status})`).join("\n")}` : ""}

INSTRUCTIONS:
- Create 6-15 realistic construction tasks in proper sequencing order
- Each task needs a name, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), and color hex code
- Tasks should have realistic durations (demolition: 3-5 days, framing: 5-10 days, etc.)
- Respect construction dependencies (e.g. framing before electrical, drywall before painting)
- Some tasks can overlap where realistic (e.g. electrical and plumbing can run in parallel)
- Start from today's date: ${today}
- Use these colors to visually group work: red #ef4444 for demo, amber #f59e0b for structural, blue #3b82f6 for mechanical, purple #8b5cf6 for specialty, cyan #06b6d4 for finishes, green #4c9a2a for final/cleanup
- Do NOT include tasks that already exist in the schedule

Return ONLY a JSON array of objects, nothing else. Each object must have exactly these fields:
{ "name": string, "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "color": "#hex" }`;

    try {
        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.7,
                        responseMimeType: "application/json",
                    },
                }),
            }
        );

        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            console.error("Gemini API error:", errorText);
            return NextResponse.json({ error: "Gemini API request failed" }, { status: 502 });
        }

        const geminiData = await geminiResponse.json();
        const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawText) {
            return NextResponse.json({ error: "No response from Gemini" }, { status: 502 });
        }

        // Parse the JSON array from Gemini's response
        let aiTasks: { name: string; startDate: string; endDate: string; color: string }[];
        try {
            aiTasks = JSON.parse(rawText);
            if (!Array.isArray(aiTasks)) throw new Error("Not an array");
        } catch {
            // Try to extract JSON array from the response text
            const match = rawText.match(/\[[\s\S]*\]/);
            if (!match) {
                return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
            }
            aiTasks = JSON.parse(match[0]);
        }

        // Save tasks to database
        const maxOrder = await prisma.scheduleTask.aggregate({
            where: { projectId },
            _max: { order: true },
        });
        let order = (maxOrder._max.order ?? -1) + 1;

        const created = [];
        for (const task of aiTasks) {
            if (!task.name || !task.startDate || !task.endDate) continue;
            const newTask = await prisma.scheduleTask.create({
                data: {
                    projectId,
                    name: task.name,
                    startDate: new Date(task.startDate),
                    endDate: new Date(task.endDate),
                    color: task.color || "#4c9a2a",
                    order: order++,
                    status: "Not Started",
                },
            });
            created.push({
                ...newTask,
                startDate: task.startDate,
                endDate: task.endDate,
            });
        }

        return NextResponse.json({ tasks: created, count: created.length });
    } catch (err: any) {
        console.error("AI Schedule error:", err);
        return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
    }
}
