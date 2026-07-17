## 2024-06-21 - Parallelizing Prisma Queries in Server Components
**Learning:** Next.js Server Components frequently exhibit sequential database fetching patterns. Since Prisma queries are asynchronous, leaving them sequentially awaited causes an unnecessary cascading delay in Time to First Byte (TTFB).
**Action:** Always scan Server Components for independent, consecutive `await prisma...` calls and wrap them in a single `await Promise.all([])` block to ensure they resolve concurrently.
