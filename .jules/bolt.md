## 2024-06-19 - Concurrent Prisma Queries
**Learning:** A common performance bottleneck in Next.js Server Components with Prisma is awaiting independent `findMany` queries sequentially, which cascades the Time to First Byte (TTFB).
**Action:** Always wrap independent database queries in a single `await Promise.all([])` block to parallelize them.
