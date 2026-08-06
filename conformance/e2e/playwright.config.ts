// SPDX-License-Identifier: Apache-2.0

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  // The laboratory stories deliberately share one synthetic ledger and staff
  // account. Running money-mutating files concurrently would make one story's
  // Credit consumption alter another story's Chargeback expectations.
  workers: 1,
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.OSS_E2E_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
