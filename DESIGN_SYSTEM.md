# ProBuild Design System

Every new page must follow these patterns. No exceptions. This file is the source of truth for UI consistency.

---

## Colors

| Token | Value | Usage |
|-------|-------|-------|
| `hui-primary` | `#4c9a2a` | Primary actions, active states, brand accent |
| `hui-primaryHover` | `#3e8022` | Primary hover state |
| `hui-background` | `#f8f9fa` | Page background |
| `hui-sidebar` | `#1e1e1e` | Sidebar background |
| `hui-textMain` | `#222222` | Primary text |
| `hui-textMuted` | `#666666` | Secondary text, labels |
| `hui-border` | `#e1e4e8` | Borders, dividers |

**Status colors** (use consistently everywhere):
| Status | Background | Text |
|--------|-----------|------|
| Draft | `bg-slate-100` | `text-slate-700` |
| Not Started | `bg-slate-100` | `text-slate-700` |
| In Progress | `bg-blue-100` | `text-blue-700` |
| Sent / Issued | `bg-amber-100` | `text-amber-700` |
| Approved / Complete / Paid | `bg-green-100` | `text-green-700` |
| Blocked / Overdue / Declined | `bg-red-100` | `text-red-700` |

---

## Typography Scale

| Element | Class | Usage |
|---------|-------|-------|
| Page title | `text-xl font-bold text-hui-textMain` | Top of every page |
| Section title | `text-base font-semibold text-hui-textMain` | Card headers, section labels |
| Body text | `text-sm text-hui-textMain` | Default content |
| Muted text | `text-sm text-hui-textMuted` | Descriptions, secondary info |
| Label | `text-xs font-semibold text-hui-textMuted uppercase tracking-wider` | Form labels, column headers |
| Small detail | `text-xs text-hui-textMuted` | Timestamps, counts |

---

## Core CSS Classes

```css
/* Already in globals.css — use these, don't reinvent */
.hui-btn          /* base button */
.hui-btn-primary  /* dark slate primary — use for main page actions */
.hui-btn-secondary /* white bordered — use for secondary actions */
.hui-btn-green    /* brand green — use for positive actions (save, approve, create) */
.hui-input        /* text input, select, textarea base */
.hui-card         /* white card with border and shadow */
```

---

## Page Layout Templates

### Type A: List Page (Projects, Invoices, Leads, Reports)
```
┌─────────────────────────────────────────────────┐
│ Page Title                        [+ Add Button] │
│ Subtitle / count                                 │
├─────────────────────────────────────────────────┤
│ [Stat Card] [Stat Card] [Stat Card] [Stat Card]  │  ← grid-cols-4
├─────────────────────────────────────────────────┤
│ [Tab] [Tab] [Tab] [Tab]              [Search]    │  ← filter tabs
├─────────────────────────────────────────────────┤
│ hui-card                                         │
│ ┌─────┬──────┬────────┬────────┬──────┐         │
│ │ Col │ Col  │ Col    │ Col    │ Col  │         │  ← sortable table
│ ├─────┼──────┼────────┼────────┼──────┤         │
│ │     │      │        │        │      │         │
│ └─────┴──────┴────────┴────────┴──────┘         │
└─────────────────────────────────────────────────┘
```

**Implementation pattern:**
```tsx
<div className="max-w-6xl mx-auto py-8 px-6">
  {/* Header */}
  <div className="flex items-center justify-between mb-6">
    <div>
      <h1 className="text-xl font-bold text-hui-textMain">Page Title</h1>
      <p className="text-sm text-hui-textMuted mt-1">{count} items</p>
    </div>
    <button className="hui-btn hui-btn-green">+ Add New</button>
  </div>

  {/* Stat Cards */}
  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
    <StatCard label="Total" value="$124,500" />
    <StatCard label="Active" value="12" />
    <StatCard label="Completed" value="8" />
    <StatCard label="Revenue" value="$89,200" />
  </div>

  {/* Filter Tabs */}
  <div className="flex items-center gap-1 mb-4 border-b border-hui-border">
    <TabButton active={tab === "all"} onClick={() => setTab("all")} count={total}>All</TabButton>
    <TabButton active={tab === "active"} onClick={() => setTab("active")} count={active}>Active</TabButton>
  </div>

  {/* Data Table */}
  <div className="hui-card">
    <table className="w-full">
      <thead>
        <tr className="border-b border-hui-border bg-slate-50">
          <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Name</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {items.map(item => <tr className="hover:bg-slate-50 transition" />)}
      </tbody>
    </table>
  </div>
</div>
```

---

### Type B: Form / Settings Page
```
┌──────────────────────────────────┐
│ Page Title                       │
│ Description text                 │
├──────────────────────────────────┤
│ hui-card                         │
│ ┌──────────────────────────────┐ │
│ │ Section Label                │ │
│ │ [Input Field          ]      │ │
│ │ [Input Field          ]      │ │
│ └──────────────────────────────┘ │
├──────────────────────────────────┤
│ hui-card                         │
│ ┌──────────────────────────────┐ │
│ │ Section Label                │ │
│ │ [Toggle] Description         │ │
│ │ [Toggle] Description         │ │
│ └──────────────────────────────┘ │
├──────────────────────────────────┤
│                    [Save Button] │
└──────────────────────────────────┘
```

