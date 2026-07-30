import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeSelectionItemCommentBody,
  SELECTION_ITEM_COMMENT_MAX_LENGTH,
  postSelectionItemComment,
} from "../src/lib/selection-item-thread-core";

assert.equal(SELECTION_ITEM_COMMENT_MAX_LENGTH, 4000);
assert.equal(normalizeSelectionItemCommentBody("  Let's talk about this one  "), "Let's talk about this one");
assert.equal(normalizeSelectionItemCommentBody(""), "");
assert.throws(
  () => normalizeSelectionItemCommentBody("x".repeat(4001)),
  /4,000 characters or fewer/,
);

const route = readFileSync(
  join(process.cwd(), "src/app/api/selections/item-comments/route.ts"),
  "utf8",
);
assert.match(
  route,
  /import \{ assertDecisionActorAccess \} from "@\/lib\/actions";/,
);
assert.match(
  route,
  /assertAccess: assertDecisionActorAccess,/,
  "the route must wire assertDecisionActorAccess as the core's assertAccess dependency",
);

// Ordering: assertAccess must be resolved before any upload happens. The
// core enforces this at the call-site level (uploadAttachments is only
// invoked after assertAccess resolves), so this checks the core module
// itself rather than the route (which just supplies dependencies).
const core = readFileSync(
  join(process.cwd(), "src/lib/selection-item-thread-core.ts"),
  "utf8",
);
const assertAccessIndex = core.indexOf("const actor = await dependencies.assertAccess(item.projectId);");
const uploadIndex = core.indexOf("await dependencies.uploadAttachments(files, actor, item)");
assert.ok(
  assertAccessIndex >= 0 && uploadIndex > assertAccessIndex,
  "assertAccess must resolve before uploadAttachments is ever called",
);

// CAS guard: the row-lock no-op write on deletedAt must exist in the
// production createComment implementation.
const dependencies = readFileSync(
  join(process.cwd(), "src/lib/selection-item-thread-dependencies.ts"),
  "utf8",
);
assert.match(
  dependencies,
  /where:\s*\{\s*id:\s*item\.id,\s*deletedAt:\s*null\s*\}/,
  "createComment must lock the proposal row with a deletedAt CAS guard before creating the comment",
);

// Provenance: CLIENT-posted attachments must keep uploadedByClient: true.
assert.match(
  dependencies,
  /uploadedByClient:\s*!actor\.isStaff,/,
  "uploadAttachments must pass uploadedByClient through to saveProjectFile",
);
const actions = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
const projectFiles = readFileSync(join(process.cwd(), "src/lib/project-files.ts"), "utf8");
assert.match(
  projectFiles,
  /uploadedByClient:\s*input\.uploadedByClient\s*\?\?\s*false,/,
  "saveProjectFile must persist the uploadedByClient input",
);

