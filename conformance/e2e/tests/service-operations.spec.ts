// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import pg from "pg";

test.describe.configure({ retries: 0 });

test("customer reuses a lost-response operation intent and Staff sees the same bilingual timeline", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fixturePath = process.env.OSS_E2E_SERVICE_OPERATION_STATE_FILE;
  if (fixturePath) {
    await runPreparedFixtureJourney(page, fixturePath);
    return;
  }
  const unique = crypto.randomUUID();
  const email = `service-operation-browser-${unique}@example.invalid`;
  const password = `Synthetic-${unique}-ServiceOperation!`;
  const clientName = `Service Operation Browser ${unique.slice(0, 8)}`;
  const staffEmail =
    process.env.OSS_E2E_STAFF_EMAIL ?? "stage-a-browser-admin@example.invalid";
  const staffPassword =
    process.env.OSS_E2E_STAFF_PASSWORD ?? "Synthetic-Stage-A-Browser-Admin-Only!";

  await page.goto("/");
  await page.getByPlaceholder("Client account name").fill(clientName);
  await page.getByPlaceholder("Email").first().fill(email);
  await page.getByPlaceholder("Password (12+ characters)").fill(password);
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText(/Account created/)).toBeVisible();

  await page.getByPlaceholder("Email").last().fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const mailboxButton = page.getByRole("button", { name: "Open my Mock Provider mailbox" });
  const verificationLink = page.getByRole("link", { name: "Use one-time verification link" });
  for (let attempt = 0; attempt < 20 && (await verificationLink.count()) === 0; attempt += 1) {
    await mailboxButton.click();
    await page.waitForTimeout(250);
  }
  await expect(verificationLink).toBeVisible();
  await verificationLink.click();
  await expect(page.getByText(/Email verified — account is eligible/)).toBeVisible();

  const product = page.locator("article").filter({ hasText: "HKBGP VPS" }).first();
  await product.getByRole("button", { name: /monthly/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Configure & order" }).click();
  const journey = page.locator("section.order-panel").filter({ hasText: "Live customer journey" });
  await journey.getByLabel("Payment method", { exact: true }).selectOption("usdt");
  await journey.getByRole("button", { name: "Start mock payment" }).click();
  await expect(journey.getByText("active", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.reload();
  const history = page.getByTestId("customer-business-history");
  const serviceRow = history.getByTestId("history-service").filter({ hasText: "HKBGP VPS" }).first();
  await expect(serviceRow).toBeVisible();
  const accountId = ((await history.getByTestId("history-account").locator(".mono").textContent()) ?? "").trim();
  expect(accountId).toMatch(/^[0-9a-f-]{36}$/);
  await serviceRow.click();
  const customerPanel = page.getByTestId("customer-service-operations");
  await expect(customerPanel.getByRole("heading", { name: "Daily resource operations" })).toBeVisible();

  await page.getByRole("button", { name: "简体中文" }).click();
  await expect(customerPanel.getByRole("heading", { name: "日常资源操作" })).toBeVisible();
  await expect(customerPanel).toContainText("电源状态独立于计费暂停、取消和终止。");
  const stopButton = customerPanel.getByRole("button", { name: "停止", exact: true });
  await expect(stopButton).toBeEnabled();

  const operationPattern = "**/api/v1/services/*/operations";
  let firstIdempotencyKey = "";
  let committedRequestId = "";
  const loseCommittedResponse = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const requestBody = route.request().postDataJSON() as { idempotencyKey: string };
    firstIdempotencyKey = requestBody.idempotencyKey;
    const response = await route.fetch();
    const responseBody = (await response.json()) as { requestId: string; replayed: boolean };
    expect(response.status(), JSON.stringify(responseBody)).toBe(201);
    expect(responseBody.replayed).toBe(false);
    committedRequestId = responseBody.requestId;
    await route.abort("connectionfailed");
  };
  await page.route(operationPattern, loseCommittedResponse);
  await stopButton.click();
  await expect(stopButton).toBeEnabled();
  expect(firstIdempotencyKey).toMatch(/^stop-/);
  expect(committedRequestId).toMatch(/^[0-9a-f-]{36}$/);
  await page.unroute(operationPattern, loseCommittedResponse);

  const replayResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/operations"),
  );
  await stopButton.click();
  const replayResponse = await replayResponsePromise;
  const replayRequest = replayResponse.request().postDataJSON() as { idempotencyKey: string };
  const replayBody = (await replayResponse.json()) as {
    requestId: string;
    replayed: boolean;
  };
  expect(replayResponse.status(), JSON.stringify(replayBody)).toBe(200);
  expect(replayBody.replayed).toBe(true);
  expect(replayBody.requestId).toBe(committedRequestId);
  expect(replayRequest.idempotencyKey).toBe(firstIdempotencyKey);

  await expect.poll(
    async () => page.evaluate(async (requestId) => {
      const detail = new URL(window.location.href).searchParams.get("service");
      const response = await fetch(`/api/v1/services/${detail}/operations`);
      if (!response.ok) return null;
      const body = await response.json() as {
        items: Array<{ requestId: string; status: string }>;
      };
      return body.items.find((item) => item.requestId === requestId)?.status ?? null;
    }, committedRequestId),
    { timeout: 30_000 },
  ).toBe("succeeded");
  await customerPanel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(customerPanel).toContainText("资源 已停止");
  await expect(customerPanel.getByTestId("service-operation-timeline")).toContainText(
    "停止 · 成功 · 自动",
  );
  await expect(customerPanel.getByTestId("service-operation-timeline").locator(".manual-item"))
    .toHaveCount(1);

  const coreDatabaseUrl = process.env.DATABASE_URL;
  const providerDatabaseUrl = process.env.PROVIDER_DATABASE_URL;
  expect(coreDatabaseUrl).toBeTruthy();
  expect(providerDatabaseUrl).toBeTruthy();
  const corePool = new pg.Pool({ connectionString: coreDatabaseUrl });
  const providerPool = new pg.Pool({ connectionString: providerDatabaseUrl });
  try {
    const operation = await corePool.query<{ id: string }>(
      `SELECT id::text FROM provider_operations
        WHERE subject_type = 'service_resource_operation' AND subject_id = $1`,
      [committedRequestId],
    );
    assertSingleRow(operation.rowCount);
    const providerCalls = await providerPool.query<{ create_calls: number }>(
      "SELECT create_calls FROM mock_contract_operations WHERE operation_id = $1",
      [operation.rows[0]!.id],
    );
    assertSingleRow(providerCalls.rowCount);
    expect(providerCalls.rows[0]!.create_calls).toBe(1);
  } finally {
    await Promise.all([corePool.end(), providerPool.end()]);
  }

  await page.getByRole("button", { name: "English" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/admin");
  await page.getByPlaceholder("Staff email").fill(staffEmail);
  await page.getByPlaceholder("Staff password").fill(staffPassword);
  await page.getByRole("button", { name: "Sign in to Staff workspace" }).click();
  const account360 = page.getByTestId("client-account-360");
  await account360.getByLabel("Search Client Accounts").fill(accountId);
  await account360.getByRole("button", { name: "Search accounts" }).click();
  await account360
    .getByTestId("account360-search-results")
    .getByRole("button", { name: new RegExp(clientName) })
    .click();
  const staffService = account360
    .getByTestId("account360-services")
    .locator("details")
    .filter({ hasText: "HKBGP VPS" })
    .first();
  await staffService.locator("summary").click();
  const staffPanel = staffService.getByTestId("staff-service-operations");
  await expect(staffPanel).toContainText(committedRequestId);
  await expect(staffPanel).toContainText("Stop · succeeded · automatic");
});

function assertSingleRow(rowCount: number | null): asserts rowCount is 1 {
  expect(rowCount).toBe(1);
}

type PreparedActor = Readonly<{
  token: string;
  accountId: string | null;
}>;

type PreparedFixture = Readonly<{
  account: { id: string; name: string };
  owner: PreparedActor;
  staff: PreparedActor;
  staffEmail: string;
  staffPassword: string;
  fixture: { serviceId: string };
  manualFixture: { serviceId: string };
  manualRequest: { requestId: string };
  productName: string;
}>;

async function processPreparedOperation(requestId: string): Promise<void> {
  if (process.env.OSS_E2E_SELF_PUMP_SERVICE_OPERATIONS !== "1") return;
  const databaseUrl = process.env.SERVICE_OPERATION_WORKER_DATABASE_URL;
  const providerUrl = process.env.MOCK_PROVISIONING_PROVIDER_URL;
  const providerToken = process.env.MOCK_PROVIDER_PLATFORM_TOKEN;
  expect(databaseUrl).toBeTruthy();
  expect(providerUrl).toBeTruthy();
  expect(providerToken).toBeTruthy();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const workerId = `service-operation-browser-${process.pid}`;
    const claimed = await pool.query<{
      id: string;
      job_type: string;
      unique_key: string;
      payload: Record<string, string>;
      payload_snapshot: string;
      attempts: number;
      locked_at_epoch: string;
      locked_by: string;
    }>(
      `UPDATE durable_jobs job
          SET status = 'running', attempts = job.attempts + 1,
              locked_at = pg_catalog.clock_timestamp(), locked_by = $1,
              updated_at = pg_catalog.clock_timestamp()
        WHERE job.job_type = 'service.operation.start'
          AND job.payload->>'requestId' = $2
          AND job.status = 'pending'
        RETURNING job.id, job.job_type, job.unique_key, job.payload,
                  job.payload::text AS payload_snapshot, job.attempts,
                  EXTRACT(epoch FROM job.locked_at)::numeric::text AS locked_at_epoch,
                  job.locked_by`,
      [workerId, requestId],
    );
    if (claimed.rowCount === 0) {
      // Product CI also runs the real Worker. If it won the SKIP LOCKED race,
      // observe its immutable terminal fact instead of treating ownership by
      // the real process as a browser failure.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const terminal = await pool.query<{ status: string }>(
          `SELECT result.status
             FROM service_resource_operation_result_facts result
            WHERE result.request_id = $1
              AND result.status IN ('succeeded', 'failed', 'manual')
            ORDER BY result.revision DESC
            LIMIT 1`,
          [requestId],
        );
        if (terminal.rowCount === 1) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Real Worker claimed ${requestId} but did not persist a terminal fact`);
    }
    assertSingleRow(claimed.rowCount);
    const worker = await import(
      new URL("../../../apps/worker/dist/service-operations.js", import.meta.url).href
    ) as {
      processServiceOperationStart(
        selectedPool: pg.Pool,
        job: typeof claimed.rows[number],
        runtime: {
          workerId: string;
          providerUrl: string;
          providerToken: string;
          providerTimeoutMs: number;
          scenario: "normal";
          reconcileBaseDelaySeconds: number;
          reconcileMaxAttempts: number;
          staleLockSeconds: number;
        },
      ): Promise<void>;
    };
    await worker.processServiceOperationStart(pool, claimed.rows[0]!, {
      workerId,
      providerUrl: providerUrl!,
      providerToken: providerToken!,
      providerTimeoutMs: 2_000,
      scenario: "normal",
      reconcileBaseDelaySeconds: 0,
      reconcileMaxAttempts: 3,
      staleLockSeconds: 2,
    });
  } finally {
    await pool.end();
  }
}

async function runPreparedFixtureJourney(
  page: Page,
  fixturePath: string,
): Promise<void> {
  const prepared = JSON.parse(await readFile(fixturePath, "utf8")) as PreparedFixture;
  const baseURL = process.env.OSS_E2E_URL ?? "http://127.0.0.1:5173";
  await page.context().addCookies([{ name: "oss_session", value: prepared.owner.token, url: baseURL }]);
  await page.goto(`/customer?service=${prepared.fixture.serviceId}`);
  const customerPanel = page.getByTestId("customer-service-operations");
  await expect(customerPanel.getByRole("heading", { name: "Daily resource operations" })).toBeVisible();

  await page.getByRole("button", { name: "简体中文" }).click();
  await expect(customerPanel.getByRole("heading", { name: "日常资源操作" })).toBeVisible();
  await expect(customerPanel).toContainText("电源状态独立于计费暂停、取消和终止。");
  const stopButton = customerPanel.getByRole("button", { name: "停止", exact: true });
  await expect(stopButton).toBeEnabled();

  const operationPattern = "**/api/v1/services/*/operations";
  let firstIdempotencyKey = "";
  let committedRequestId = "";
  const loseCommittedResponse = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const requestBody = route.request().postDataJSON() as { idempotencyKey: string };
    firstIdempotencyKey = requestBody.idempotencyKey;
    const response = await route.fetch();
    const responseBody = (await response.json()) as { requestId: string; replayed: boolean };
    expect(response.status(), JSON.stringify(responseBody)).toBe(201);
    expect(responseBody.replayed).toBe(false);
    committedRequestId = responseBody.requestId;
    await route.abort("connectionfailed");
  };
  await page.route(operationPattern, loseCommittedResponse);
  await stopButton.click();
  await expect(stopButton).toBeEnabled();
  expect(firstIdempotencyKey).toMatch(/^stop-/);
  expect(committedRequestId).toMatch(/^[0-9a-f-]{36}$/);
  await page.unroute(operationPattern, loseCommittedResponse);

  const replayResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/operations"),
  );
  await stopButton.click();
  const replayResponse = await replayResponsePromise;
  const replayRequest = replayResponse.request().postDataJSON() as { idempotencyKey: string };
  const replayBody = await replayResponse.json() as { requestId: string; replayed: boolean };
  expect(replayResponse.status(), JSON.stringify(replayBody)).toBe(200);
  expect(replayBody).toMatchObject({ requestId: committedRequestId, replayed: true });
  expect(replayRequest.idempotencyKey).toBe(firstIdempotencyKey);

  await processPreparedOperation(committedRequestId);
  await expect.poll(
    async () => page.evaluate(async ({ serviceId, requestId }) => {
      const response = await fetch(`/api/v1/services/${serviceId}/operations`);
      if (!response.ok) return null;
      const body = await response.json() as { items: Array<{ requestId: string; status: string }> };
      return body.items.find((item) => item.requestId === requestId)?.status ?? null;
    }, { serviceId: prepared.fixture.serviceId, requestId: committedRequestId }),
    { timeout: 30_000 },
  ).toBe("succeeded");
  await customerPanel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(customerPanel).toContainText("资源 已停止");
  await expect(customerPanel.getByTestId("service-operation-timeline")).toContainText(
    "停止 · 成功 · 自动",
  );

  const coreDatabaseUrl = process.env.DATABASE_URL;
  const providerDatabaseUrl = process.env.PROVIDER_DATABASE_URL;
  expect(coreDatabaseUrl).toBeTruthy();
  expect(providerDatabaseUrl).toBeTruthy();
  const corePool = new pg.Pool({ connectionString: coreDatabaseUrl });
  const providerPool = new pg.Pool({ connectionString: providerDatabaseUrl });
  try {
    const operation = await corePool.query<{ id: string }>(
      `SELECT id::text FROM provider_operations
        WHERE subject_type = 'service_resource_operation' AND subject_id = $1`,
      [committedRequestId],
    );
    assertSingleRow(operation.rowCount);
    const providerCalls = await providerPool.query<{ create_calls: number }>(
      "SELECT create_calls FROM mock_contract_operations WHERE operation_id = $1",
      [operation.rows[0]!.id],
    );
    assertSingleRow(providerCalls.rowCount);
    expect(providerCalls.rows[0]!.create_calls).toBe(1);
  } finally {
    await Promise.all([corePool.end(), providerPool.end()]);
  }

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByPlaceholder("Email").last().fill(prepared.staffEmail);
  await page.getByPlaceholder("Password", { exact: true }).fill(prepared.staffPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  const queue = page.getByTestId("admin-service-operations-queue");
  await expect(queue).toBeVisible();
  await expect(page.getByTestId("client-account-360")).toHaveCount(0);
  const manualItem = queue
    .getByTestId("admin-service-operation-item")
    .filter({ hasText: prepared.manualRequest.requestId });
  await expect(manualItem).toContainText("stop · manual");
  await queue.getByLabel("Reauthentication password").fill(prepared.staffPassword);
  await queue.getByLabel("Completion reason").fill("Verified queue-only Staff manual completion");
  await manualItem.getByRole("button", { name: "Complete manual operation" }).click();
  await expect(queue).not.toContainText(prepared.manualRequest.requestId);
  const completed = await page.evaluate(async ({ serviceId, requestId }) => {
    const response = await fetch(`/api/v1/admin/service-operations?status=all`);
    const body = await response.json() as { items: Array<{ requestId: string; status: string; serviceId: string }> };
    return body.items.find((item) => item.requestId === requestId && item.serviceId === serviceId)?.status;
  }, { serviceId: prepared.manualFixture.serviceId, requestId: prepared.manualRequest.requestId });
  expect(completed).toBe("succeeded");
}
