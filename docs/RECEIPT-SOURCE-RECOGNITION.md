# Receipt source recognition

`RECEIPT_SOURCE_RECOGNITION_ENABLED` defaults to off. Only the exact value `true` enables the added recognition rules. The existing exact-amount, merchant and two-calendar-day rule remains unchanged.

New edges require a negative, non-check canonical `STATEMENT` bank line for `WTB-0723`. A single validated `POS DEB` or `DBT CRD` trace can supply an exact purchase date up to seven calendar days before settlement. The receipt date must equal that date. Seven days accommodates weekend and holiday settlement; it is not a seven-day fuzzy matching window. Invalid, future, repeated or malformed trace/date/card metadata supplies no additional edge.

Merchant additions are complete observed label pairs: the two Hazel Dell Parkrose labels and Parkrose Hardware; ARCO store 82887's complete descriptor and AMPM #82887; Columbia Resource Company's Vancouver descriptor and CRC-WEST VAN. Generic AMPM, other stores, other CRC locations, and partial merchant names gain no alias. These rules neither establish a bank link nor book an expense.

Recognition still requires existing receipt evidence and exact cents. Shared Expense/intake identities remain one evidence unit. Enabled searches cover seven days before and two days after settlement and load same-amount competing components to closure with nine-day adjacency, including closed competitors. Existing limits leave incomplete cohorts undecided. Canonical account/source fields are retained through bulk and retry evaluation and included in the locked component fingerprint.

The saved sweep cycle records its recognition policy. A changed policy restarts continuation from a fresh cycle; card selection and retries reject mismatched policy certification. Legacy cycle records without a policy represent the prior default-off behavior.

Every cycle recording a policy must complete before retries, including a same-policy cycle restarted by changed evidence. Pending cards remain pending during that delay. This conservative replay gate prevents an old claimed snapshot from bypassing a fresh review.

## Rollout and acceptance

Deploy with the flag off. Read the protected `receipt-evidence-diagnostic` endpoint using explicit canonical bank UUIDs and candidate QBO IDs (at most ten each). Verify current raw descriptors, source of record, account, statement associations and receipt-bearing Expense evidence. Native CSV fixtures and matching filenames alone do not establish live associations.

The diagnostic deliberately supports the known UUID bank-line identifiers only, not a general legacy-ID inventory. Canonical statement ingestion mints lowercase UUIDs; UUID inputs are normalized to that form. Unsupported legacy CUID identifiers are rejected rather than enumerated or guessed.

Keep purchaser cards disabled while enabling the flag, wait for the new deployment, and request a fresh full sweep. Verify the first twenty review outcomes individually before releasing cards. Duplicate financial records, uncertain source identity, generic merchant candidates, and parked multi-document inputs remain internal review cases. No historical receipt replay is part of this change.

## Validation

Run `npm run test:unit`, `npm run build`, and required CI. The standard unit runner includes the source-recognition fixtures and both bounded diagnostic test files. Tests cover the six independently observed Richard cases, the native CRC four-day trace, invalid dates, exact store negatives, shared receipt capacity, transitive closure, incomplete coverage, source-field changes and policy transitions. Passing fixtures do not certify the live first-twenty cohort.
