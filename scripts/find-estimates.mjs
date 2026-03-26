import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const results = await p.estimate.findMany({
  where: { status: { not: 'Approved' } },
  take: 5,
  select: {
    id: true, code: true, status: true, title: true,
    project: { select: { name: true, client: { select: { name: true, email: true } } } },
    lead: { select: { name: true, client: { select: { name: true, email: true } } } },
  },
  orderBy: { createdAt: 'desc' },
});

console.log(JSON.stringify(results, null, 2));
await p.$disconnect();
