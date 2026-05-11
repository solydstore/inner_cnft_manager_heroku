import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { logSecurityEvent } from '../config/logger';

/**
 * Timing-safe secret comparison.
 * Prevents timing attacks by always comparing in constant time.
 */
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) {
    // Still do a dummy comparison to avoid leaking length info via timing
    crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(expected)
    );
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(expected)
  );
}

/**
 * HMAC request signature verification.
 *
 * The client sends:
 *   x-api-secret: <shared secret>
 *   x-request-timestamp: <unix ms>
 *   x-request-signature: <HMAC-SHA256 of timestamp + method + path + body>
 *
 * In production (REQUIRE_HMAC=true, default), all three headers are required.
 * In development, signature headers are optional for easier testing.
 * The timestamp must be within 5 minutes to prevent replay attacks.
 */
function verifySignature(req: Request): { valid: boolean; reason?: string } {
  const timestamp = req.headers['x-request-timestamp'] as string | undefined;
  const signature = req.headers['x-request-signature'] as string | undefined;

  // In production, HMAC is mandatory
  if (config.requireHmac) {
    if (!timestamp || !signature) {
      return { valid: false, reason: 'Missing HMAC headers (x-request-timestamp, x-request-signature)' };
    }
  } else {
    // Development: skip if not provided
    if (!timestamp || !signature) return { valid: true };
  }

  // Reject requests older than 5 minutes
  const requestTime = parseInt(timestamp!, 10);
  const now = Date.now();
  if (isNaN(requestTime) || Math.abs(now - requestTime) > 5 * 60 * 1000) {
    return { valid: false, reason: 'Request timestamp expired or invalid (5 min window)' };
  }

  // Build the signing payload: timestamp + METHOD + path + body
  const body = JSON.stringify(req.body || {});
  const payload = `${timestamp}:${req.method}:${req.path}:${body}`;

  const expected = crypto
    .createHmac('sha256', config.apiSecret)
    .update(payload)
    .digest('hex');

  if (!secretsMatch(signature!, expected)) {
    return { valid: false, reason: 'HMAC signature mismatch' };
  }

  return { valid: true };
}

export function requireApiSecret(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = req.headers['x-api-secret'] as string | undefined;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const requestId = (req.headers['x-request-id'] as string) || '';

  // Check API secret
  if (!secret || !secretsMatch(secret, config.apiSecret)) {
    logSecurityEvent({
      type: 'auth_failure',
      ip,
      path: req.path,
      requestId,
      details: 'Invalid or missing API secret',
    });

    res.status(401).json({
      success: false,
      error: 'Unauthorized',
    });
    return;
  }

  // Verify HMAC signature
  const hmacResult = verifySignature(req);
  if (!hmacResult.valid) {
    logSecurityEvent({
      type: 'auth_failure',
      ip,
      path: req.path,
      requestId,
      details: hmacResult.reason || 'HMAC verification failed',
    });

    res.status(401).json({
      success: false,
      error: 'Unauthorized',
    });
    return;
  }

  next();
}