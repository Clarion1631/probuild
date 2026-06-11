import { NextResponse } from "next/server";
import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import { oauth2Client, loadToken } from "@/lib/gmail-client";
import { parseReceiptWithAI } from "@/lib/receipt-ai";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Daily receipts ingestion from Google Drive.
 *
 * Vanessa's intake structure: a receipts folder whose subfolders are project
 * names ("Berg ADU", "Mesplay Kitchen", …) — optionally nested under a
 * "New Receipts & Checks" folder. Each new image/PDF is parsed with AI and
 * created as a Pending expense on the matching project's latest estimate,
 * then reviewed in /manager/receipts before it counts as final.
 */
const FOLDER_ID = process.env.DRIVE_RECEIPTS_FOLDER_ID || "1sv8xcq9Z90xSmtHuvpe9vvcU7colvGc0";
const MAX_FILES_PER_RUN = 6;
const FILE_MIME_OK = (m: string) => m === "application/pdf" || m.startsWith("image/");

function normalize(s: string): string[] {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Match a Drive folder name ("Mueller Bathroom") to a project ("Mueller Remodel"). */
function matchProject(folderName: string, projects: { id: string; name: string }[]): { id: string; name: string } | null {
    const folderWords = normalize(folderName);
    if (folderWords.length === 0) return null;
    let best: { p: { id: string; name: string }; score: number } | null = null;
    for (const p of projects) {
        const projWords = normalize(p.name);
        const shared = folderWords.filter(w => projWords.includes(w)).length;
        // First word (usually the client surname) must match to count at all.
        const firstMatches = projWords.includes(folderWords[0]);
        const score = firstMatches ? shared + 1 : shared >= 2 ? shared : 0;
        if (score > 0 && (!best || score > best.score)) best = { p, score };
    }
    return best?.p ?? null;
}

export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    if (process.env.VERCEL_ENV === "production" && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!loadToken()) {
        return NextResponse.json({ error: "Google not connected — run the Gmail/Drive connect flow" }, { status: 503 });
    }
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    const summary = {
        foldersScanned: 0,
        filesSeen: 0,
        expensesCreated: 0,
        skippedExisting: 0,
        unmatchedFolders: [] as string[],
        projectsWithoutEstimate: [] as string[],
        errors: [] as string[],
    };

    try {
        // Collect project subfolders (depth ≤ 2; descend through intake folders like "New Receipts & Checks")
        const listFolders = async (parentId: string) => {
            const res = await drive.files.list({
                q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: "files(id, name)",
                pageSize: 100,
            });
            return res.data.files || [];
        };

        let projectFolders = await listFolders(FOLDER_ID);
        const intake = projectFolders.find(f => /new receipts/i.test(f.name || ""));
        if (intake?.id) {
            projectFolders = [...projectFolders.filter(f => f.id !== intake.id), ...(await listFolders(intake.id))];
        }

        const projects = await prisma.project.findMany({
            select: {
                id: true, name: true,
                estimates: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } },
            },
        });

        let budget = MAX_FILES_PER_RUN;
        for (const folder of projectFolders) {
            if (budget <= 0) break;
            const name = folder.name || "";
            if (/needs review|processed|archive|upload ready/i.test(name)) continue;
            summary.foldersScanned++;

            const project = matchProject(name, projects);
            if (!project) {
                summary.unmatchedFolders.push(name);
                continue;
            }
            const estimateId = projects.find(p => p.id === project.id)?.estimates[0]?.id;
            if (!estimateId) {
                summary.projectsWithoutEstimate.push(project.name);
                continue;
            }

            const filesRes = await drive.files.list({
                q: `'${folder.id}' in parents and trashed = false`,
                fields: "files(id, name, mimeType, webViewLink, size)",
                pageSize: 50,
            });

            for (const file of filesRes.data.files || []) {
                if (budget <= 0) break;
                if (!file.id || !file.mimeType || !FILE_MIME_OK(file.mimeType)) continue;
                if (file.size && Number(file.size) > 15 * 1024 * 1024) continue;
                summary.filesSeen++;

                // Dedupe on the Drive file id embedded in receiptUrl
                const existing = await prisma.expense.findFirst({
                    where: { receiptUrl: { contains: file.id } },
                    select: { id: true },
                });
                if (existing) {
                    summary.skippedExisting++;
                    continue;
                }

                budget--;
                try {
                    const dl = await drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "arraybuffer" });
                    const base64 = Buffer.from(dl.data as ArrayBuffer).toString("base64");
                    const parsed = await parseReceiptWithAI(base64, file.mimeType);

                    if (!parsed.vendor || typeof parsed.total !== "number" || parsed.total <= 0) {
                        summary.errors.push(`${file.name}: parse incomplete (vendor/total missing)`);
                        continue;
                    }

                    const confidence = Math.round((parsed.confidence || 0) * 100);
                    await prisma.expense.create({
                        data: {
                            estimateId,
                            amount: parsed.total,
                            vendor: parsed.vendor,
                            date: parsed.date ? new Date(parsed.date) : new Date(),
                            description: `[AI ${confidence}%] ${parsed.vendor} — ${file.name} (auto-imported from Drive) — pending bookkeeper review`,
                            receiptUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
                            status: "Pending",
                        },
                    });
                    summary.expensesCreated++;
                } catch (e) {
                    summary.errors.push(`${file.name}: ${e instanceof Error ? e.message : "ingest failed"}`);
                }
            }
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : "Drive scan failed";
        // Most common cause: token lacks Drive scope — reconnect Google after the scope update.
        summary.errors.push(msg);
        return NextResponse.json({ ...summary, hint: msg.includes("insufficient") || msg.includes("scope") ? "Reconnect Google (Settings) to grant Drive access" : undefined }, { status: 200 });
    }

    if (summary.expensesCreated > 0 || summary.errors.length > 0) {
        console.log("[cron/drive-receipts]", JSON.stringify(summary));
    }
    return NextResponse.json(summary);
}
