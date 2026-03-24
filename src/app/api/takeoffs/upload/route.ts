import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "";
const BUCKET = "project-files";

export async function POST(req: NextRequest) {
    const formData = await req.formData();
    const takeoffId = formData.get("takeoffId") as string;
    const files = formData.getAll("files") as File[];

    if (!takeoffId) {
        return NextResponse.json({ error: "takeoffId required" }, { status: 400 });
    }

    if (files.length === 0) {
        return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    // Verify the takeoff exists
    const takeoff = await prisma.takeoff.findUnique({ where: { id: takeoffId } });
    if (!takeoff) {
        return NextResponse.json({ error: "Takeoff not found" }, { status: 404 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const uploadedFiles: any[] = [];

    for (const file of files) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const ext = file.name.split(".").pop() || "bin";
        const storagePath = `takeoffs/${takeoffId}/${uuidv4()}.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from(BUCKET)
            .upload(storagePath, buffer, {
                contentType: file.type || "application/octet-stream",
                upsert: false,
            });

        if (uploadError) {
            console.error("Upload error:", uploadError);
            continue;
        }

        const { data: urlData } = supabase.storage
            .from(BUCKET)
            .getPublicUrl(storagePath);

        const takeoffFile = await prisma.takeoffFile.create({
            data: {
                takeoffId,
                name: file.name,
                url: urlData.publicUrl,
                mimeType: file.type || "application/octet-stream",
                size: file.size,
            },
        });

        uploadedFiles.push(takeoffFile);
    }

    return NextResponse.json({ files: uploadedFiles, count: uploadedFiles.length }, { status: 201 });
}
