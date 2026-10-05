/**
 * LectureVault — Dashboard Server
 *
 * Express-based local dashboard bound to localhost only.
 * Serves a static HTML interface and a JSON API for recordings.
 */

import express from 'express';
import type { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { DatabaseManager } from '../database/DatabaseManager.js';
import type { RecordingStatus } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DashboardConfig {
  port: number;
}

export class DashboardServer {
  private app: express.Application;
  private server: ReturnType<express.Application['listen']> | null = null;
  private db: DatabaseManager;
  private config: DashboardConfig;
  private logger: Logger;

  constructor(db: DatabaseManager, config: DashboardConfig, logger: Logger) {
    this.db = db;
    this.config = config;
    this.logger = logger.child({ component: 'dashboard' });
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Parse JSON bodies
    this.app.use(express.json());

    // Serve static files from public directory
    const publicDir = path.resolve(__dirname, '../../public');
    this.app.use(express.static(publicDir));

    // Security headers
    this.app.use((_req: Request, res: Response, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // Only allow localhost
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost:' + this.config.port);
      next();
    });

    // Request logging
    this.app.use((req: Request, _res: Response, next) => {
      this.logger.debug({ method: req.method, path: req.path }, 'request');
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Get all recordings with optional status filter and sorting
    this.app.get('/api/recordings', (req: Request, res: Response) => {
      try {
        const status = req.query['status'] as RecordingStatus | undefined;
        const validStatuses: RecordingStatus[] = ['new', 'seen', 'processed'];

        let recordings;
        if (status && validStatuses.includes(status)) {
          recordings = this.db.getRecordingsByStatus(status);
        } else {
          recordings = this.db.getAllRecordings();
        }

        res.json({
          recordings,
          stats: this.db.getStats(),
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        this.logger.error({ err }, 'Failed to fetch recordings');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get stats
    this.app.get('/api/stats', (_req: Request, res: Response) => {
      try {
        const stats = this.db.getStats();
        res.json(stats);
      } catch (err) {
        this.logger.error({ err }, 'Failed to fetch stats');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Serve index.html for all other routes (SPA fallback)
    this.app.get('*', (_req: Request, res: Response) => {
      const indexPath = path.resolve(__dirname, '../../public/index.html');
      res.sendFile(indexPath);
    });
  }

  /** Start the dashboard server, bound to localhost only */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, '127.0.0.1', () => {
          this.logger.info(
            { port: this.config.port },
            `Dashboard running at http://localhost:${this.config.port}`
          );
          resolve();
        });

        this.server.on('error', (err) => {
          this.logger.error({ err }, 'Dashboard server error');
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Stop the dashboard server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info('Dashboard server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** Get the Express app instance (for testing) */
  getApp(): express.Application {
    return this.app;
  }
}
