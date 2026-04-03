/**
 * One-time script: save Polymarket CLOB keys from .env into the admin user's DB profile.
 * Usage: npx ts-node scripts/seed-poly-keys.ts
 */
import * as cryptoMod from 'crypto';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  console.error('ENCRYPTION_KEY missing or not 64 hex chars');
  process.exit(1);
}

const IV_LENGTH = 16; // must match backend/src/utils/crypto.ts
const TAG_LENGTH = 16;

function encrypt(plain: string): string {
  const iv = cryptoMod.randomBytes(IV_LENGTH);
  const cipher = cryptoMod.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ct = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const d = cryptoMod.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  d.setAuthTag(tag);
  return d.update(ct) + d.final('utf8');
}

const PK = process.env.POLY_PRIVATE_KEY;
const API_KEY = process.env.POLY_API_KEY;
const API_SECRET = process.env.POLY_API_SECRET;
const API_PASSPHRASE = process.env.POLY_API_PASSPHRASE;
const FUNDER = process.env.POLY_FUNDER_ADDRESS;
const SIG_TYPE = parseInt(process.env.POLY_SIGNATURE_TYPE || '0');

const missing = [
  !PK && 'POLY_PRIVATE_KEY',
  !API_KEY && 'POLY_API_KEY',
  !API_SECRET && 'POLY_API_SECRET',
  !API_PASSPHRASE && 'POLY_API_PASSPHRASE',
].filter(Boolean);

if (missing.length > 0) {
  console.error('Missing in .env:', missing.join(', '));
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: 'admin' }, orderBy: { createdAt: 'asc' } });
  if (!admin) {
    console.error('No admin user found in DB');
    process.exit(1);
  }

  await prisma.user.update({
    where: { id: admin.id },
    data: {
      polyPrivateKeyEnc: encrypt(PK!),
      polyApiKeyEnc: encrypt(API_KEY!),
      polyApiSecretEnc: encrypt(API_SECRET!),
      polyApiPassphraseEnc: encrypt(API_PASSPHRASE!),
      polyFunderAddress: FUNDER || null,
      polySignatureType: SIG_TYPE,
    },
  });

  // Verify by reading back and decrypting
  const updated = await prisma.user.findUnique({ where: { id: admin.id } });
  const pkCheck = decrypt(updated!.polyPrivateKeyEnc!);
  const apiCheck = decrypt(updated!.polyApiKeyEnc!);
  const ok = pkCheck === PK && apiCheck === API_KEY;

  console.log(`✓ Polymarket keys saved for admin: ${admin.email} (${admin.id})`);
  console.log(`  Funder: ${FUNDER || '(none, using EOA)'}`);
  console.log(`  SigType: ${SIG_TYPE}`);
  console.log(`  Decrypt verify: ${ok ? '✓ OK' : '✗ MISMATCH — check ENCRYPTION_KEY'}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
