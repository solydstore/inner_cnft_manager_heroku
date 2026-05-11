import rateLimit from 'express-rate-limit';
import { logSecurityEvent } from '../config/logger';
import type { Request } from 'express';

/**
 * C-02 FIX: Rate limiting.
 *
 * Wallet save: 10 requests per minute per IP (aggressive, writes are rare)
 * Wallet read: 30 requests per minute per IP
 * Global fallback: 60 requests per minute per IP
 */

function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export const walletSaveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  handler: (req, res) => {
    logSecurityEvent({
      type: 'rate_limit',
      ip: getClientIp(req),
      path: req.path,
      details: 'Wallet save rate limit exceeded',
    });
    res.status(429).json({
      success: false,
      error: 'Too many requests. Please try again later.',
    });
  },
});

export const walletReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  handler: (req, res) => {
    logSecurityEvent({
      type: 'rate_limit',
      ip: getClientIp(req),
      path: req.path,
      details: 'Wallet read rate limit exceeded',
    });
    res.status(429).json({
      success: false,
      error: 'Too many requests. Please try again later.',
    });
  },
});

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
});

// Claim rate limiters - more restrictive since minting is expensive
export const claimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // 5 claim requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  handler: (req, res) => {
    logSecurityEvent({
      type: 'rate_limit',
      ip: getClientIp(req),
      path: req.path,
      details: 'SBT claim rate limit exceeded',
    });
    res.status(429).json({
      success: false,
      error: 'Too many claim requests. Please wait a moment.',
    });
  },
});

export const claimStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 status checks per minute (polling)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIp,
  handler: (req, res) => {
    logSecurityEvent({
      type: 'rate_limit',
      ip: getClientIp(req),
      path: req.path,
      details: 'Claim status rate limit exceeded',
    });
    res.status(429).json({
      success: false,
      error: 'Too many requests. Please try again later.',
    });
  },
});