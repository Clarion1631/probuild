import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import { authenticateMobileOrSession, assertProjectAccess } from "@/lib/mobile-auth";

export const dynamic = "force-dynamic";

// POST /api/mobile/tasks/:id/photo-upload-url
// Body: { mimeType?: string, ext?: string }
// Returns: { signedUrl, token, publicUrl, storagePath }
// Client PUTs the image bytes directly to signedUrl, then sends publicUrl
// in the photoUrls array of POST /api/mobile/tasks/:id/comments.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const auth = await authenticateMobileOrSession(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { user } = auth;
    const { id: taskId } = await params;

    const task = await prisma.scheduleTask.findUnique({
        where: { id: taskId },
        select: { id: true, projectId: true },
    });
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!task.projectId) return NextResponse.json({ error: "Task not on a project" }, { status: 400 });
    const projectId = task.projectId;

    const fail = await assertProjectAccess(user, projectId);
    if (fail) return fail;

    let body: any = {};
    try {
        body = await req.json();
    } catch {
        // body optional
    }
    const ext = (typeof body?.ext === "string" ? body.ext : "jpg").replace(/[^a-zA-Z0-9]/g, "").slice(0, 5) || "jpg";

    const supabase = getSupabase();
    if (!supabase) return NextResponse.json({ error: "Storage not configured" }, { status: 500 });

    const uniq =
        (typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2)) + "";
    const storagePath = `task-comments/${projectId}/${taskId}/${Date.now()}_${uniq.slice(0, 8)}.${ext}`;

    const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUploadUrl(storagePath);
    if (error || !data) {
        return NextResponse.json({ error: error?.message ?? "Failed to create signed URL" }, { status: 500 });
    }
    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);

    return NextResponse.json({
        signedUrl: data.signedUrl,
        token: data.token,
        publicUrl: urlData.publicUrl,
        storagePath,
    });
}
