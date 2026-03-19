import { Router, Request, Response } from 'express';
import {
  register,
  login,
  refreshTokens,
  getProfile,
  updateProfile,
  changePassword,
  savePolyKeys,
  getPolyKeysStatus,
  deletePolyKeys,
} from '../../services/auth';
import { authMiddleware } from '../../middleware/auth';

export const authRouter = Router();

// POST /api/auth/register
authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = await register(email, password, name);
    res.json(result);
  } catch (err: any) {
    const status = err.message === 'Email already registered' ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/auth/login
authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = await login(email, password);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

// POST /api/auth/refresh
authRouter.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
    const result = await refreshTokens(refreshToken);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// --- Protected routes below ---

// GET /api/auth/me
authRouter.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await getProfile(req.userId!);
    res.json(user);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// PATCH /api/auth/profile
authRouter.patch('/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await updateProfile(req.userId!, { name: req.body.name });
    res.json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/auth/password
authRouter.patch('/password', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'oldPassword and newPassword required' });
    await changePassword(req.userId!, oldPassword, newPassword);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/auth/poly-keys
authRouter.put('/poly-keys', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { privateKey, apiKey, apiSecret, apiPassphrase, funderAddress, signatureType } = req.body;
    if (!privateKey && !apiKey) return res.status(400).json({ error: 'At least privateKey or apiKey required' });
    await savePolyKeys(req.userId!, {
      privateKey, apiKey, apiSecret, apiPassphrase, funderAddress,
      signatureType: signatureType !== undefined ? parseInt(signatureType) : undefined,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/auth/poly-keys/status
authRouter.get('/poly-keys/status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const status = await getPolyKeysStatus(req.userId!);
    res.json(status);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/auth/poly-keys
authRouter.delete('/poly-keys', authMiddleware, async (req: Request, res: Response) => {
  try {
    await deletePolyKeys(req.userId!);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
