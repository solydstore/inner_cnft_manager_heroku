/**
 * SBT Claim Routes
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireApiSecret } from '../middleware/auth';
import { claimLimiter, claimStatusLimiter } from '../middleware/rateLimit';
import { logSecurityEvent } from '../config/logger';
import { claimLog } from '../config/logger';
import { config } from '../config/env';
import { initiateClaim, getClaimStatus, retryFailedClaim } from '../services/claim';
import { isMintingConfigured, checkTreeCapacity } from '../services/minting';

const router = Router();
router.use(requireApiSecret);

// ============================================
// VALIDATION SCHEMAS
// ============================================

const claimStartSchema = z.object({
  customerId: z
    .string()
    .min(1)
    .refine((id) => id.startsWith('gid://shopify/Customer/'), {
      message: 'Must be a Shopify Customer GID',
    }),
  orderId: z
    .string()
    .min(1)
    .refine((id) => id.startsWith('gid://shopify/Order/'), {
      message: 'Must be a Shopify Order GID',
    }),
  lineItemIds: z
    .array(
      z.string().refine((id) => id.startsWith('gid://shopify/LineItem/'), {
        message: 'Each must be a Shopify LineItem GID',
      })
    )
    .min(1)
    .max(20, 'Cannot claim more than 20 items at once'),
  walletAddress: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid Solana address'),
});

const claimStatusSchema = z.object({
  orderId: z
    .string()
    .min(1)
    .refine((id) => id.startsWith('gid://shopify/Order/'), {
      message: 'Must be a Shopify Order GID',
    }),
  lineItemIds: z
    .array(z.string())
    .optional(),
});

const retrySchema = z.object({
  customerId: z
    .string()
    .min(1)
    .refine((id) => id.startsWith('gid://shopify/Customer/'), {
      message: 'Must be a Shopify Customer GID',
    }),
  orderId: z
    .string()
    .min(1)
    .refine((id) => id.startsWith('gid://shopify/Order/'), {
      message: 'Must be a Shopify Order GID',
    }),
  lineItemId: z
    .string()
    .refine((id) => id.startsWith('gid://shopify/LineItem/'), {
      message: 'Must be a Shopify LineItem GID',
    }),
  walletAddress: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid Solana address'),
});

// ============================================
// ROUTES
// ============================================

router.post('/start', claimLimiter, async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip || req.socket.remoteAddress || '-';
  const requestId = (req.headers['x-request-id'] as string) || '-';

  try {
    const parsed = claimStartSchema.safeParse(req.body);

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

    if (!isMintingConfigured()) {
      res.status(503).json({ success: false, error: 'Minting service is not available' });
      return;
    }

    const result = await initiateClaim(parsed.data);

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.status(202).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    claimLog.error({ ip, requestId, err: message }, 'claim/start error');
    res.status(500).json({
      success: false,
      error: config.isProduction ? 'Failed to start claim' : message,
    });
  }
});

router.post('/status', claimStatusLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = claimStatusSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { orderId, lineItemIds } = parsed.data;
    const result = await getClaimStatus(orderId, lineItemIds);

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    claimLog.error({ err: message }, 'claim/status error');
    res.status(500).json({
      success: false,
      error: config.isProduction ? 'Failed to get claim status' : message,
    });
  }
});

router.post('/retry', claimLimiter, async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip || req.socket.remoteAddress || '-';
  const requestId = (req.headers['x-request-id'] as string) || '-';

  try {
    const parsed = retrySchema.safeParse(req.body);

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

    const { customerId, orderId, lineItemId, walletAddress } = parsed.data;
    const result = await retryFailedClaim(customerId, orderId, lineItemId, walletAddress);

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.status(202).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    claimLog.error({ ip, requestId, err: message }, 'claim/retry error');
    res.status(500).json({
      success: false,
      error: config.isProduction ? 'Failed to retry claim' : message,
    });
  }
});

router.get('/health', async (_req: Request, res: Response): Promise<void> => {
  try {
    const configured = isMintingConfigured();

    if (!configured) {
      res.json({ success: true, configured: false, message: 'Minting service not configured' });
      return;
    }

    const treeStatus = await checkTreeCapacity();

    res.json({
      success: true,
      configured: true,
      tree: {
        minted: treeStatus.minted,
        capacity: treeStatus.capacity,
        remaining: treeStatus.remaining,
        percentUsed: treeStatus.percentUsed.toFixed(2),
        isFull: treeStatus.isFull,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    claimLog.error({ err: message }, 'claim/health error');
    res.status(500).json({
      success: false,
      error: config.isProduction ? 'Health check failed' : message,
    });
  }
});

export default router;