// Whole-batch cleanup wiring: the core must call cleanupAttachments when
// createComment throws, the route must wire the production cleanupAttachments
// dependency, and it must reuse the same rollback helper uploadAttachments
// uses for its own in-batch failures (not a separate, divergent path).
assert.match(
  core,
  /catch \(err\) \{[\s\S]{0,600}dependencies\.cleanupAttachments\(attachments\)/,
  "postSelectionItemComment must call cleanupAttachments when createComment throws",
);
assert.match(
  route,
  /cleanupAttachments,/,
  "the route must wire the production cleanupAttachments dependency",
);
assert.match(
  dependencies,
  /export async function cleanupAttachments/,
  "selection-item-thread-dependencies must export cleanupAttachments",
);
assert.match(
  dependencies,
  /cleanupAttachments\([^)]*\):\s*Promise<void>\s*\{\s*await Promise\.all\(attachments\.map\(\(attachment\) => deleteProjectFileAndStorage\(attachment\.id\)\)\);/,
  "cleanupAttachments must reuse deleteProjectFileAndStorage for every attachment",
);

// ── Codex review round 1 follow-ups ─────────────────────────────────────

// BLOCKER: HTML injection — every client-controlled string interpolated
// into the notification emails must be escaped.
assert.match(dependencies, /function escapeHtml\(/, "dependencies must define an escapeHtml helper");
assert.match(dependencies, /escapeHtml\(item\.name\)/, "item.name must be escaped before use in email HTML");
assert.match(dependencies, /escapeHtml\(comment\.authorName\)/, "comment.authorName must be escaped before use in email HTML");
assert.match(dependencies, /escapeHtml\(comment\.body\)/, "comment.body must be escaped before use in email HTML");

// REAL ISSUE: ordering — assertAccess must resolve before ANY validation
// (file count/size/body-length), not just before uploadAttachments.
const findItemIdx = core.indexOf("const item = await dependencies.findItem(itemId);");
const validationIdx = core.indexOf("SELECTION_ITEM_COMMENT_MAX_FILES) {");
assert.ok(
  findItemIdx >= 0 && assertAccessIndex > findItemIdx && validationIdx > assertAccessIndex,
  "findItem then assertAccess must both resolve before file-count/size validation runs",
);

// REAL ISSUE: content-type spoofing — neither the route nor the upload
// dependency may forward the client-supplied File.type/mimeType to storage.
assert.ok(!route.includes("file.type"), "the route must never read the client-supplied File.type");
assert.ok(
  !dependencies.includes("file.mimeType ||") && !dependencies.includes("file.mimeType||"),
  "uploadAttachments must not fall back to the passed-through mimeType — derive strictly from the extension",
);
assert.match(
  dependencies,
  /mimeType:\s*mimeTypeForFileName\(file\.name\)/,
  "uploadAttachments must derive Content-Type strictly from the filename extension",
);

// REAL ISSUE: the unread-count reads must not be remotely invokable server
// actions — they must live outside actions.ts ("use server") and actions.ts
// must no longer export them.
assert.ok(
  !actions.includes("export async function getUnreadSelectionThreadCountForStaff"),
  "getUnreadSelectionThreadCountForStaff must not be exported from the \"use server\" actions.ts",
);
assert.ok(
  !actions.includes("export async function getUnreadSelectionThreadCountForPortal"),
  "getUnreadSelectionThreadCountForPortal must not be exported from the \"use server\" actions.ts",
);
assert.match(
  dependencies,
  /export async function getUnreadSelectionThreadCountForStaff/,
  "getUnreadSelectionThreadCountForStaff must live in the plain (non-\"use server\") dependencies module",
);
assert.match(
  dependencies,
  /export async function getUnreadSelectionThreadCountForPortal/,
  "getUnreadSelectionThreadCountForPortal must live in the plain (non-\"use server\") dependencies module",
);

// REAL ISSUE: visibility — candidates under a soft-deleted decision must be
// excluded from both badge counts and the postable/markable item lookup.
assert.match(
  dependencies,
  /decision:\s*\{\s*select:\s*\{\s*deletedAt:\s*true\s*\}\s*\}/,
  "findThreadItem must fetch the parent decision's deletedAt",
);
assert.match(
  dependencies,
  /proposal\.decisionId\s*&&\s*proposal\.decision\?\.deletedAt/,
  "findThreadItem must treat a soft-deleted parent decision as not-found",
);
assert.match(
  dependencies,
  /decision:\s*\{\s*deletedAt:\s*null\s*\}/,
  "the badge count queries must exclude proposals whose parent decision is soft-deleted",
);

// REAL ISSUE: index supporting the unread badge queries.
const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
assert.match(schema, /@@index\(\[authorType, readByTeamAt\]\)/, "schema must index SelectionItemComment(authorType, readByTeamAt)");
assert.match(schema, /@@index\(\[authorType, readByClientAt\]\)/, "schema must index SelectionItemComment(authorType, readByClientAt)");
const applyScript = readFileSync(join(process.cwd(), "scripts/apply-selection-item-threads.mjs"), "utf8");
assert.match(applyScript, /authorType.*readByTeamAt/, "apply script must create the (authorType, readByTeamAt) index");
assert.match(applyScript, /authorType.*readByClientAt/, "apply script must create the (authorType, readByClientAt) index");

// REAL ISSUE: canonical shape — only {id, name, url} may be persisted, never
// the `size` field saveProjectFile's result also carries.
assert.match(
  dependencies,
  /uploaded\.push\(\{\s*id:\s*result\.file\.id,\s*name:\s*result\.file\.name,\s*url:\s*result\.file\.url\s*\}\)/,
  "uploadAttachments must strip saveProjectFile's result to exactly {id, name, url} before storing",
);

// REAL ISSUE: payload minimization — the portal/staff comment payload must
// not spread internal ids or the opposite side's read timestamps.
assert.ok(
  !actions.includes("authorUserId: string | null; authorClientId: string | null;"),
  "withThreadSummary's input type must no longer require authorUserId/authorClientId — they're not sent to the browser",
);

async function verifyRejectingAccessPreventsWrite(): Promise<void> {
  let uploadCalls = 0;
  let createCalls = 0;

  await assert.rejects(
    postSelectionItemComment("item-1", "Master bath comment", [], {
      findItem: async () => ({
        id: "item-1",
        projectId: "project-1",
        deletedAt: null,
        name: "Vanity Light",
      }),
      assertAccess: async () => {
        throw new Error("Forbidden");
      },
      uploadAttachments: async () => {
        uploadCalls += 1;
        return [];
      },
      createComment: async () => {
        createCalls += 1;
        throw new Error("should never be called");
      },
      cleanupAttachments: async () => {
        throw new Error("cleanupAttachments must never run when access is denied");
      },
      notify: async () => {},
      revalidate: () => undefined,
    }),
    /Forbidden/,
  );
  assert.equal(uploadCalls, 0, "rejecting access must prevent any upload");
  assert.equal(createCalls, 0, "rejecting access must prevent the comment write");
}

async function verifyEmptyBodyNoAttachmentRejected(): Promise<void> {
  await assert.rejects(
    postSelectionItemComment("item-1", "   ", [], {
      findItem: async () => ({ id: "item-1", projectId: "project-1", deletedAt: null, name: "Vanity Light" }),
      assertAccess: async () => ({ isStaff: true, clientId: null, userId: "user-1", actorName: "Team" }),
      uploadAttachments: async () => [],
      createComment: async () => {
        throw new Error("should never be called");
      },
      cleanupAttachments: async () => {
        throw new Error("cleanupAttachments must never run for invalid input");
      },
      notify: async () => {},
      revalidate: () => undefined,
    }),
    /Write something or attach a file/,
  );
}

// Whole-batch cleanup must cover ANY failure after a successful upload, not
// just a failure inside uploadAttachments — this proves createComment
// throwing (e.g. the CAS row-lock losing a concurrent soft-delete race)
// still triggers cleanup for every uploaded attachment.
async function verifyCreateCommentFailureCleansUpUploads(): Promise<void> {
  const fakeAttachments = [
    { id: "verify-file-A", name: "a.pdf", url: "https://cdn.example.com/a.pdf" },
    { id: "verify-file-B", name: "b.pdf", url: "https://cdn.example.com/b.pdf" },
  ];
  const cleanedUp: string[] = [];

  await assert.rejects(
    postSelectionItemComment(
      "item-1",
      "See attached",
      [{ name: "a.pdf", buffer: Buffer.from("a"), mimeType: "application/pdf", size: 1 }],
      {
        findItem: async () => ({ id: "item-1", projectId: "project-1", deletedAt: null, name: "Vanity Light" }),
        assertAccess: async () => ({ isStaff: true, clientId: null, userId: "user-1", actorName: "Team" }),
        uploadAttachments: async () => fakeAttachments,
        createComment: async () => {
          throw new Error("Item not found");
        },
        cleanupAttachments: async (attachments) => {
          cleanedUp.push(...attachments.map((a) => a.id));
        },
        notify: async () => {},
        revalidate: () => undefined,
      },
    ),
    /Item not found/,
  );
  assert.deepEqual(
    cleanedUp.sort(),
    ["verify-file-A", "verify-file-B"],
    "createComment failing after a successful upload must clean up every uploaded attachment",
  );
}

// REAL ISSUE (ordering): a denied actor must get the ACCESS error, not a
// validation error, even when the payload is ALSO invalid (empty body, no
// files) — proves assertAccess runs before validation, so an anonymous/
// foreign caller never learns anything about what would have been wrong
// with their input.
async function verifyDenialPreemptsValidationErrors(): Promise<void> {
  await assert.rejects(
    postSelectionItemComment("item-1", "   ", [], {
      findItem: async () => ({ id: "item-1", projectId: "project-1", deletedAt: null, name: "Vanity Light" }),
      assertAccess: async () => {
        throw new Error("Forbidden");
      },
      uploadAttachments: async () => {
        throw new Error("uploadAttachments must never run when access is denied");
      },
      createComment: async () => {
        throw new Error("createComment must never run when access is denied");
      },
      cleanupAttachments: async () => {
        throw new Error("cleanupAttachments must never run when access is denied");
      },
      notify: async () => {},
      revalidate: () => undefined,
    }),
    /Forbidden/,
  );
}

Promise.all([
  verifyRejectingAccessPreventsWrite(),
  verifyEmptyBodyNoAttachmentRejected(),
  verifyCreateCommentFailureCleansUpUploads(),
  verifyDenialPreemptsValidationErrors(),
])
  .then(() => console.log("selection item thread contract verified"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
