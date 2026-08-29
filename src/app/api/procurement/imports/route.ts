import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canAccessProject, getCurrentUserWithPermissions } from "@/lib/permissions";
import { downloadDocBytes, toSecureRef, uploadSecureDoc } from "@/lib/secure-storage";
import { parseProcurementXlsx } from "@/lib/procurement-import";
import { evaluateStagedProject, ingestIdentity } from "@/lib/procurement-contract";

const MAX_XLSX_BYTES = 15 * 1024 * 1024;
const XLSX_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeFilename(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized.endsWith(".xlsx") ? normalized : `${normalized || "materials"}.xlsx`;
}

function commitScopeHash(projectId: string, layoutVersion: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ projectId, layoutVersion, parserContract: "procurement-xlsx-v1" }))
    .digest("hex");
}

function jsonValue(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

async function retainImmutableImport(
  storageObjectPath: string,
  bytes: Buffer,
  sourceHash: string,
): Promise<string> {
  const storagePath = toSecureRef(storageObjectPath);
  const existing = await downloadDocBytes(storagePath);
  if (existing) {
    if (createHash("sha256").update(existing).digest("hex") !== sourceHash) {
      throw new Error("Immutable procurement storage path contains different content");
    }
    return storagePath;
  }

  try {
    return await uploadSecureDoc(
      storageObjectPath,
      bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  } catch (error) {
    // A concurrent retry may have won the immutable object write. Verify the
    // exact retained bytes before treating that storage conflict as a replay.
    const raced = await downloadDocBytes(storagePath);
    if (raced && createHash("sha256").update(raced).digest("hex") === sourceHash) {
      return storagePath;
    }
    throw error;
  }
}

function sourceProjectIdForSelected(sourceProjectRef: string | null, selectedProject: { id: string; name: string }): string | null {
  if (!sourceProjectRef) return null;
  // No fuzzy/name search is allowed. A source row agrees only when it names the
  // project selected by this import exactly; any other non-empty value is a hold.
  return sourceProjectRef === selectedProject.name ? selectedProject.id : "__PROJECT_CONFLICT__";
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUserWithPermissions();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!["ADMIN", "MANAGER"].includes(user.role)) {
      return NextResponse.json({ error: "Procurement import requires office access" }, { status: 403 });
    }

    const form = await req.formData();
    const projectId = form.get("projectId");
    const requestKey = form.get("requestId");
    const file = form.get("file");
    if (typeof projectId !== "string" || !projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    if (typeof requestKey !== "string" || !UUID.test(requestKey)) {
      return NextResponse.json({ error: "requestId must be a UUID retained for retry" }, { status: 400 });
    }
    if (!(file instanceof File) || file.size === 0 || file.size > MAX_XLSX_BYTES) {
      return NextResponse.json({ error: "Upload one non-empty XLSX file no larger than 15 MB" }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".xlsx") || !XLSX_TYPES.has(file.type || "application/octet-stream")) {
      return NextResponse.json({ error: "Only .xlsx procurement files are accepted" }, { status: 400 });
    }
    if (!canAccessProject(user, projectId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const ingestKey = ingestIdentity.directXlsx(requestKey);
    const findExistingImport = () => prisma.materialImportRun.findUnique({
      where: { ingestPath_requestKey: { ingestPath: "DIRECT_XLSX", requestKey: ingestKey } },
      select: { id: true, sourceHash: true, commitScopeHash: true, status: true, rowCount: true, dataGapCount: true, conflictCount: true },
    });

    const existing = await findExistingImport();

    const bytes = Buffer.from(await file.arrayBuffer());
    const parsed = await parseProcurementXlsx(bytes);
    const scopeHash = commitScopeHash(project.id, parsed.layoutVersion);
    if (existing) {
      if (existing.sourceHash !== parsed.sha256 || existing.commitScopeHash !== scopeHash) {
        return NextResponse.json({ error: "That requestId belongs to a different file or selected project" }, { status: 409 });
      }
      return NextResponse.json({ ok: true, retry: true, importRun: existing });
    }

    // The validated request UUID namespaces each immutable upload. A retry uses
    // the same object, while distinct requests cannot collide on matching bytes.
    const storageObjectPath = `procurement/imports/${project.id}/${requestKey}/${parsed.sha256}/${safeFilename(file.name)}`;
    let storagePath: string;
    try {
      // Raw procurement exports are internal cost records. Preserve them in the
      // private bucket, not the public project-files bucket.
      storagePath = await retainImmutableImport(
        storageObjectPath,
        bytes,
        parsed.sha256,
      );
    } catch {
      return NextResponse.json({ error: "Could not retain the original XLSX" }, { status: 500 });
    }

    const reviewRows = parsed.rows.map((row) => {
      const scope = evaluateStagedProject({
        selectedProjectId: project.id,
        rowProjectId: sourceProjectIdForSelected(row.sourceProjectRef, project),
      });
      return {
        rowNumber: row.rowNumber,
        description: row.description,
        sourceProjectRef: row.sourceProjectRef,
        validationState: scope.state,
      };
    });
    const stagedRows = parsed.rows.map((row, index) => ({
      rowNumber: row.rowNumber,
      rawJson: jsonValue(row.raw),
      normalizedJson: jsonValue({ ...row, raw: undefined }),
      validationState: reviewRows[index].validationState,
    }));
    const dataGapCount = stagedRows.filter((row) => row.validationState === "DATA_GAP").length;
    const conflictCount = stagedRows.filter((row) => row.validationState === "PROJECT_CONFLICT").length;
    let importRun;
    try {
      importRun = await prisma.materialImportRun.create({
        data: {
          ingestPath: "DIRECT_XLSX",
          requestKey: ingestKey,
          sourceFileName: file.name,
          storagePath,
          sourceHash: parsed.sha256,
          commitScopeHash: scopeHash,
          requestedProjectId: project.id,
          createdById: user.id,
          rowCount: stagedRows.length,
          dataGapCount,
          conflictCount,
          rows: { create: stagedRows },
        },
        select: { id: true, status: true, rowCount: true, dataGapCount: true, conflictCount: true },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await findExistingImport();
      if (!raced) throw error;
      if (raced.sourceHash !== parsed.sha256 || raced.commitScopeHash !== scopeHash) {
        return NextResponse.json({ error: "That requestId belongs to a different file or selected project" }, { status: 409 });
      }
      return NextResponse.json({ ok: true, retry: true, importRun: raced });
    }

    return NextResponse.json({ ok: true, retry: false, importRun, reviewRows }, { status: 201 });
  } catch (error) {
    console.error("[procurement/imports] stage failed", error);
    return NextResponse.json({ error: "Could not stage the procurement XLSX" }, { status: 500 });
  }
}
