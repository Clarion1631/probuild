// DEPRECATED — superseded by scripts/sync-crew-to-in-progress.mjs.
//
// This script backfilled the old "ACTIVATED FIELD_CREW, plus CJ by name" rule.
// That rule was replaced by the dispatch-board switch
// (`User.showOnDispatch`, `src/lib/dispatch-roster.ts` `isDispatchable`):
// every account with the switch on — including managers/admins — is now
// auto-assigned crew on every "In Progress" project. Re-stating the old,
// narrower rule here would silently drift from src/lib/crew-auto-assign.ts,
// so this file is kept only as a pointer (deletion was not available in this
// change) rather than updated to duplicate the new logic a second time.
//
// Use instead:
//   node scripts/sync-crew-to-in-progress.mjs [--dry-run]
console.log(
    "[backfill-crew-assignments] DEPRECATED — use scripts/sync-crew-to-in-progress.mjs instead. " +
    "This script no longer runs."
);
