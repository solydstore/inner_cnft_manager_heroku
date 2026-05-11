import { Router, Request, Response } from 'express';

const router = Router();

// M-05 FIX: Minimal information disclosure
// Only return status. No service name, no timestamp.
router.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

export default router;