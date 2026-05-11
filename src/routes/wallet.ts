//routes/wallet.ts

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { saveWallet, getWallet } from '../services/wallet';
import { requireApiSecret } from '../middleware/auth';
import { walletSaveLimiter, walletReadLimiter } from '../middleware/rateLimit';
import { logSecurityEvent } from '../config/logger';
import { walletLog } from '../config/logger';
import { config } from '../config/env';

const router = Router();
router.use(requireApiSecret);

const saveSchema = z.object({
  customerId: z
    .string()
    .min(1)
    .refine((id) => id.startsWith('gid://shopify/Customer/'), {
      message: 'Must be a Shopify Customer GID',
    }),
  walletAddress: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid Solana address'),
  walletSource: z.enum(['privy', 'external']),
  signature: z.string().optional(),
  message: z.string().optional(),
});

router.post('/save', walletSaveLimiter, async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip || req.socket.remoteAddress || '-';
  const requestId = (req.headers['x-request-id'] as string) || '-';

  try {
    const parsed = saveSchema.safeParse(req.body);

    if (!parsed.success) {
      logSecurityEvent({
        type: 'validation_failure',
        ip,
        path: req.path,
        requestId,
        details: JSON.stringify(parsed.error.flatten().fieldErrors),
      });

      res.status(400).json({
        success: false,
        error: 'Validation error',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await saveWallet(parsed.data);

    logSecurityEvent({
      type: 'wallet_save',
      ip,
      path: req.path,
      requestId,
      customerId: parsed.data.customerId,
      details: `${parsed.data.walletAddress.slice(0, 4)}...${parsed.data.walletAddress.slice(-4)}`,
    });

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    walletLog.error({ ip, requestId, err: message }, 'wallet/save error');
    res.status(500).json({
      success: false,
      error: config.isProduction ? 'Failed to save wallet' : message,
    });
  }
});

router.get('/:customerId', walletReadLimiter, async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip || req.socket.remoteAddress || '-';
  const requestId = (req.headers['x-request-id'] as string) || '-';

  try {
    const customerId = req.params.customerId as string;

    if (!customerId.startsWith('gid://shopify/Customer/')) {
      logSecurityEvent({
        type: 'validation_failure',
        ip,
        path: req.path,
        requestId,
        details: 'Attempted raw ID access (enumeration attempt)',
      });

      res.status(400).json({
        success: false,
        error: 'Must provide full Shopify Customer GID',
      });
      return;
    }

    logSecurityEvent({
      type: 'wallet_read',
      ip,
      path: req.path,
      requestId,
      customerId,
    });

    const walletAddress = await getWallet(customerId);
    res.json({ success: true, data: { walletAddress } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    walletLog.error({ ip, requestId, err: message }, 'wallet/get error');
    res.status(500).json({
      success: false,
      error: config.isProduction ? 'Failed to read wallet' : message,
    });
  }
});

export default router;