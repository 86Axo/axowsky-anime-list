import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests run against the real thing: the built site served by
 * `wrangler pages dev`, with Pages Functions and a local D1 database.
 * The values below are throwaway test values, never used in production.
 */
export const E2E = {
  port: 8788,
  sessionSecret: 'e2e-only-session-secret-not-used-anywhere-else',
  adminGithubId: '177529564',
};

const bindings = [
  `SESSION_SECRET=${E2E.sessionSecret}`,
  'GITHUB_CLIENT_ID=e2e-client-id',
  'GITHUB_CLIENT_SECRET=e2e-client-secret',
  // Tests must not depend on a third-party API being up.
  'CHARACTER_LOOKUP=off',
]
  .map((b) => `-b ${b}`)
  .join(' ');

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${E2E.port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npx wrangler d1 migrations apply DB --local && npx wrangler pages dev dist --port ${E2E.port} ${bindings}`,
    url: `http://localhost:${E2E.port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { BAKE_ANNOTATIONS: '0' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /smoke\.spec\.ts/ },
  ],
});
