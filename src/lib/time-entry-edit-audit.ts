// Who gets stamped on a time-entry edit (PATCH /api/time-entries/[id]).
// Pure, so the attribution matrix is unit-tested (tests/time-entry-edit-audit.test.ts):
//   - privileged editor (MANAGER/ADMIN) → editedByManagerId + editedAt, INCLUDING an
//     edit of their own punch (owner decision + Codex gate, PR #437: a manager's
//     self-edit must not read as "Original" on the manager page);
//   - worker editing their own punch → no manager stamp; `isEdited` + the preserved
//     original times + required editNotes remain the audit trail.
export function privilegedEditStamp(
    editorUserId: string,
    isPrivileged: boolean,
    now: Date = new Date()
): { editedByManagerId: string; editedAt: Date } | Record<string, never> {
    if (!isPrivileged) return {};
    return { editedByManagerId: editorUserId, editedAt: now };
}
