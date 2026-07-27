import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import { SECURE_BUCKET } from "@/lib/secure-storage";
import { authenticateMobileOrSession, userCanAccessProject } from "@/lib/mobile-auth";
import { hasPermission } from "@/lib/permissions";

export const maxDuration = 30;

type FileInfo = { name: string; size: number; mimeType: string };

// Server-validated allowlist of private upload scopes — the client can only ask for one
// of these named scopes, never an arbitrary bucket. "contract-original" is the only one
// today: a contract PDF original uploaded via EntityContractsClient, which must land in
// the private secure-docs bucket rather than the public project-files bucket.
const PRIVATE_UPLOAD_SCOPES = new Set(["contract-original"]);

// POST: generate signed upload URLs so the browser can upload directly to Supabase,
// bypassing Vercel's 4.5 MB serverless payload limit. Hybrid auth — accepts NextAuth
// session (web) or mobile JWT (mobile).
export async function POST(req: NextRequest) {
    try {
        const auth = await authenticateMobileOrSession(req);
        if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
        const { user } = auth;

        const supabase = getSupabase();
        if (!supabase) {
            return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
        }

        const body = await req.json();
        const { projectId, leadId, folderId, files, visibility, scope } = body as {
            projectId?: string;
            leadId?: string;
            folderId?: string;
            files: FileInfo[];
            visibility?: string;
            scope?: string;
        };

        if (!projectId && !leadId) {
            return NextResponse.json({ error: "projectId or leadId required" }, { status: 400 });
        }
        if (!files?.length) {
            return NextResponse.json({ error: "files required" }, { status: 400 });
        }

        // A named, server-validated scope routes the upload to the private secure-docs
        // bucket instead of the public one. Never take a bucket name from the client.
        let targetBucket: string = STORAGE_BUCKET;
        if (scope !== undefined) {
            if (typeof scope !== "string" || !PRIVATE_UPLOAD_SCOPES.has(scope)) {
                return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
            }
            // Private scopes are for staff-only document flows (e.g. contract originals) —
            // gate them the same way the DB record that will reference the upload is gated.
            if (user.role !== "ADMIN" && user.role !== "MANAGER") {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
            targetBucket = SECURE_BUCKET;
        }

        if (visibility === "financial") {
            const userWithPerms = await prisma.user.findUnique({
                where: { id: user.id },
                include: { permissions: true },
            });
            if (!userWithPerms || !hasPermission(userWithPerms, "financialReports")) {
                return NextResponse.json({ error: "No permission to create financial files" }, { status: 403 });
            }
        }

        if (projectId) {
            // Reuse the canonical project-access check (ProjectAccess record OR crew
            // assignment OR ADMIN/MANAGER role) so mobile and web behave identically.
            const allowed = await userCanAccessProject(user, projectId);
            if (!allowed) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        } else if (leadId) {
            // Lead uploads are web-only flows (no mobile equivalent today). ADMINs always
            // pass; MANAGERs and everyone else must own the lead. This matches the gate
            // on /api/files/register so a caller can't get a signed URL they can't then
            // register against.
            if (user.role !== "ADMIN") {
                const lead = await prisma.lead.findFirst({
                    where: { id: leadId, managerId: user.id },
                    select: { id: true },
                });
                if (!lead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        }

        const uploads = await Promise.all(
            files.map(async (f: FileInfo) => {
                const prefix = projectId ? `projects/${projectId}` : `leads/${leadId}`;
                const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
                // Collision safety: two files registered in the same millisecond would
                // share a path without a random suffix. UUID v4 keeps storage paths unique.
                const uniq =
                    (typeof crypto !== "undefined" && "randomUUID" in crypto
                        ? crypto.randomUUID()
                        : Math.random().toString(36).slice(2)) + "";
                const storagePath = `${prefix}/${Date.now()}_${uniq.slice(0, 8)}_${safeName}`;

                const { data, error } = await supabase.storage
                    .from(targetBucket)
                    .createSignedUploadUrl(storagePath);

                if (error || !data) {
                    throw new Error(`Failed to create signed URL for ${f.name}: ${error?.message}`);
                }

                // The private bucket has no public URL — a caller must resolve a signed URL
                // server-side via resolveDocUrl() instead. Only build one for the public bucket.
                const publicUrl = targetBucket === STORAGE_BUCKET
                    ? supabase.storage.from(targetBucket).getPublicUrl(storagePath).data.publicUrl
                    : null;

                return {
                    signedUrl: data.signedUrl,
                    token: data.token,
                    storagePath,
                    publicUrl,
                    name: f.name,
                    size: f.size,
                    mimeType: f.mimeType,
                    projectId,
                    leadId,
                    folderId,
                    visibility,
                };
            })
        );

        return NextResponse.json({ uploads });
    } catch (err: any) {
        console.error("POST /api/files/signed-upload error:", err);
        return NextResponse.json({ error: err.message || "Failed to create signed URLs" }, { status: 500 });
    }
}
