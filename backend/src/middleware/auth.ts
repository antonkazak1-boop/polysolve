import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtPayload } from '../services/auth';
import prisma from '../config/database';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: string;
      userEmail?: string;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  try {
    const token = header.slice(7);
    const payload: JwtPayload = verifyAccessToken(token);
    req.userId = payload.userId;
    req.userRole = payload.role;
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function adminGuard(req: Request, res: Response, next: NextFunction) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export async function subscriptionGuard(req: Request, res: Response, next: NextFunction) {
  if (req.userRole === 'admin') return next();

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { subscriptionEnd: true },
    });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.subscriptionEnd || user.subscriptionEnd < new Date()) {
      return res.status(403).json({ error: 'Active subscription required', subscriptionEnd: user.subscriptionEnd });
    }
    next();
  } catch {
    return res.status(500).json({ error: 'Subscription check failed' });
  }
}
