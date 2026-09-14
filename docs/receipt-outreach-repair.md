# Receipt outreach and source review repair

Unmatched documents must remain internal reconciliation work. They must not become assertions that a purchaser failed to provide a receipt.

- The planner keeps unresolved same-amount documents within 30 days open with an explicit outreach hold. This window covers late accounting entry; it does not widen automatic matching or bind a document to a purchase.
- Initial card selection, queued-card revalidation and on-demand requests enforce the hold. The receipts page explains the internal review requirement. Software billing receipts remain office collection work.
- A Sherwin-Williams store number attached to the merchant name is normalized without introducing broader merchant aliases.
- A possible duplicate purchase cannot receive a new attachment without established identity. Classified reconstructed, error, non-receipt and unknown sources are held before booking and before legacy email fallback, including disabled/paused API paths.
- Canonical Apps Script source includes the same source-review behavior. It must be deployed separately from the Next.js application; a repository change alone does not update a live Apps Script deployment.

Verification uses synthetic regressions for selection, strict revalidation, late-entered documents, cached verdicts, manual requests, duplicate identity and source/fallback boundaries. Incident evidence remains outside the repository.

Receipt reminder delivery remains disabled in production until existing-document reconciliation and the remaining backlog are reviewed. This code release does not correct historical QuickBooks transactions or certify the contents of arbitrary legacy attachments.
