import { defineConfig } from "@playwright/test";

/**
 * TaxWise Desktop end-to-end tests (§14), run in CI where the Electron binary is installed:
 *   npm run e2e
 * They never touch the live WhatsApp: the app serves e2e/fixtures/whatsapp.html as
 * https://web.whatsapp.com/ (TAXWISE_E2E_WHATSAPP_FIXTURES, development builds only).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
});
