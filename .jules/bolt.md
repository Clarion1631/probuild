## 2026-06-23 - Next.js Server Components Sequential Query Bottlenecks
**Learning:** In Next.js Server Components that use Prisma, independent `await prisma...` queries executed sequentially can cause significant cascading delays, increasing the Time To First Byte (TTFB). This often occurs when fetching multiple independent entities (e.g., projects and contracts) for a single page view.
**Action:** Always scan Server Components for independent sequential database queries and wrap them in a single `await Promise.all([])` block to execute them concurrently, reducing total response time.
