# Spec: Product Library, Clipper, Client Selection Proposals, Two-Way Design Files

Origin: Janet Hoppe portal feedback (2026-07-25) + Justin's direction (2026-07-27).
Branch: `claude/probuild-portal-feedback-831d45`

## Problem

1. Clients cannot suggest selection items — the selections tab is one-way (PM stages boards, client picks). Janet: "I should at least be able to add items in the dashboard that are suspended until you approve them."
2. There is no reusable product catalog. Every SelectionOption is retyped per board. Houzz Pro has a "Product Clipper" that captures products from any retail site into a library; we want the same engine.
3. Clients on $100k+ jobs bring their own designer and need to exchange design files both ways. Portal Files is currently team-publish-only.

## Decisions (locked with Justin)

- Product library is **company-wide**; every clip is reusable across projects.
- Each project gets a **client-visible Favorites list** (library items pinned to the project). Approved client suggestions land there automatically.
- Client proposal flow: client suggests → Pending (clearly badged "waiting for approval") → PM approves (optionally sets price, picks board/category) or declines with note. Nothing counts as an official selection until PM approval.
- v1 capture front door is a **bookmarklet** for the team; Chrome extension is a later phase (NOT in this branch).
- AI paste-a-link parsing: structured data first (JSON-LD schema.org/Product, OpenGraph), Gemini fallback.

## Non-goals

- No Chrome extension in this branch.
- No client-visible pricing on proposals until PM approves.
- No changes to the existing SelectionBoard pick/submit flow (`submitClientSelections`) or any money path.
- No schedule changes (Richard handles high-level schedule as data).

---

## Schema (all additive — ship with `scripts/apply-product-library.mjs`, idempotent per repo convention)

```prisma
model ProductLibraryItem {
  id          String   @id @default(cuid())
  name        String
  description String?
  imageUrl    String?
  price       Decimal? @db.Decimal(12, 2) // list price captured at clip time
  vendor      String?
  vendorUrl   String?  // source/product URL
  category    String?  // free text v1 (e.g. "Plumbing Fixtures")
  source      String   @default("clip") // "clip" | "manual" | "client_proposal"
  clippedById String?
  clippedBy   User?    @relation(fields: [clippedById], references: [id])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  favorites   ProjectProductFavorite[]
  @@index([category])
  @@index([createdAt])
}

model ProjectProductFavorite {
  id            String   @id @default(cuid())
  projectId     String
  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  productId     String
  product       ProductLibraryItem @relation(fields: [productId], references: [id], onDelete: Cascade)
  addedById     String?  // team member User, null when added via approved client proposal
  addedBy       User?    @relation(fields: [addedById], references: [id])
  addedByClient Boolean  @default(false)
  note          String?
  createdAt     DateTime @default(now())
  @@unique([projectId, productId])
  @@index([projectId])
}

model SelectionProposal {
  id           String   @id @default(cuid())
  projectId    String
  project      Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  name         String
  description  String?
  imageUrl     String?
  price        Decimal? @db.Decimal(12, 2) // parsed list price; NOT shown to client until approved
  vendorUrl    String?
  clientNote   String?
  status       String   @default("Pending") // "Pending" | "Approved" | "Declined"
  pmNote       String?  // decline reason / approval comment, client-visible
  productId    String?  // ProductLibraryItem created on approval
  boardId      String?  // optional: SelectionBoard the PM approved it into
  categoryId   String?  // optional: SelectionCategory it became an option in
  decidedById  String?
  decidedBy    User?    @relation(fields: [decidedById], references: [id])
  decidedAt    DateTime?
  createdAt    DateTime @default(now())
  @@index([projectId, status])
}
```

`ProjectFile` gains: `uploadedByClient Boolean @default(false)`.
No change to `FileFolder` (existing `visibility: "shared"` tier is the client-visible mechanism).

Relation back-fields added on `User` and `Project` as required by Prisma.

## Phase 1 — parser + backend (executor 1)

**`src/lib/product-parse.ts`** — `parseProductUrl(url: string): Promise<ParsedProduct>`:
1. Validate URL: http/https only; resolve host and reject private/link-local IPs (follow the SSRF-guard pattern in `src/lib/signature-storage.ts` / `src/lib/pdf.ts`). 10s timeout, ~2MB response cap, realistic browser User-Agent.
2. Extract in order: JSON-LD `schema.org/Product` (name, image, offers.price, brand) → OpenGraph/meta tags (`og:title`, `og:image`, `product:price:amount`) → Gemini fallback (existing Gemini usage pattern is in `src/lib/actions.ts`; strip HTML to text, cap tokens, ask for strict JSON {name, price, imageUrl, vendor, description}).
3. Return `{name, description?, price?, imageUrl?, vendor?, vendorUrl}` — never throw for parse failures; return `{vendorUrl, name: null}` so UIs degrade to manual entry.

**API routes:**
- `POST /api/products/parse` — team-only (session + role check like neighboring team APIs). Body `{url}` → ParsedProduct.
- `POST /api/portal/projects/[id]/proposals/parse` — portal-client auth (copy the auth/ownership guard from an existing portal API route for the same project scoping). Same body/response, but **strip `price` from the response** (price is PM-side info until approval; still persisted on the proposal server-side).

