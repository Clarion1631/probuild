## 2024-05-18 - Parallelize Sequential Prisma Queries
**Learning:** Sequential Prisma queries in Next.js Server Components cause cascading delays on Time to First Byte (TTFB). Even with connection pooling, four discrete database calls await sequentially (e.g. estimate -> timeEntries -> expenses -> purchaseOrders), causing a major server-side render bottleneck.
**Action:** Always wrap independent data fetching requirements within a single `await Promise.all([])` block in server components, especially in complex project dashboards.
