## 2024-05-24 - Parallelize independent Prisma queries in Server Components
**Learning:** Next.js Server Components with multiple independent `await prisma...` queries executed sequentially cause cascading delays on Time to First Byte (TTFB). This codebase often fetches several distinct entities (e.g., projects, contracts) on dashboard-style pages without leveraging parallel execution.
**Action:** When multiple independent data fetching operations occur in a Server Component, wrap them in `await Promise.all([...])` to execute them concurrently, reducing total server response time.
