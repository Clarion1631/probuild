# ProBuild Agent Workflow Groups

To ensure agents don't step on each other's toes or clash over overlapping UI components, execute these workflows in the following grouped phases. Wait for one group to be completely built, merged, and deployed before starting the agents on the next group.

## Group 1: Core Financials (Completed/Priority)
These foundations must exist before building out advanced PM tools.
- `01-estimates-workflow.txt`
- `02-invoicing-system.txt`
- `03-stripe-payments.txt`
- `03b-wisetack-financing.txt`

## Group 2: The Client Portal & Comms
These touch the `portal/` directory heavily. Run them together so the agent can build a cohesive client experience without duplicate files.
- `04-portal-visibility.txt`
- `05-client-messaging.txt`
- `14-clients-management.txt`
- `21-mood-boards.txt`

## Group 3: Subcontractor Ecosystem
These focus primarily on the `sub-portal/` and Subcontractor components.
- `06-subcontractor-portal.txt`
- `07-sub-messaging.txt`
- `08-certificate-vault.txt`

## Group 4: Project Management Operations
These are heavy internal tools that modify the `projects/[id]` application area.
- `10-change-orders.txt`
- `11-daily-logs.txt`
- `12-budget-vs-actual.txt`
- `13-purchase-orders.txt`

## Group 5: External Syncs & Accounting
These rely heavily on external APIs. Safe to run after the core features are stable.
- `15-quickbooks-sync.txt`
- `16-gusto-sync.txt`

## Group 6: Platform-wide Upgrades
Run these last, as they need to query/index all the entities built in Groups 1-5.
- `09-leads-kanban.txt` (Safe to run anytime)
- `17-reports-analytics.txt`
- `18-global-search.txt`
- `19-notification-center.txt`
- `20-mobile-app.txt`
