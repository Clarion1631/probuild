## 2024-06-12 - Prevent Cascading TTFB Delays in Next.js Server Components
**Learning:** Sequential Prisma queries (e.g., multiple independent `findMany` calls) in Next.js Server Components cause cascading delays on Time to First Byte (TTFB). This is a noticeable performance bottleneck as the server waits for each query to finish before starting the next one.
**Action:** Always wrap independent Prisma database queries in a single `await Promise.all([])` block within Next.js Server Components rather than awaiting them sequentially.
