## 2024-05-18 - [Parallelize independent DB queries]
**Learning:** In Next.js Server Components, multiple sequential `await prisma.*.findMany(...)` queries can cascade and significantly delay Time to First Byte (TTFB).
**Action:** Always wrap independent database queries in a single `await Promise.all([])` block to execute them concurrently.
