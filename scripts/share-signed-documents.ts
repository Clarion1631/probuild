// Restore client access to signed documents that were filed invisibly.
//
// approveEstimate filed signed-estimate PDFs into a "Signed Documents" folder
// created with the default (team) visibility, and the file rows carried no
// explicit visibility. The portal only lists folders whose whole ancestor chain
// is "shared", so those documents were unreachable by the very client who signed
// them. archiveExecutedContractPdf always got this right (explicit "shared", at
// the project root), which is why executed contracts were visible and signed
// estimates were not.
//
// This promotes each "Signed Documents" folder to shared and stamps the files
// inside with an EXPLICIT "shared" so they survive any future move.
//
// Dry-run is the default:
//   npx tsx --env-file=.env.local scripts/share-signed-documents.ts
// Apply after reviewing:
//   npx tsx --env-file=.env.local scripts/share-signed-documents.ts --write
//
// Deliberately narrow: ONLY folders literally named "Signed Documents". Nothing
// else is touched, because flipping a folder to shared is a client-visible
// action and must never be inferred loosely.
import { prisma } from "../src/lib/prisma";

const FOLDER_NAME = "Signed Documents";
const write = process.argv.includes("--write");

async function main() {
    const folders = await prisma.fileFolder.findMany({
        where: { name: FOLDER_NAME },
        select: {
            id: true,
            visibility: true,
            parentId: true,
            project: { select: { name: true, status: true } },
            files: { select: { id: true, name: true, visibility: true } },
        },
    });

    let foldersToPromote = 0;
    let filesToStamp = 0;

    for (const folder of folders) {
        const needsFolder = folder.visibility !== "shared";
        const staleFiles = folder.files.filter(f => f.visibility !== "shared");
        if (!needsFolder && staleFiles.length === 0) continue;
        foldersToPromote += needsFolder ? 1 : 0;
        filesToStamp += staleFiles.length;

        console.log(`\n${folder.project?.name ?? "(no project)"} [${folder.project?.status ?? "-"}]`);
        if (folder.parentId) console.log("  ! nested folder — its ancestors must be shared too for the client to reach it");
        console.log(`  folder: ${folder.visibility}${needsFolder ? " -> shared" : " (already shared)"}`);
        for (const f of staleFiles) console.log(`    file: ${f.name} [${f.visibility ?? "inherited"}] -> shared`);

        if (write) {
            await prisma.$transaction(async tx => {
                if (needsFolder) {
                    await tx.fileFolder.update({ where: { id: folder.id }, data: { visibility: "shared" } });
                }
                if (staleFiles.length > 0) {
                    await tx.projectFile.updateMany({
                        where: { id: { in: staleFiles.map(f => f.id) } },
                        data: { visibility: "shared" },
                    });
                }
            });
        }
    }

    const summary = `${foldersToPromote} folder(s) promoted to shared, ${filesToStamp} file(s) stamped explicitly shared`;
    console.log(
        write
            ? `\nWRITE complete: ${summary}.`
            : `\nDRY-RUN: would apply ${summary}. Re-run with --write to apply.`,
    );
    if (foldersToPromote === 0 && filesToStamp === 0) console.log("Nothing to do — every signed document is already client-visible.");
}

main()
    .catch(error => {
        console.error("share-signed-documents failed:", error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
