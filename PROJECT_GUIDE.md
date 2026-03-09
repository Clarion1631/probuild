# ProBuild — Project Guide

> **Purpose:** This is the single source of truth for all agents working on the ProBuild codebase. Read this before making any changes.

---

## 1. Project Goal

Clone the core experience of **Houzz Pro** as a clean, normalized SaaS application for construction project management. The system is built **foundationally first**, with features integrated on top of the core.

---

## 2. Design System: HUI

All UI must use the standardized HUI (Houzz UI) design tokens defined in `globals.css` and `tailwind.config.js`. **Do not use ad-hoc inline Tailwind classes** for buttons, inputs, cards, or text colors when a standard class exists.

### 2.1 Colors (`tailwind.config.js` → `hui.*`)
| Token | Value | Use |
|---|---|---|
| `hui-primary` | `#4c9a2a` | Brand green, hover accents |
| `hui-primaryHover` | `#3e8022` | Green hover state |
| `hui-background` | `#f8f9fa` | Page/panel backgrounds |
| `hui-sidebar` | `#1e1e1e` | Primary left nav |
| `hui-textMain` | `#222222` | Primary text |
| `hui-textMuted` | `#666666` | Secondary/label text |
| `hui-border` | `#e1e4e8` | All borders and dividers |

### 2.2 Component Classes (`globals.css`)
| Class | Purpose |
|---|---|
| `hui-btn` | Base button (always combine with a variant) |
| `hui-btn-primary` | Dark/black button with white text |
| `hui-btn-secondary` | White button with border |
| `hui-btn-green` | Brand green button |
| `hui-input` | Standard text input / select |
| `hui-card` | White card container with border and subtle shadow |

### 2.3 Rules
- **Buttons:** Always use `hui-btn hui-btn-{variant}`. Never use raw `bg-blue-600`, `bg-slate-900`, etc. for buttons.
- **Inputs:** Always use `hui-input`. Never write ad-hoc `border border-slate-300 rounded px-3 py-2 text-sm focus:outline-none...`.
- **Cards/Containers:** Use `hui-card` for any white panel with content.
- **Text:** Use `text-hui-textMain` for primary text, `text-hui-textMuted` for labels/secondary.
- **Borders:** Use `border-hui-border` for all dividers and container borders.

---

## 3. Layout Architecture

```
┌──────────────────────────────────────────────────────┐
│ Primary Sidebar (w-16, dark, icon-only, fixed left)  │
│ ┌──────────────────────────────────────────────────┐ │
│ │ Header (h-16, white, border-bottom)              │ │
│ │ ┌────────────────────────────────────────────────┐│ │
│ │ │ [Optional Secondary Sidebar] │ Main Content    ││ │
│ │ │ (w-56, contextual nav)       │ (flex-1, p-6)   ││ │
│ │ └────────────────────────────────────────────────┘│ │
│ └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### Key layout files:
- `AppLayout.tsx` — Auth guard + shell (Sidebar + Header + main)
- `Sidebar.tsx` — Primary left nav (icon-only, 64px)
- `Header.tsx` — Top bar with user info
- `ProjectInnerSidebar.tsx` — Secondary contextual nav inside projects

---

## 4. Page Patterns

### 4.1 List Pages (Projects, Leads, Clients, Estimates, Invoices)
```
┌─────────────────────────────────────────┐
│ Page Title              [Filters] [+New]│  ← Header row
├─────────────────────────────────────────┤
│ hui-card                                │
│ ┌─────────────────────────────────────┐ │
│ │ Table Header (sticky, bg-slate-50)  │ │
│ │ Row 1 (hover:bg-slate-50)           │ │
│ │ Row 2 (zebra if needed)             │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 4.2 Detail Pages (Lead Detail, Estimate Editor)
Two-pane: primary content left, details sidebar right.

### 4.3 Dashboard
Two-column widget grid: actionable lists left, quick actions right.

