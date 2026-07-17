import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateMobileOrSession, userCanAccessProject } from "@/lib/mobile-auth";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicText } from "@/lib/anthropic";
import { CABINETS, APPLIANCES, FIXTURES, LIGHTING, FURNITURE } from "@/lib/studio/catalog";
import type { DesignDoc, PlacedItem, ApiRoomAsset } from "@/lib/studio/doc";
import { newItemId, toApiPayload } from "@/lib/studio/doc";
import { generateUsdzForRoom } from "@/lib/studio/usdz-generator";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    const { id } = await params;

    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const room = await prisma.roomDesign.findUnique({
        where: { id },
        select: { id: true, name: true, projectId: true, leadId: true, layoutJson: true },
    });
    if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Owner checks
    if (room.projectId) {
        const allowed = await userCanAccessProject(user, room.projectId);
        if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    } else if (room.leadId && user.role !== "ADMIN") {
        const lead = await prisma.lead.findFirst({
            where: { id: room.leadId, managerId: user.id },
            select: { id: true },
        });
        if (!lead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: { prompt?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const promptText = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!promptText) {
        return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    let doc: DesignDoc;
    try {
        doc = typeof room.layoutJson === "string" ? JSON.parse(room.layoutJson) : (room.layoutJson as unknown as DesignDoc);
    } catch (e) {
        return NextResponse.json({ error: "Invalid room layout JSON" }, { status: 500 });
    }

    // Keep structural items (doors, windows, cased openings)
    const structuralItems = doc.items.filter((it) => {
        const category = it.defId.includes("door") || it.defId.includes("window") || it.defId.includes("doorway");
        return category;
    });

    // Catalog items info to pass to Claude
    const catalogSubset = [...CABINETS, ...APPLIANCES, ...FIXTURES, ...LIGHTING, ...FURNITURE].map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        w: item.w,
        d: item.d,
        h: item.h,
        mount: item.mount,
        wallSnap: item.wallSnap,
    }));

    const systemPrompt = `You are an expert interior designer and construction layout planner. Your job is to furnish a room design in 3D coordinate space based on a user's prompt.

Room Specifications:
- Points defining the room boundary polygon (clockwise, in meters): ${JSON.stringify(doc.room.points)}
- Room Ceiling Height: ${doc.room.height} meters
- Wall Thickness: ${doc.room.wallThickness} meters

Fixed Features (DO NOT MOVE OR DELETE THESE ITEMS):
These doors, windows, and openings are already captured in place. You must position furniture and cabinetry so they do not overlap these coordinate positions:
${JSON.stringify(structuralItems)}

Available Catalog Items:
${JSON.stringify(catalogSubset)}

Coordinate System Rules:
1. Origin (0,0) is approximately the center of the room.
2. X is left/right (east/west), Z is up/down (north/south) in plan view. Y is elevation above the floor.
3. Every item you place must be inside the room polygon defined by the points.
4. Items placed against a wall should be offset from the wall by half of their depth (item.d / 2) towards the room interior.
5. Match rotations (in radians) to align with the walls:
   - North walls (top edges): rotation = 0 (facing south)
   - East walls (right edges): rotation = Math.PI / 2 (1.57, facing west)
   - South walls (bottom edges): rotation = Math.PI (3.14, facing north)
   - West walls (left edges): rotation = -Math.PI / 2 (-1.57, facing east)
6. Cabinet layouts should be continuous (e.g. base-door next to base-sink next to dishwasher next to base-drawers along a wall run).
7. Ensure appliances (range, fridge, dishwasher) are placed in logical kitchen triangles if applicable.
8. Furniture (sofas, tables) should be placed in the interior space, leaving pathways clear.

Your Output:
Return ONLY valid JSON containing an array of new items to place. Do not include any markdown styling, comments, or conversational text.
Return JSON in this exact shape:
{
  "items": [
    {
      "defId": "<catalog item id>",
      "x": <number>,
      "z": <number>,
      "y": <number, elevation above floor (usually 0 for floor mount, or elevation value for wall cabinet/counter items)>,
      "rotation": <number, rotation in radians>,
      "w": <number, optional width override>,
      "d": <number, optional depth override>,
      "h": <number, optional height override>
    }
  ]
}`;

    const userPrompt = `Please furnish this room according to the following description: "${promptText}"`;

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        console.log("Calling Claude for design layout...");
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4000,
            messages: [
                { role: "user", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
        });

        const rawText = getAnthropicText(response.content).trim();
        let parsed: { items: any[] };
        try {
            parsed = JSON.parse(rawText);
        } catch {
            const objMatch = rawText.match(/\{[\s\S]*\}/);
            if (objMatch) {
                parsed = JSON.parse(objMatch[0]);
            } else {
                throw new Error("Could not parse JSON from AI response");
            }
        }

        const newItems: PlacedItem[] = (parsed.items || []).map((it: any) => ({
            id: newItemId(),
            defId: String(it.defId),
            x: Number(it.x ?? 0),
            z: Number(it.z ?? 0),
            y: it.y !== undefined ? Number(it.y) : undefined,
            rotation: Number(it.rotation ?? 0),
            w: it.w !== undefined ? Number(it.w) : undefined,
            d: it.d !== undefined ? Number(it.d) : undefined,
            h: it.h !== undefined ? Number(it.h) : undefined,
        }));

        // Merge structural items and AI items
        const mergedItems = [...structuralItems, ...newItems];
        const updatedDoc: DesignDoc = {
            ...doc,
            items: mergedItems,
        };

        const { assets } = toApiPayload(updatedDoc);

        // Save in transaction
        console.log("Saving generated layout to database...");
        await prisma.$transaction(async (tx) => {
            await tx.roomDesign.update({
                where: { id },
                data: { layoutJson: updatedDoc as any },
            });
            await tx.roomAsset.deleteMany({ where: { roomDesignId: id } });
            if (assets.length > 0) {
                await tx.roomAsset.createMany({
                    data: assets.map((a) => ({
                        roomDesignId: id,
                        assetType: String(a.assetType ?? "decor"),
                        assetId: String(a.assetId ?? ""),
                        positionX: Number(a.positionX ?? 0),
                        positionY: Number(a.positionY ?? 0),
                        positionZ: Number(a.positionZ ?? 0),
                        rotationY: Number(a.rotationY ?? 0),
                        scaleX: Number(a.scaleX ?? 1),
                        scaleY: Number(a.scaleY ?? 1),
                        scaleZ: Number(a.scaleZ ?? 1),
                        metadata: (a.metadata ?? null) as any,
                    })),
                });
            }
        });

        // Trigger USDZ regeneration
        console.log("Triggering USDZ export...");
        const scanUsdzUrl = await generateUsdzForRoom(id);

        const updatedRoom = await prisma.roomDesign.findUnique({
            where: { id },
            include: { assets: true },
        });

        return NextResponse.json({
            ok: true,
            room: updatedRoom,
            scanUsdzUrl,
        });

    } catch (err: any) {
        console.error("AI Room Furnish error:", err);
        return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 });
    }
}
