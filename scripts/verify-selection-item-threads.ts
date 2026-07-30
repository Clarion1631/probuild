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

Promise.all([
  verifyRejectingAccessPreventsWrite(),
  verifyEmptyBodyNoAttachmentRejected(),
  verifyCreateCommentFailureCleansUpUploads(),
])
  .then(() => console.log("selection item thread contract verified"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
