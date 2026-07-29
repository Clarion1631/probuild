import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeSelectionItemNote,
  SELECTION_ITEM_NOTE_MAX_LENGTH,
} from "../src/lib/selection-item-notes";

assert.equal(SELECTION_ITEM_NOTE_MAX_LENGTH, 2000);
assert.equal(normalizeSelectionItemNote("  Master bath wall  "), "Master bath wall");
assert.equal(normalizeSelectionItemNote(" \n "), null);
assert.throws(
  () => normalizeSelectionItemNote("x".repeat(2001)),
  /2,000 characters or fewer/,
);

const actions = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
const persistence = readFileSync(
  join(process.cwd(), "src/lib/selection-item-note-persistence.ts"),
  "utf8",
);
const actorStart = actions.indexOf("async function assertDecisionActorAccess");
assert.ok(actorStart >= 0, "assertDecisionActorAccess must remain available");
const actorEnd = actions.indexOf("\nfunction ", actorStart + 1);
const actorBody = actions.slice(actorStart, actorEnd === -1 ? undefined : actorEnd);
assert.match(actorBody, /if \(!canAccessProject\(staffUser, projectId\)\)/);
assert.match(actorBody, /await assertPortalProjectOwnership\(projectId\)/);

const actionStart = actions.indexOf("export async function updateSelectionItemNote");
assert.ok(actionStart >= 0, "updateSelectionItemNote must be exported");
const actionEnd = actions.indexOf("\nexport async function ", actionStart + 1);
const actionBody = actions.slice(actionStart, actionEnd === -1 ? undefined : actionEnd);
assert.match(actionBody, /return persistSelectionItemNote\(itemId,\s*note,/);
assert.match(actionBody, /assertAccess:\s*assertDecisionActorAccess/);
assert.match(actionBody, /data:\s*\{\s*clientNote:\s*normalizedNote\s*\}/);
assert.ok(
  actionBody.includes("revalidatePath(`/projects/${projectId}/selections`)"),
);
assert.ok(
  actionBody.includes("revalidatePath(`/portal/projects/${projectId}/selections`)"),
);
const authorizeIndex = persistence.indexOf("await dependencies.assertAccess(item.projectId)");
const updateIndex = persistence.indexOf("await dependencies.updateNote");
assert.ok(
  authorizeIndex >= 0 && updateIndex > authorizeIndex,
  "authorization must complete before the note write",
);

const teamCandidateStart = actions.indexOf("export async function addTeamCandidate");
assert.ok(teamCandidateStart >= 0, "addTeamCandidate must remain exported");
const teamCandidateEnd = actions.indexOf("\nexport async function ", teamCandidateStart + 1);
const teamCandidateBody = actions.slice(
  teamCandidateStart,
  teamCandidateEnd === -1 ? undefined : teamCandidateEnd,
);
assert.match(teamCandidateBody, /clientNote\?: string/);
assert.match(
  teamCandidateBody,
  /clientNote:\s*normalizeSelectionItemNote\(data\.clientNote\s*\?\?\s*""\)/,
);

console.log("selection item note contract verified");
