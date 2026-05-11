import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/env';
import { httpLogger, serverLog } from './config/logger';
import { globalLimiter } from './middleware/rateLimit';
import { requestId } from './middleware/requestId';

import healthRoutes from './routes/health';
import walletRoutes from './routes/wallet';
import claimRoutes from './routes/claim';
import eventsRoutes from './routes/events';
import legacyRoutes from './routes/legacy';

const app = express();

// Request ID tracking (must be first)
app.use(requestId);

// Structured HTTP logging (replaces morgan)
app.use(httpLogger);

// Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })
);

// Body parser
app.use(express.json({ limit: '16kb' }));

// CORS
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (config.allowedOrigins.length === 0) {
        return callback(new Error('CORS: No origins configured'));
      }
      if (config.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-secret', 'x-request-timestamp', 'x-request-signature', 'x-request-id'],
  })
);

// Rate limiting
app.use(globalLimiter);

// Cache control
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/claim', claimRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/legacy', legacyRoutes);

// 404 handler
app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// Error handler
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    serverLog.error({ err: err.message }, 'Unhandled error');
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
);

export default app;