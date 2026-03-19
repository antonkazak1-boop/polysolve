#!/usr/bin/env node
/**
 * Reset admin password in DB (run on server or locally).
 * Usage: node scripts/set-admin-password.cjs <newPassword> [email]
 * Default email: ADMIN_EMAIL from .env or tony@polysolve.local
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const BCRYPT_ROUNDS = 12;

async function main() {
  const password = process.argv[2];
  const emailArg = process.argv[3];
  const email = (emailArg || process.env.ADMIN_EMAIL || 'tony@polysolve.local').toLowerCase().trim();

  if (!password || password.length < 6) {
    console.error('Usage: node scripts/set-admin-password.cjs <password(6+ chars)> [email]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`No user with email: ${email}`);
      process.exit(1);
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        role: 'admin',
        name: user.name || 'Admin',
      },
    });
    console.log(`OK: password updated for ${email} (role=admin). Login with email or username «${(user.name || 'Admin').toLowerCase()}».`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
