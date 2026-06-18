## 2026-06-18 - Prevent Database Query Waterfalls in Next.js Server Components
**Learning:** Found sequential independent `prisma.*.findMany()` database queries in server components (`JobCostingPage`, `TimeClockPage`), creating unnecessary waterfall delays that block Time to First Byte (TTFB).
**Action:** Always wrap independent server-side database fetches in a single `await Promise.all([])` block to execute them in parallel and improve TTFB.