**Server actions (in `src/lib/actions.ts` per repo convention):**
- `createProductLibraryItem(data)` / `updateProductLibraryItem(id, data)` / `deleteProductLibraryItem(id)` — team roles per `src/lib/permissions.ts` conventions.
- `getProductLibrary({search?, category?})` — newest first.
- `addProjectFavorite(projectId, productId, note?)` / `removeProjectFavorite(projectId, productId)` — team.
- `getProjectFavorites(projectId)` — team + portal variants (portal variant checks client owns project, like `getSelectionBoardsForPortal` at actions.ts:9405).
- `submitSelectionProposal(projectId, {url?, name, description?, imageUrl?, clientNote?})` — PORTAL action: parses url server-side if provided (price persisted, not returned), creates SelectionProposal Pending, emails the team like `submitClientSelections` (actions.ts:9384-9399) does, writes activity log entry.
- `getSelectionProposalsForPortal(projectId)` — client's own proposals, all statuses, price omitted unless Approved.
- `getSelectionProposals(projectId)` — team view.
- `decideSelectionProposal(proposalId, {action: "approve"|"decline", pmNote?, price?, boardId?, categoryId?, addToFavorites?: boolean})` — team only. Approve: creates ProductLibraryItem (source "client_proposal"), links productId, defaults `addToFavorites: true` → creates ProjectProductFavorite with `addedByClient: true`; if boardId+categoryId given, also creates a SelectionOption in that category (do NOT touch board status). Decline: status + pmNote. Both: set decidedBy/decidedAt, notify client by email (reuse the portal email helper used for selections), activity log. Guard with a status CAS (`updateMany WHERE status='Pending'`) so double-decisions no-op.

**Client file upload backend:**
- Portal upload action/route: accepts file for project → Supabase storage (follow existing team file-upload path), creates ProjectFile with `uploadedByClient: true`, `visibility: "shared"`, into a "Design Files" FileFolder (find-or-create, visibility "shared") — plus optional folderId if the client uploads into another shared folder. Enforce: client can only target folders whose effective visibility is "shared", size cap consistent with existing upload limits, mime allowlist (images, pdf, dwg/dxf, common office docs, zip).
- On upload: email the team (same recipient logic as selection submissions) + activity log.

## Phase 2 — internal UI + bookmarklet (executor 2)

- **`/company/product-library`** — List layout per DESIGN_SYSTEM.md: search + category filter, grid of product cards (image, name, vendor, price), "Recently clipped" default sort. Add/edit modal (manual entry with a "Parse from URL" field that calls `/api/products/parse` and prefills). Card action: "Add to project…" (project picker → `addProjectFavorite`).
- **`/clip` page** — team-auth page reading `?url=` param: auto-parses on load, shows editable prefilled form, Save to Library + optional "also favorite to project" picker. This is the bookmarklet target.
- **Bookmarklet**: on the product-library page, a "Get the Clipper" card with a draggable link `javascript:window.open('<origin>/clip?url='+encodeURIComponent(location.href),'probuild-clip','width=480,height=720')` and one-line instructions. Origin from `NEXT_PUBLIC_APP_URL`.
- **Project selections tab (team side)**: "Client suggestions" section listing SelectionProposals with status; approve dialog (price input, optional board/category picker from the project's boards, favorites toggle), decline dialog (note). Favorites section: list + add-from-library.
- Hover-reveal buttons must include the `[@media(hover:none)]` pattern from CLAUDE.md.

## Phase 3 — portal UI (executor 3)

- **Selections tab** (`src/app/portal/projects/[id]/selections/`): keep existing boards UI untouched. Add:
  - "Suggest an item" button → modal: paste-a-link field (calls portal parse route, prefills name/image — no price shown) + manual fields (name required, note, photo URL) → `submitSelectionProposal`.
  - "Your suggestions" list: Pending (amber "Waiting for PM review" badge), Approved (green, shows pmNote + price now visible), Declined (neutral, shows pmNote). Empty state invites first suggestion.
- **Favorites section** ("Project Favorites") on the selections tab (or overview if cleaner): grid of ProjectProductFavorite cards (image, name, vendor, link) — read-only for client in v1 apart from suggestions flowing in.
- **Files tab**: "Upload a file" affordance for clients (respecting `showFiles` visibility): drag/drop or picker → portal upload route → lands in shared "Design Files" folder; uploaded-by-client files badge as "From you". Show shared folders/files as today.
- Gate everything on existing `getPortalVisibility` flags (`showSelections`, `showFiles`); no new toggles in v1.

## Verification

- `npm run build` — 0 errors.
- Checker: schema applied cleanly via script dry-run inspection (script NOT run against prod in this branch; runs at deploy per CLAUDE.md), actions enforce auth scoping (portal actions cannot read other projects' proposals/favorites; parse route strips price), decideSelectionProposal is idempotent under double-submit, client upload cannot target team-only folders.
- Codex review after implementation (external URL fetching / SSRF, auth boundaries, new portal write paths).
- e2e money pipeline untouched — confirm no diffs in money-path files.

## Out of scope / later

- Chrome extension (same API; unlisted Web Store listing).
- Client clipping directly (extension with portal login).
- Structured categories/tags taxonomy for the library.
- Portal freshness audit routine (separate scheduled-agent task).
