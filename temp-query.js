const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.user.findMany().then(u => {
    console.log(JSON.stringify(u, null, 2));
    prisma.$disconnect();
}).catch(e => {
    console.error(e);
    prisma.$disconnect();
});
