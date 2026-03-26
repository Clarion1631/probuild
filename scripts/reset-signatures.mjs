import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const results = await p.estimate.updateMany({
  where: { status: 'Approved' },
  data: { status: 'Sent', approvedBy: null, approvedAt: null, approvalIp: null, approvalUserAgent: null, signatureUrl: null }
});

console.log('Reset estimates:', results.count);

const found = await p.estimate.findFirst({
  where: { status: 'Sent' },
  select: { id: true, code: true, title: true }
});

console.log('Use this link to test:', found ? `http://localhost:3000/portal/estimates/${found.id}` : 'No estimate found to test.');

await p.$disconnect();
