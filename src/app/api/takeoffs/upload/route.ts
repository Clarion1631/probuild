import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import { v4 as uuidv4 } from "uuid";

// This route handles BOTH:
// 1. Small files (<4MB): Direct upload through the API
// 2. Large files: Returns signed upload URLs for direct-to-Supabase upload

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    const supabase = getSupabase();
    if (!supabase) {
        return NextResponse.json(
            { error: "Storage not configured. Contact admin to set SUPABASE_URL and SUPABASE_SERVICE_KEY." },
            { status: 500 }
        );
    }

    // Check if this is a JSON request (for signed URL generation) or FormData (for direct upload)
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
        // === SIGNED URL MODE: Generate upload URLs for large files ===
        const body = await req.json();
        const { takeoffId, files } = body;

        if (!takeoffId || !files?.length) {
            return NextResponse.json({ error: "takeoffId and files array required" }, { status: 400 });
        }

        const takeoff = await prisma.takeoff.findUnique({ where: { id: takeoffId } });
        if (!takeoff) {
            return NextResponse.json({ error: "Takeoff not found" }, { status: 404 });
        }

        const uploadUrls = [];
        for (const file of files) {
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
            const storagePath = `takeoffs/${takeoffId}/${uuidv4()}_${safeName}`;

            // Create a signed URL for direct upload (valid for 10 minutes)
            const { data: signedData, error: signedError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .createSignedUploadUrl(storagePath);

            if (signedError) {
                console.error("Signed URL error:", signedError);
                return NextResponse.json(
                    { error: `Failed to create upload URL: ${signedError.message}` },
                    { status: 500 }
                );
            }

            // Get the public URL for this path
            const { data: urlData } = supabase.storage
                .from(STORAGE_BUCKET)
                .getPublicUrl(storagePath);

            uploadUrls.push({
                fileName: file.name,
                mimeType: file.type || "application/octet-stream",
                size: file.size || 0,
                storagePath,
                signedUrl: signedData.signedUrl,
                token: signedData.token,
                publicUrl: urlData.publicUrl,
            });
        }

        return NextResponse.json({ uploadUrls });
    }

    // === DIRECT UPLOAD MODE: For smaller files (<4MB) ===
    let formData;
    try {
        formData = await req.formData();
    } catch (parseErr: any) {
        console.error("FormData parse error:", parseErr);
        return NextResponse.json(
            { error: `File too large for server upload. Use the signed URL method for files over 4MB.` },
            { status: 413 }
        );
    }

    const takeoffId = formData.get("takeoffId") as string;
    const files = formData.getAll("files") as File[];

    if (!takeoffId) {
        return NextResponse.json({ error: "takeoffId required" }, { status: 400 });
    }

    if (!files || files.length === 0) {
        return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    const takeoff = await prisma.takeoff.findUnique({ where: { id: takeoffId } });
    if (!takeoff) {
        return NextResponse.json({ error: "Takeoff not found" }, { status: 404 });
    }

    const uploadedFiles: any[] = [];

    for (const file of files) {
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `takeoffs/${takeoffId}/${uuidv4()}_${safeName}`;

        const { error: uploadError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, buffer, {
                contentType: file.type || "application/octet-stream",
                upsert: false,
            });

        if (uploadError) {
            console.error("Supabase upload error:", uploadError);
            return NextResponse.json(
                { error: `Storage upload failed: ${uploadError.message}` },
                { status: 500 }
            );
        }

        const { data: urlData } = supabase.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(storagePath);

        const publicUrl = urlData?.publicUrl || storagePath;

        const takeoffFile = await prisma.takeoffFile.create({
            data: {
                takeoffId,
                name: file.name,
                url: publicUrl,
                mimeType: file.type || "application/octet-stream",
                size: buffer.length,
            },
        });

        uploadedFiles.push(takeoffFile);
    }

    return NextResponse.json({ files: uploadedFiles, count: uploadedFiles.length }, { status: 201 });
}
