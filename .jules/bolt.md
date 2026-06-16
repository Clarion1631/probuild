## 2024-05-18 - Optimize heavy chart rendering
**Learning:** Recharts can block the main thread and impact TTI (Time to Interactive), especially on pages that also load other heavy components. Loading it dynamically with `ssr: false` prevents hydration mismatch errors and speeds up the initial page load for components not immediately visible or necessary for LCP.
**Action:** Use `next/dynamic` to dynamically import recharts components like `JobCostingClient` or individual charts where appropriate to improve frontend performance.
