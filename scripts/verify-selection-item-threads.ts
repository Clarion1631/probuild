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
      notify: async () => {},
      revalidate: () => undefined,
    }),
    /Write something or attach a file/,
  );
}

Promise.all([verifyRejectingAccessPreventsWrite(), verifyEmptyBodyNoAttachmentRejected()])
  .then(() => console.log("selection item thread contract verified"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
