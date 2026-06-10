## 2024-06-10 - Waterfall Sequential Network Round Trips

**Learning:** In Next.js Server Components, performing multiple independent Prisma queries sequentially (e.g., `estimate.findMany`, `changeOrder.findMany`, etc. in `getBudgetData`) creates a waterfall of network round trips that unnecessarily blocks rendering and increases Time to First Byte (TTFB).

**Action:** Identify independent database queries within the same server action or component and wrap them in a single `await Promise.all([])` block to run them concurrently.
