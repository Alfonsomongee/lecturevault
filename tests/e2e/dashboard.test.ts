import { test, expect, type Page } from '@playwright/test';
import { DashboardServer } from '../../src/dashboard/DashboardServer.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import pino from 'pino';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let dbManager: DatabaseManager;
let server: DashboardServer;
let serverUrl: string;
let tempDbPath: string;

test.beforeAll(async () => {
    const logger = pino({ level: 'silent' });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
    tempDbPath = path.join(tempDir, `test.db`);
    
    dbManager = new DatabaseManager(tempDbPath, logger);
    
    // Find a random port for the test server
    const port = Math.floor(Math.random() * (65535 - 1024) + 1024);
    serverUrl = `http://localhost:${port}`;
    
    server = new DashboardServer(dbManager, { port }, logger);
    await server.start();
});

test.afterAll(async () => {
    if (server) {
        await server.stop();
    }
    if (dbManager) {
        dbManager.close();
    }
    if (tempDbPath && fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
        try {
            fs.rmdirSync(path.dirname(tempDbPath));
        } catch (e) {
            // Ignore if not empty
        }
    }
});

test.describe('Dashboard E2E Tests - Empty State', () => {
    test('1. Page loads with correct title', async ({ page }) => {
        await page.goto(serverUrl);
        await expect(page).toHaveTitle(/LectureVault — Recordings Dashboard/);
    });

    test('2. Empty state is displayed when no recordings exist', async ({ page }) => {
        await page.goto(serverUrl);
        const emptyState = page.locator('.empty-state');
        await expect(emptyState).toBeVisible();
    });

    test('3. Stats show zero values initially', async ({ page }) => {
        await page.goto(serverUrl);
        await expect(page.locator('#stat-total')).toHaveText('0');
        await expect(page.locator('#stat-new')).toHaveText('0');
        await expect(page.locator('#stat-seen')).toHaveText('0');
        await expect(page.locator('#stat-processed')).toHaveText('0');
    });

    test('4. Health endpoint returns 200', async ({ request }) => {
        const response = await request.get(`${serverUrl}/api/health`);
        expect(response.ok()).toBeTruthy();
        const json = await response.json();
        expect(json.status).toBe('ok');
        expect(json).toHaveProperty('timestamp');
    });

    test('5. Recordings API returns empty array initially', async ({ request }) => {
        const response = await request.get(`${serverUrl}/api/recordings`);
        expect(response.ok()).toBeTruthy();
        const json = await response.json();
        expect(json.recordings).toEqual([]);
        expect(json.stats.total).toBe(0);
    });
    
    test('7. Filter buttons exist and are clickable', async ({ page }) => {
        await page.goto(serverUrl);
        const filters = ['all', 'new', 'seen', 'processed'];
        for (const filter of filters) {
            const btn = page.locator(`.filter-btn[data-filter="${filter}"]`);
            await expect(btn).toBeVisible();
            await btn.click();
        }
    });
});

test.describe('Dashboard E2E Tests - With Data', () => {
    test.beforeAll(() => {
        dbManager.upsertRecording({
            collabId: 'collab-rec-1',
            title: 'Lecture 1: Introduction to Algorithms',
            createdAt: '2026-10-01T10:00:00Z',
            durationSeconds: 3600,
            playbackUrl: 'https://example.blackboard.com/collab/rec1'
        });
        dbManager.upsertRecording({
            collabId: 'collab-rec-2',
            title: 'Lecture 2: Data Structures',
            createdAt: '2026-10-03T10:00:00Z',
            durationSeconds: 5400,
            playbackUrl: 'https://example.blackboard.com/collab/rec2'
        });
        dbManager.updateStatus('collab-rec-2', 'seen');
    });

    test('6. After inserting test recordings via DB, the API returns them', async ({ request }) => {
        const response = await request.get(`${serverUrl}/api/recordings`);
        expect(response.ok()).toBeTruthy();
        const json = await response.json();
        expect(json.recordings.length).toBeGreaterThan(0);
        expect(json.stats.total).toBeGreaterThan(0);
    });

    test('8. After inserting records, recordings table renders with data', async ({ page }) => {
        await page.goto(serverUrl);
        
        // Empty state should be hidden
        const emptyState = page.locator('.empty-state');
        await expect(emptyState).not.toBeVisible();
        
        // Check for table rows (assuming tbody tr is used for recordings)
        // Wait for the table to populate, which should happen via fetch
        await page.waitForSelector('table tbody tr');
        
        const rows = page.locator('table tbody tr');
        const count = await rows.count();
        expect(count).toBeGreaterThan(0);
        
        // Stats should be updated
        const totalText = await page.locator('#stat-total').textContent();
        expect(Number(totalText)).toBeGreaterThan(0);
    });
});
