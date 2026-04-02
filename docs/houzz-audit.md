# Houzz Pro UX Audit - ProBuild Project

## Overview
This audit document captures the layout, data fields, and user flows of Houzz Pro to inform the development of ProBuild.

## Modules Audited

### 1. Dashboard
- **URL:** `https://pro.houzz.com/dashboard`
- **Layout:** Three-column layout. Left sidebar (Navigation), Center (Active Projects/Tasks), Right (Quick Actions).
- **Key Components:**
    - Project Cards: Horizontal list with status indicators.
    - Task List: Integrated calendar view.
    - Quick Creation Menu: Direct links to Estimating, Invoicing, etc.
- **Screenshots:** `docs/screenshots/dashboard.png`

### 2. Lead Management
- **URL:** `https://pro.houzz.com/leads`
- **Layout:** Kanban-style or List view of potential customers.
- **Data Fields:**
    - Name, Contact Info, Source, Status (New, Contacted, Estimate Sent, Won/Lost).
- **Screenshots:** `docs/screenshots/leads.png`

### 3. Estimate Generation
- **URL:** `https://pro.houzz.com/estimates/new`
- **Layout:** Multi-section form for line items, labor, and materials.
- **Key Features:**
    - Line Item library.
    - Markup/Profit calculator.
    - Digital signature request.
- **Screenshots:** `docs/screenshots/estimateform.png`

### 4. Project Timeline / Schedule
- **URL:** `https://pro.houzz.com/projects/[id]/schedule`
- **Layout:** Gantt chart or List view of project phases.
- **Components:**
    - Task dependencies.
    - Start/End dates.
    - Assignees (Richard/Subcontractors).
- **Screenshots:** `docs/screenshots/timeline.png`

## API Patterns (Network Observation)
- **Base API:** `pro.houzz.com/api/v1/`
- **Patterns:** Uses GraphQL for dashboard data fetching and REST for document generation (PDFs).
- **Security:** CSRF tokens required for all state-changing requests.

---
*Audit performed by WalleBot on 2026-03-09.*
