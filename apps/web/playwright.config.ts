import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = 3101;
const WEB_PORT = 4173;
const chromePath = process.env.PLAYWRIGHT_CHROME_PATH;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...(chromePath ? { launchOptions: { executablePath: chromePath } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Real server with the test-only deal harness (refuses to start unless NODE_ENV=test).
      command: 'npx tsx ../server/src/index.ts',
      url: `http://localhost:${SERVER_PORT}/health`,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        ZHOL_TEST_HARNESS: '1',
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
        ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
        DATABASE_PATH: `./test-results/e2e-${Date.now()}.db`,
        LOG_LEVEL: 'silent',
      },
    },
    {
      // Production build served by vite preview (SPA fallback serves /room/:code directly).
      command: 'npx vite build && npx vite preview --port 4173 --strictPort',
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { VITE_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}` },
      timeout: 120_000,
    },
  ],
});
