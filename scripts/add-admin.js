const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const emails = [
    'jadkins@goldentouchremodeling.com',
    'justin.t.adkins@gmail.com',
    'justin@constructionio.com'
  ];
  
  for (const email of emails) {
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        console.log(`User ${email} already exists.`);
        if (existingUser.role !== 'ADMIN') {
            await prisma.user.update({
                where: { email },
                data: { role: 'ADMIN' }
            });
            console.log(`Updated user ${email} to ADMIN role.`);
        }
      } else {
        // Create new admin user
        const newUser = await prisma.user.create({
          data: {
            email,
            name: 'Justin Adkins',
            role: 'ADMIN',
          },
        });
        console.log(`Successfully created admin user: ${newUser.email}`);
      }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
