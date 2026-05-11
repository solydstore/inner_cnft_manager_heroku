/**
 * SSE (Server-Sent Events) Route
 */

import { Router, Request, Response } from 'express';
import { requireApiSecret } from '../middleware/auth';
import { onClaimEvent, type MintEvent } from '../services/mintEvents';
import { sseLog } from '../config/logger';

const router = Router();
router.use(requireApiSecret);

const SSE_TIMEOUT_MS = 5 * 60 * 1000;

router.get('/claim', (req: Request, res: Response): void => {
  const claimId = req.query.claimId as string;
  const ip = req.ip || req.socket.remoteAddress || '-';

  if (!claimId) {
    res.status(400).json({ success: false, error: 'Missing claimId query param' });
    return;
  }

  sseLog.info({ claimId, ip }, `CONNECTED ${claimId}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ claimId })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 30000);

  const unsubscribe = onClaimEvent(claimId, (event: MintEvent) => {
    const payload = JSON.stringify({
      type: event.type,
      claimId: event.claimId,
      orderId: event.orderId,
      lineItemId: event.lineItemId,
      sku: event.sku,
      data: event.data,
    });

    sseLog.info({ claimId, lineItemId: event.lineItemId, type: event.type }, `PUSH ${event.type} ${event.lineItemId}`);
    res.write(`event: mint_update\ndata: ${payload}\n\n`);
  });

  const timeout = setTimeout(() => {
    sseLog.info({ claimId }, `TIMEOUT ${claimId}`);
    res.write(`event: timeout\ndata: ${JSON.stringify({ message: 'Connection timed out' })}\n\n`);
    cleanup();
  }, SSE_TIMEOUT_MS);

  function cleanup() {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    unsubscribe();
    sseLog.info({ claimId }, `CLOSED ${claimId}`);
    res.end();
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;