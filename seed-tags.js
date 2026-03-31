const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tags = [
    "Accessories",
    "Art",
    "Decor",
    "Fabric",
    "Furniture",
    "Lighting",
    "Rugs",
    "Tile",
    "Wallpaper"
  ];

  for (const t of tags) {
    await prisma.vendorTag.upsert({
      where: { name: t },
      update: {},
      create: { name: t },
    });
  }
  
  console.log("Seed tags completed");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