### 4.4 Financial Pages (Estimates List, Invoices List)
Metric summary cards at top → data table below.

---

## 5. File Conventions

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | Dashboard |
| `src/app/{feature}/page.tsx` | Feature list page |
| `src/app/{feature}/[id]/page.tsx` | Feature detail page |
| `src/app/projects/[id]/{sub}/page.tsx` | Project sub-pages |
| `src/components/*.tsx` | Shared components |
| `src/components/ui/*.tsx` | Reusable UI primitives |
| `src/lib/actions.ts` | Server actions / data fetching |
| `src/app/api/**` | API routes |

---

## 6. Coding Standards

1. **Server Components by default.** Only add `"use client"` when interactivity requires it.
2. **No unused imports.** Keep files clean.
3. **No placeholder data in production pages.** Use empty states with helpful CTAs.
4. **Consistent naming:** PascalCase for components, camelCase for functions/variables.
5. **All API routes** should return proper error responses with status codes.

---

## 7. Feature Roadmap (Add to before executing)

> **Agents: Add your planned feature here BEFORE implementing it.** Get approval from the user before proceeding.

### Core (Foundation) — ✅ COMPLETE
- [x] Layout shell (Sidebar, Header, AppLayout)
- [x] HUI Design System (globals.css, tailwind.config.js)
- [x] Dashboard widget layout
- [x] Authentication (NextAuth, Google OAuth)

### Active Features — IN PROGRESS (Phase 2 Core)
- [ ] Leads CRM (Pipeline list, Lead details, status tracking)
- [ ] Projects Hub (Project list, deep dive dashboard)
- [ ] Estimates (Project-scoped, line-item calculator, builder)
- [ ] Invoices (Project-scoped, generation from estimates, payment tracking)

### Planned Features — NOT STARTED (Phase 3 Addons)
- [ ] Clients management (CRUD + modal)
- [ ] Time & Expenses (tabbed layout, logging table)
- [ ] Contracts
- [ ] Takeoffs
- [ ] 3D Floor Plans
- [ ] Mood Boards / Selection Boards
- [ ] Task Center / Punchlist
- [ ] Daily Logs
- [ ] Schedule Overview
- [ ] Change Orders
- [ ] Purchase Orders
- [ ] Client Portal enhancements
- [ ] Notification Center
- [ ] Global Search (cross-entity)
- [ ] Budget Tracking (vs. Estimates)
- [ ] Team Member management
- [ ] Reports / Analytics Dashboard

---

## 8. Before You Code Checklist

> Every agent should verify these BEFORE making changes:

- [ ] Does this change align with the HUI design system?
- [ ] Am I using `hui-btn`, `hui-input`, `hui-card` instead of ad-hoc classes?
- [ ] Is this feature listed in Section 7? If not, add it first.
- [ ] Am I following the page pattern from Section 4?
- [ ] Did I check `globals.css` for existing utility classes before creating new ones?
- [ ] Did I run `npm run dev` and use the `browser_subagent` to visually inspect my work?
- [ ] Did I commit and push my changes to the `main` branch to trigger a live Vercel deployment?

---

## 9. Reviewing Agent Work (For Humans)

When an agent finishes their task and pushes to GitHub, here is how you can review their work:

1. **Pull Latest Changes:** Open your terminal and run `git pull origin main` to pull their committed work to your local machine.
2. **Start Local Server:** Run `npm run dev` to start your Next.js server.
3. **Inspect Visually:** Open `http://localhost:3000` in your browser and click through the pages the agent modified.
4. **Compare with Mockups:** Compare the live UI against the Houzz Pro screenshots stored in the `brain` artifacts folder. You can also view these at the top of the `multi_agent_prompts.md` document.
5. **Check Vercel Deployment:** Alternatively, check your Vercel dashboard to view the live preview or production deployment edge URL that triggered when the agent pushed to the `main` branch.
