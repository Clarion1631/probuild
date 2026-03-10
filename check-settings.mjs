import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const s = await prisma.companySettings.findFirst();
console.log('Company:', s?.companyName);
console.log('Logo:', s?.logoUrl ? 'YES (' + s.logoUrl.substring(0, 50) + '...)' : 'NOT SET');
console.log('Phone:', s?.phone);
console.log('Address:', s?.address);
console.log('Email:', s?.email);
await prisma.$disconnect();