**Implementation pattern:**
```tsx
<div className="max-w-2xl py-8 px-6">
  {/* Header */}
  <div className="mb-6">
    <h1 className="text-xl font-bold text-hui-textMain">Page Title</h1>
    <p className="text-sm text-hui-textMuted mt-1">Description of this settings section.</p>
  </div>

  {/* Form Card */}
  <div className="hui-card p-6 mb-4">
    <h2 className="text-base font-semibold text-hui-textMain mb-4">Section Label</h2>
    <div className="space-y-4">
      <div>
        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Field Label</label>
        <input className="hui-input mt-1" />
      </div>
    </div>
  </div>

  {/* Save */}
  <div className="flex justify-end">
    <button className="hui-btn hui-btn-green" disabled={saving}>
      {saving ? "Saving..." : "Save Changes"}
    </button>
  </div>
</div>
```

---

### Type C: Detail / Editor Page (Estimate editor, Change Order editor)
```
┌─────────────────────────────────────────────────────────────┐
│ ← Back    Title                    [Actions] [Save Button]   │
├─────────────────────────────────────────────────┬───────────┤
│                                                 │           │
│  Main editor content                            │  Right    │
│  (form fields, line items, etc.)                │  Summary  │
│                                                 │  Panel    │
│                                                 │           │
└─────────────────────────────────────────────────┴───────────┘
```

---

### Type D: Full-Width Tool (Gantt, Floor Plans, Mood Boards)
```
┌─────────────────────────────────────────────────────────────┐
│ Toolbar: Title   [Controls]   [Zoom]   [Actions]   [+ Add]  │
├──────────────┬──────────────────────────────┬───────────────┤
│              │                              │               │
│  Left panel  │  Main canvas / timeline      │  Right detail │
│  (list)      │                              │  (on select)  │
│              │                              │               │
└──────────────┴──────────────────────────────┴───────────────┘
```

Use `h-[calc(100vh-64px)] -m-6 overflow-hidden` to make it full-bleed.

---

## Shared Components to Use

### StatCard
```tsx
function StatCard({ label, value, sub, trend }: { label: string; value: string; sub?: string; trend?: "up" | "down" }) {
  return (
    <div className="hui-card p-5">
      <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-hui-textMain mt-1">{value}</p>
      {sub && <p className="text-xs text-hui-textMuted mt-1">{sub}</p>}
    </div>
  );
}
```

### TabButton
```tsx
function TabButton({ active, onClick, count, children }: { active: boolean; onClick: () => void; count?: number; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
        active ? "border-hui-primary text-hui-primary" : "border-transparent text-hui-textMuted hover:text-hui-textMain"
      }`}
    >
      {children}
      {count !== undefined && (
        <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>
          {count}
        </span>
      )}
    </button>
  );
}
```

### EmptyState
```tsx
function EmptyState({ icon, title, description, action, onAction }: {
  icon: React.ReactNode; title: string; description: string; action?: string; onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">{icon}</div>
      <h3 className="text-base font-semibold text-hui-textMain">{title}</h3>
      <p className="text-sm text-hui-textMuted mt-1 max-w-md">{description}</p>
      {action && onAction && (
        <button onClick={onAction} className="hui-btn hui-btn-green mt-4">{action}</button>
      )}
    </div>
  );
}
```

### StatusBadge
```tsx
const STATUS_STYLES: Record<string, string> = {
  "Draft": "bg-slate-100 text-slate-700",
  "Not Started": "bg-slate-100 text-slate-700",
  "In Progress": "bg-blue-100 text-blue-700",
  "Sent": "bg-amber-100 text-amber-700",
  "Issued": "bg-amber-100 text-amber-700",
  "Approved": "bg-green-100 text-green-700",
  "Complete": "bg-green-100 text-green-700",
  "Paid": "bg-green-100 text-green-700",
  "Blocked": "bg-red-100 text-red-700",
  "Overdue": "bg-red-100 text-red-700",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLES[status] || "bg-slate-100 text-slate-700"}`}>
      {status}
    </span>
  );
}
```

---

## Form Patterns

### Standard input field
```tsx
<div>
  <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Label</label>
  <input className="hui-input mt-1" placeholder="..." />
</div>
```

### Grid form (multi-column)
```tsx
<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
  <div><label>...</label><input className="hui-input mt-1" /></div>
  <div><label>...</label><input className="hui-input mt-1" /></div>
</div>
```

### Toggle row
```tsx
<div className="flex items-center justify-between py-3">
  <div>
    <p className="text-sm font-medium text-hui-textMain">Feature Name</p>
    <p className="text-xs text-hui-textMuted">Description of what this controls</p>
  </div>
  <button
    role="switch"
    aria-checked={enabled}
    onClick={() => setEnabled(!enabled)}
    className={`relative w-10 h-5 rounded-full transition ${enabled ? "bg-hui-primary" : "bg-slate-300"}`}
  >
    <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition ${enabled ? "translate-x-5" : ""}`} />
  </button>
</div>
```

---

## Rules

1. **Every page gets a max-width container** — `max-w-6xl` for list pages, `max-w-2xl` for forms, `max-w-5xl` for mixed
2. **Every page starts with the same header pattern** — title left, primary action right
3. **Tabs use the TabButton pattern** — border-bottom style, hui-primary active color, count badges
4. **Tables live inside hui-card** — `divide-y divide-slate-100` for rows, `bg-slate-50` for header
5. **Save buttons are always `hui-btn-green`** — not `hui-btn-primary` (that's for navigation actions)
6. **Loading states** — buttons show "Saving..." / "Loading..." text when disabled
7. **Empty states** — every list must have one. Use EmptyState component with icon, title, description, and CTA
8. **No raw colors** — always use hui-* tokens or the status color table above
9. **Spacing is consistent** — `mb-6` between major sections, `space-y-4` within form groups, `gap-4` in grids
