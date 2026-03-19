import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import prisma from '../config/database';
import { encrypt, decrypt } from '../utils/crypto';

const BCRYPT_ROUNDS = 12;

function getJwtSecret(): string {
  return process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
}

function getRefreshSecret(): string {
  return process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me';
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '24h' });
}

function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, getRefreshSecret(), { expiresIn: '30d' });
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, getJwtSecret()) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, getRefreshSecret()) as JwtPayload;
}

export async function register(email: string, password: string, name?: string) {
  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (existing) throw new Error('Email already registered');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      passwordHash,
      name: name || null,
    },
  });

  // Create default copy settings
  await prisma.userCopySettings.create({
    data: { userId: user.id },
  });

  const payload: JwtPayload = { userId: user.id, email: user.email, role: user.role };
  return {
    user: sanitizeUser(user),
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  };
}

export async function login(email: string, password: string) {
  const input = email.toLowerCase().trim();
  let user = await prisma.user.findUnique({ where: { email: input } });
  if (!user && !input.includes('@')) {
    const all = await prisma.user.findMany({
      where: { name: { not: null } },
    });
    user = all.find(u => u.name?.toLowerCase() === input) || null;
  }
  if (!user) throw new Error('Invalid credentials');
  if (!user.isActive) throw new Error('Account is disabled');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new Error('Invalid credentials');

  const payload: JwtPayload = { userId: user.id, email: user.email, role: user.role };
  return {
    user: sanitizeUser(user),
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  };
}

export async function refreshTokens(refreshToken: string) {
  const decoded = verifyRefreshToken(refreshToken);
  const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
  if (!user || !user.isActive) throw new Error('Invalid refresh token');

  const payload: JwtPayload = { userId: user.id, email: user.email, role: user.role };
  return {
    user: sanitizeUser(user),
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  };
}

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');
  return sanitizeUser(user);
}

export async function updateProfile(userId: string, data: { name?: string }) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { name: data.name },
  });
  return sanitizeUser(user);
}

export async function changePassword(userId: string, oldPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  const valid = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!valid) throw new Error('Current password is incorrect');
  if (newPassword.length < 6) throw new Error('New password must be at least 6 characters');

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
  });
}

/**
 * Verifies a Hostkey Invapi **server** API key (not account-wide billing key).
 * See https://invapi.hostkey.ru/auth.php action=login
 */
export async function verifyHostkeyServerApiKey(hostkeyApiKey: string): Promise<boolean> {
  const key = (hostkeyApiKey || '').trim();
  if (!key || key.length < 10) return false;
  try {
    const body = new URLSearchParams();
    body.set('action', 'login');
    body.set('key', key);
    body.set('fix_ix', '0');
    const { data } = await axios.post('https://invapi.hostkey.ru/auth.php', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20_000,
      validateStatus: () => true,
    });
    if (data?.result === -1 || !data?.result?.token) return false;
    const roleType = String(data.result.role_type || '');
    // Server keys: "server 71894". Account keys: "Customer" — reject those.
    if (!/^server\s+\d+/i.test(roleType)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Set password (and admin role) for an existing user by email — for recovery flows only. */
export async function forceSetAdminPassword(email: string, newPassword: string) {
  if (newPassword.length < 6) throw new Error('Password must be at least 6 characters');
  const e = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: e } });
  if (!user) throw new Error('User not found for this email');
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
      role: 'admin',
      name: user.name || 'Admin',
    },
  });
}

// --- Poly Keys ---

export async function savePolyKeys(userId: string, keys: {
  privateKey?: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  funderAddress?: string;
  signatureType?: number;
}) {
  const data: Record<string, any> = {};
  if (keys.privateKey) data.polyPrivateKeyEnc = encrypt(keys.privateKey);
  if (keys.apiKey) data.polyApiKeyEnc = encrypt(keys.apiKey);
  if (keys.apiSecret) data.polyApiSecretEnc = encrypt(keys.apiSecret);
  if (keys.apiPassphrase) data.polyApiPassphraseEnc = encrypt(keys.apiPassphrase);
  if (keys.funderAddress !== undefined) data.polyFunderAddress = keys.funderAddress || null;
  if (keys.signatureType !== undefined) data.polySignatureType = keys.signatureType;

  await prisma.user.update({ where: { id: userId }, data });
}

export async function getPolyKeysStatus(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      polyPrivateKeyEnc: true,
      polyApiKeyEnc: true,
      polyApiSecretEnc: true,
      polyApiPassphraseEnc: true,
      polyFunderAddress: true,
      polySignatureType: true,
    },
  });
  if (!user) throw new Error('User not found');
  return {
    hasPrivateKey: !!user.polyPrivateKeyEnc,
    hasApiKey: !!user.polyApiKeyEnc,
    hasApiSecret: !!user.polyApiSecretEnc,
    hasApiPassphrase: !!user.polyApiPassphraseEnc,
    funderAddress: user.polyFunderAddress || null,
    signatureType: user.polySignatureType,
    configured: !!(user.polyPrivateKeyEnc && user.polyApiKeyEnc && user.polyApiSecretEnc && user.polyApiPassphraseEnc),
  };
}

export async function getDecryptedPolyKeys(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      polyPrivateKeyEnc: true,
      polyApiKeyEnc: true,
      polyApiSecretEnc: true,
      polyApiPassphraseEnc: true,
      polyFunderAddress: true,
      polySignatureType: true,
    },
  });
  if (!user) return null;
  if (!user.polyPrivateKeyEnc || !user.polyApiKeyEnc || !user.polyApiSecretEnc || !user.polyApiPassphraseEnc) return null;
  return {
    privateKey: decrypt(user.polyPrivateKeyEnc),
    apiKey: decrypt(user.polyApiKeyEnc),
    apiSecret: decrypt(user.polyApiSecretEnc),
    apiPassphrase: decrypt(user.polyApiPassphraseEnc),
    funderAddress: user.polyFunderAddress || undefined,
    signatureType: user.polySignatureType,
  };
}

export async function deletePolyKeys(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      polyPrivateKeyEnc: null,
      polyApiKeyEnc: null,
      polyApiSecretEnc: null,
      polyApiPassphraseEnc: null,
      polyFunderAddress: null,
      polySignatureType: 0,
    },
  });
}

// --- Admin auto-create ---

export async function ensureAdminExists() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) return;

  const existing = await prisma.user.findUnique({ where: { email: adminEmail.toLowerCase().trim() } });
  if (existing) {
    if (existing.role !== 'admin') {
      await prisma.user.update({ where: { id: existing.id }, data: { role: 'admin' } });
      console.log(`[auth] Promoted ${adminEmail} to admin`);
    }
    // One-shot password sync (set in .env, restart backend once, then remove flag)
    if (process.env.ADMIN_FORCE_PASSWORD_RESET === '1') {
      const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);
      await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, name: existing.name || 'Admin' },
      });
      console.log(
        '[auth] Admin password updated from ADMIN_PASSWORD (remove ADMIN_FORCE_PASSWORD_RESET=1 from .env and restart)',
      );
    }
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      email: adminEmail.toLowerCase().trim(),
      passwordHash,
      name: 'Admin',
      role: 'admin',
    },
  });
  await prisma.userCopySettings.create({ data: { userId: user.id } });
  console.log(`[auth] Admin account created: ${adminEmail}`);
}

// --- Helpers ---

function sanitizeUser(user: any) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    subscriptionEnd: user.subscriptionEnd,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}
