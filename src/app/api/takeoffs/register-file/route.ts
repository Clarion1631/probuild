import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// POST /api/takeoffs/register-file
// Registers a file record in the database after a direct-to-Supabase upload
export async function POST(req: NextRequest) {
    const body = await req.json();
    const { takeoffId, files } = body;

    if (!takeoffId || !files?.length) {
        return NextResponse.json({ error: "takeoffId and files array required" }, { status: 400 });
    }

    const takeoff = await prisma.takeoff.findUnique({ where: { id: takeoffId } });
    if (!takeoff) {
        return NextResponse.json({ error: "Takeoff not found" }, { status: 404 });
    }

    const created = [];
    for (const file of files) {
        const record = await prisma.takeoffFile.create({
            data: {
                takeoffId,
                name: file.name,
                url: file.url,
                mimeType: file.mimeType || "application/octet-stream",
                size: file.size || 0,
            },
        });
        created.push(record);
    }

    return NextResponse.json({ files: created, count: created.length }, { status: 201 });
}
