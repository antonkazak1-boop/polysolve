import bcrypt from 'bcrypt';
import prisma from '../src/config/database';

const NEW_PASSWORD = 'admin123';

async function main() {
  const hash = await bcrypt.hash(NEW_PASSWORD, 12);
  const u = await prisma.user.update({
    where: { email: 'tony@polysolve.local' },
    data: { passwordHash: hash },
    select: { id: true, email: true },
  });
  console.log(`✓ Password reset for ${u.email} (${u.id})`);
  await prisma.$disconnect();
}

main().catch(console.error);
