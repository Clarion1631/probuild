# Contract Editor & Smart Signing Redesign

## Problems with Current Implementation

### Editor Toolbar (ProjectContractsClient.tsx)
1. **Flat pill wall** -- All 15 merge fields displayed at once across one horizontal band. Hard to scan, overwhelming, takes too much vertical space
2. **No undo** -- Once you insert a field or type, there's no way to undo without manually editing HTML
3. **Raw HTML editing** -- Users type `<h2>`, `<strong>`, `<br/>` by hand. The format bar inserts tags but doesn't wrap selected text
4. **Signing fields mixed with data fields** -- `{{SIGNATURE_BLOCK}}` sits alongside `{{client_name}}` in the same toolbar. These are fundamentally different (one is a signing action, the other is auto-filled data)
5. **No drag-and-drop** -- Fields can only be inserted at cursor position, no visual placement

### Portal Signing (PortalContractClient.tsx)
6. **"[ Click to Sign ]" buttons** look like raw placeholder text, not a polished signing experience
7. **No progress indicator** -- Client doesn't know how many blocks remain
8. **No signature reuse** -- If contract has 3 signature blocks, client must redraw each time

---

## Redesign Plan

### 1. Collapsible Category Dropdowns (replaces flat pill toolbar)

Replace the single-row pill wall with a compact dropdown-based toolbar:

```
INSERT FIELD: [+ Client v] [+ Company v] [+ Project v] [+ Date v]   ||   SIGNING: [Signature] [Initials] [Date Signed]   ||   [Undo] [Redo]
```

**How it works:**
- Each category is a dropdown button (e.g., clicking `+ Client` shows Name, Email, Phone, Address)
- Signing fields get their own visually distinct section (rose/red border) since they're interactive blocks, not data
- Dropdowns close on selection or outside click
- Each dropdown item shows the field name + preview value (e.g., `Name -- "John Doe"`)

**File:** `ProjectContractsClient.tsx` lines 253-272

**Changes:**
- Replace the `MERGE_FIELDS.map()` flat render with a `MergeFieldDropdown` component per category
- Separate signing fields into their own toolbar section with distinct styling
- Add a divider between data fields and signing fields

### 2. Undo/Redo System

Add an undo/redo stack for the HTML editor:

**State additions:**
```ts
const [undoStack, setUndoStack] = useState<string[]>([]);
const [redoStack, setRedoStack] = useState<string[]>([]);
```

**Logic:**
- Push to `undoStack` before every `setEditBody()` call (field insert, tag insert, or after a debounced typing pause of 500ms)
- `Undo` button pops from `undoStack`, pushes current to `redoStack`, sets body
- `Redo` button pops from `redoStack`, pushes current to `undoStack`, sets body
- Keyboard shortcuts: `Ctrl+Z` (undo), `Ctrl+Shift+Z` (redo)
- Cap stack at 50 entries to prevent memory bloat

**UI:** Two icon buttons in the format toolbar row:
```
Format: H2 H3 B I ... | [<- Undo] [Redo ->]
```

**File:** `ProjectContractsClient.tsx` -- new state at line ~98, new functions after line 132, buttons added at line ~276

### 3. Smarter Format Toolbar (wrap selected text)

Current format buttons insert tags with placeholder text. Improve to wrap selected text:

**Change `insertHtmlTag` behavior:**
- If text is selected in textarea, wrap it: `selected text` -> `<strong>selected text</strong>`
- If no text selected, insert with placeholder as today

**File:** `ProjectContractsClient.tsx` lines 120-132

### 4. Cleaner Signing Blocks in Portal

Redesign the `{{SIGNATURE_BLOCK}}` rendering in the client portal:

**Current:** `<button class="doc-block-btn">[ Click to Sign ]</button>` -- looks like raw placeholder text

**New design:**
```html
<div class="signing-block">
  <div class="signing-block-line"></div>          <!-- horizontal signature line -->
  <div class="signing-block-label">
    <span class="signing-block-icon">pen-icon</span>
    <span>Tap to sign</span>
  </div>
</div>
```

**Visual treatment:**
- Signature line (like a real document) with a subtle pen icon
- Gentle blue glow/pulse to draw attention
- After signing: signature image replaces the block seamlessly (like ink on paper)
- Label below: "Client Signature" or "Initials" in small gray text

**File:** `PortalContractClient.tsx` lines 49-52 (block generation), lines 325-352 (CSS)

### 5. Signing Progress Bar in Portal

Add a progress indicator so clients know how many blocks remain:

```
[===------] 1 of 3 signatures completed
```

**Placement:** Sticky bar at bottom of viewport (above the submit button area)

**File:** `PortalContractClient.tsx` -- new JSX before the final submission block (~line 361)

### 6. Signature Reuse

After the first signature is drawn, offer "Apply same signature to remaining blocks" button. Speeds up contracts with multiple signature blocks.

**Logic:**
- After first `handleSignBlock`, if remaining unsigned blocks exist, show a toast or inline prompt: "Apply this signature to all remaining blocks?"
- If accepted, fill all unsigned `sig-*` blocks with the same image/name
- Initials handled separately (same pattern)

**File:** `PortalContractClient.tsx` -- extend `handleSignBlock` (~line 136)

---

## Files to Modify

| File | What Changes |
|------|-------------|
| `src/app/projects/[id]/contracts/ProjectContractsClient.tsx` | Dropdown toolbar, undo/redo, smarter format wrapping |
| `src/app/portal/contracts/[id]/PortalContractClient.tsx` | Cleaner signing blocks, progress bar, signature reuse |
| `src/components/DocumentSignModal.tsx` | No changes needed (already clean) |
| `src/components/SignaturePad.tsx` | No changes needed |
| `src/app/leads/[id]/contracts/LeadContractsClient.tsx` | Mirror toolbar changes from ProjectContractsClient |

---

## Implementation Order

1. **Undo/Redo** -- Highest impact, lowest risk. Add state + keyboard shortcuts
2. **Dropdown toolbar** -- Replace flat pills with category dropdowns + separate signing section
3. **Smart format wrapping** -- Enhance `insertHtmlTag` to wrap selections
4. **Portal signing blocks** -- Redesign the `[ Click to Sign ]` buttons into signature-line style
5. **Signing progress bar** -- Add progress indicator in portal
6. **Signature reuse** -- "Apply to all" after first signature

## Verification

- Open a project with an existing contract, click Edit
- Verify dropdown menus open/close, insert fields at cursor
- Type text, select it, click Bold -- verify it wraps with `<strong>`
- Type several changes, press Ctrl+Z multiple times -- verify undo works
- Press Ctrl+Shift+Z -- verify redo works
- Send contract to client portal, verify new signing block design
- Sign first block, verify "apply to all" prompt appears if multiple blocks exist
- Complete all blocks, submit -- verify PDF generates correctly
