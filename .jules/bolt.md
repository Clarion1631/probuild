## 2024-05-18 - Avoid Sequential Awaits in Next.js Server Components
**Learning:** Next.js Server Components can suffer from severe TTFB (Time To First Byte) delays if multiple independent Prisma database queries are awaited sequentially (e.g. \`await prisma.A()\`, \`await prisma.B()\`).
**Action:** Always wrap independent data fetching operations in \`await Promise.all([prisma.A(), prisma.B()])\` to parallelize them and improve performance.
