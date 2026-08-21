// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator } from "@playwright/test";

export async function completeCatalogCheckout(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Review total" }).click();
  await expect(dialog.getByRole("region", { name: "Order preview" })).toBeVisible();
  await dialog.getByLabel(/^Accept Terms version /).check();
  await dialog.getByLabel(/^Accept AUP version /).check();
  await expect(dialog.getByLabel("Marketing communications consent (optional)"))
    .not.toBeChecked();
  await dialog.getByRole("button", { name: "Configure & order" }).click();
}
