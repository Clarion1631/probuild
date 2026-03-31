# AGENT_CONTEXT.md — Read This First

> **Purpose:** Compact manifest of what already exists. Read BEFORE coding. Do NOT rebuild anything listed here.
> **Rule:** EXTEND existing files. Do NOT create new files for logic that already has a home.

---

## Stack (do not install these — already in package.json)

Next.js 16 (App Router) · React 19 · TypeScript · Prisma (PostgreSQL) · Tailwind v4 · NextAuth v4 (Google OAuth) · Supabase Storage · Gemini AI (`gemini-3-flash-preview`) · Stripe · Zustand · @hello-pangea/dnd · Framer Motion · jspdf · Puppeteer · Lucide React icons

---

## Design System — HUI (globals.css)

**Always use these classes. Never use raw Tailwind for buttons/inputs/cards.**

| Class | Use |
|---|---|
| `hui-btn hui-btn-primary` | Dark button |
| `hui-btn hui-btn-secondary` | White bordered button |
| `hui-btn hui-btn-green` | Brand green button |
| `hui-input` | All text inputs & selects |
| `hui-card` | White container panels |

Colors: `text-hui-textMain` (#222), `text-hui-textMuted` (#666), `border-hui-border` (#e1e4e8), `bg-hui-primary` (#4c9a2a)

---

## Existing Server Actions (src/lib/actions.ts — ADD here, don't create new files)

### Leads & Clients
`getLeads` · `getLead` · `createLead` · `updateLeadStage` · `updateLeadMetadata` · `deleteLead` · `updateLeadAssignment` · `updateLeadInfo` · `getClients` · `getClient` · `createClient` · `updateClient` · `getLeadTasks` · `createLeadTask` · `updateLeadTask` · `deleteLeadTask` · `getLeadMeetings` · `createLeadMeeting` · `updateLeadMeeting` · `deleteLeadMeeting`

### Projects & Change Orders
`getProjects` · `getProject` · `getProjectLead` · `createProject` · `convertLeadToProject` · `linkProjectToLead` · `getLeadsForLinking` · `updateProjectStatus` · `updateProjectColor` · `updateProjectTags` · `updateProjectName` · `deleteProjects`
`createChangeOrder` · `getChangeOrders` · `getChangeOrder` · `updateChangeOrder` · `deleteChangeOrder` · `updateChangeOrderStatus` · `approveChangeOrder`

### Estimates
`createDraftEstimate` · `createDraftLeadEstimate` · `getEstimate` · `getAllEstimates` · `saveEstimate` · `updateEstimateStatus` · `deleteEstimate` · `duplicateEstimate` · `saveEstimateAsTemplate` · `getEstimateTemplates` · `createEstimateFromTemplate` · `getEstimateForPortal` · `markEstimateViewed` · `approveEstimate` · `sendEstimateToClient`

### Invoices (ALREADY EXIST)
`createInvoiceFromEstimate` · `getInvoice` · `getProjectInvoices` · `getAllInvoices` · `issueInvoice` · `deleteInvoice` · `updateInvoiceNotes` · `sendInvoiceToClient` · `getInvoiceForPortal` · `markInvoiceViewed` · `recordPayment`

### Contracts
`getContracts` · `getContract` · `createContractFromTemplate` · `createContractBlank` · `updateContract` · `deleteContract` · `sendContractToClient` · `approveContract` · `getContractSigningHistory` · `markContractViewed`

### Schedule
`getScheduleTasks` · `getAllScheduleTasks` · `createScheduleTask` · `updateScheduleTask` · `deleteScheduleTask` · `linkTasks` · `unlinkTasks` · `importEstimateToSchedule` · `clearAllTasks` · `aiGenerateSchedule`

### Tasks & Punch Items
`addTaskComment` · `getTaskComments` · `addTaskPunchItem` · `togglePunchItem` · `deletePunchItem` · `getTaskPunchItems` · `assignUserToTask` · `unassignUserFromTask` · `assignSubToTask` · `unassignSubFromTask` · `aiGeneratePunchlist`

### Company & Settings
`getCompanySettings` · `saveCompanySettings` · `getTeamMembers` · `getActiveSubcontractors` · `getCompanySubcontractorTrades` · `saveCompanySubcontractorTrades` · `getDocumentTemplates` · `getDocumentTemplate` · `createDocumentTemplate` · `updateDocumentTemplate` · `deleteDocumentTemplate` · `updateCompanyProjectStatuses`

### Communication & Messaging
`getProjectMessages` · `getUnreadMessageCount`

### Vendors & Purchase Orders
`getVendors` · `createVendor` · `updateVendor` · `deleteVendor` · `getPurchaseOrders` · `getPurchaseOrder` · `createPurchaseOrder` · `updatePurchaseOrder` · `deletePurchaseOrder` · `updatePurchaseOrderStatus` · `sendPurchaseOrder`

### Portals & Visibility
`getPortalVisibility` · `savePortalVisibility` · `getSubcontractorExplicitProjects` · `saveSubcontractorExplicitProjects` · `uploadSubcontractorCOI` · `subPortalUploadCOI` · `deleteSubcontractorCOI` · `subPortalDeleteCOI`

### Floor Plans
`createDraftFloorPlan` · `getFloorPlan` · `saveFloorPlanData`

---

## Existing API Routes (src/app/api/)

`auth/[...nextauth]` · `ai-estimate` · `ai-schedule` · `clients` + `clients/[id]` + `clients/[id]/invite` · `cost-codes` · `cost-types` · `expenses` + `expenses/[id]` + `expenses/parse` · `files` + `files/folders` · `leads/[id]/notes/ai` · `leads/messages` + `leads/messages/suggest` · `me/permissions` · `messages/[id]/read` · `mobile/login` · `payments/create-session` · `pdf/[id]` · `projects` + `projects/[id]` + `projects/[id]/buckets` + `projects/[id]/cost-codes` + `projects/[id]/crew` · `seed` · `sub-portal/login` + `sub-portal/verify` · `subcontractors` + `subcontractors/[id]` · `takeoffs` + `takeoffs/[id]` + `takeoffs/ai-estimate` + `takeoffs/convert-to-estimate` + `takeoffs/register-file` + `takeoffs/upload` · `time-entries` · `users` + `users/[id]` · `webhook/stripe`

---

## Existing Pages (src/app/)

### Top-level
`page.tsx` (Dashboard) · `login/` · `estimates/page.tsx` · `leads/page.tsx` · `time-clock/page.tsx`

### Projects (src/app/projects/)
`page.tsx` (list) · `[id]/page.tsx` (detail) · `[id]/estimates/` (list + `[estimateId]/`) · `[id]/invoices/` (list + `[invoiceId]/` + `new/`) · `[id]/contracts/` · `[id]/schedule/` · `[id]/files/` · `[id]/floor-plans/` · `[id]/takeoffs/` · `[id]/timeclock/` · `[id]/costing/` · `[id]/settings/` · `[id]/change-orders/` · `[id]/messages/` · `[id]/messages/subs` · `[id]/purchase-orders/`

### Leads (src/app/leads/)
`page.tsx` (list) · `[id]/page.tsx` (detail) · `[id]/estimates/[estimateId]/` · `[id]/contracts/` + `[contractId]/` · `[id]/files/` · `[id]/meetings/` · `[id]/tasks/` · `[id]/takeoffs/`

### Client Portal (src/app/portal/)
`page.tsx` (dashboard) · `projects/[id]/` · `estimates/[id]/` · `contracts/[id]/` · `invoices/[id]/` · `change-orders/[id]/`

### Subcontractor Portal (src/app/sub-portal/)
`login/` · `projects/` · `projects/[id]/` · `projects/[id]/messages/`

### Company (src/app/company/)
`team-members/` (list + `[id]/`) · `subcontractors/` (list + `[id]/`) · `templates/` · `cost-codes/` · `vendors/`

### Settings & Manager
`settings/company/` · `settings/cost-codes/` · `manager/schedule/` · `manager/time-entries/` · `manager/variance/`

---

## Key Components (src/components/)

`AppLayout.tsx` (auth shell) · `Sidebar.tsx` (icon nav, permission-gated) · `Header.tsx` · `ProjectInnerSidebar.tsx` (project sub-nav) · `FileBrowser.tsx` · `SendEstimateModal.tsx` · `EstimateStatusDropdown.tsx` · `SignaturePad.tsx` · `StatusBadge.tsx` · `Avatar.tsx` · `PermissionsProvider.tsx` · `Providers.tsx`

---

## Key Libs (src/lib/)

`prisma.ts` (client singleton) · `auth.ts` (NextAuth config) · `permissions.ts` (RBAC engine — roles: ADMIN, MANAGER, FIELD_CREW, FINANCE) · `supabase.ts` (storage client) · `email.ts` (send emails) · `pdf.ts` (PDF helpers)

---

## Prisma Models (prisma/schema.prisma — 30+ models)

`User` · `Client` · `Lead` · `LeadTask` · `LeadMeeting` · `Project` · `FloorPlan` · `Estimate` · `EstimateItem` · `EstimatePaymentSchedule` · `Expense` · `Invoice` · `PaymentSchedule` · `Budget` · `CostCode` · `CostType` · `TimeEntry` · `Contract` · `ContractSigningRecord` · `CompanySettings` · `DocumentTemplate` · `ScheduleTask` · `TaskDependency` · `TaskComment` · `TaskPunchItem` · `TaskAssignment` · `Subcontractor` · `SubcontractorTrade` · `SubTaskAssignment` · `FileFolder` · `ProjectFile` · `UserPermission` · `ProjectAccess` · `Takeoff` · `TakeoffFile` · `PortalVisibility` · `ChangeOrder` · `Vendor` · `PurchaseOrder` · `Message`

---

## Coding Rules

1. **Server Components by default** — only `"use client"` when interactivity requires it
2. **Add server actions to `src/lib/actions.ts`** — do NOT create separate action files
3. **Use existing classes** — check `globals.css` before creating new CSS
4. **Use existing components** — check `src/components/` before creating new ones
5. **AI model**: always use `gemini-3-flash-preview`
6. **Auth bypass in dev**: middleware skips auth in development mode; AppLayout mocks an ADMIN session
**CRITICAL RULE: NEVER CREATE "DUMMY" OR UNWIRED BUTTONS.** 
7. **Every interactive element** (buttons, dropdowns, toggles) MUST be fully wired to either local state (Zustand/useState) or a functional backend server action. If you are building a UI and the backend logic is out of scope or undefined, **DO NOT ADD THE BUTTON**. Purely visual "placeholder" buttons are strictly forbidden.
8. **Constant Auditing:** As you go through the code on any page you are working on, actively double-check for existing missing button functions, dummy data, or unwired UI elements. If you find them, log them and explicitly ask the user for permission to wire them up.
