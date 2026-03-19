import { Router, Request, Response } from 'express';
import prisma from '../../config/database';
import { authMiddleware, adminGuard } from '../../middleware/auth';

export const adminRouter = Router();

// All admin routes require auth + admin role
adminRouter.use(authMiddleware, adminGuard);

// GET /api/admin/users
adminRouter.get('/users', async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        subscriptionEnd: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        polyFunderAddress: true,
        _count: { select: { copyWallets: true, liveTrades: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list users', detail: err.message });
  }
});

// PATCH /api/admin/users/:id
adminRouter.patch('/users/:id', async (req: Request, res: Response) => {
  try {
    const { role, isActive, subscriptionEnd, name } = req.body;
    const data: Record<string, any> = {};
    if (role !== undefined && ['admin', 'user'].includes(role)) data.role = role;
    if (isActive !== undefined) data.isActive = Boolean(isActive);
    if (subscriptionEnd !== undefined) {
      data.subscriptionEnd = subscriptionEnd ? new Date(subscriptionEnd) : null;
    }
    if (name !== undefined) data.name = name;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: {
        id: true, email: true, name: true, role: true,
        subscriptionEnd: true, isActive: true, createdAt: true,
      },
    });
    res.json(user);
  } catch (err: any) {
    res.status(400).json({ error: 'Failed to update user', detail: err.message });
  }
});

// DELETE /api/admin/users/:id
adminRouter.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: 'Failed to delete user', detail: err.message });
  }
});
