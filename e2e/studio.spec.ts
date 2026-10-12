import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

test("opens Hello Automation and runs demo and production", async ({ page }) => {
  await page.goto("/workflow/wf_a01");
  await expect(page.getByRole("heading", { name: "Hello Automation is ready" })).toBeVisible();
  await expect(page.getByLabel("Workflow state")).toHaveText("Draft");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run demo" }).first().click();
  await expect(page.getByText("Succeeded · demo")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Demo execution")).toBeVisible();
  await page.getByRole("button", { name: "Open demo output" }).click();
  await expect(page.getByText("Hello, PulseFlow")).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/studio-demo.png", fullPage: false });

  await page.goto("/history");
  await page.getByRole("button", { name: "Compare" }).first().click();
  await expect(page.getByText("Added nodes:")).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/history-compare.png", fullPage: false });

  await page.goto("/settings");
  await expect(page.getByText(/Sleep, hibernate, sign-out, and power-off/)).toBeVisible();

  await page.goto("/templates");
  await expect(page.getByRole("button", { name: "Try demo" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Run live (needs setup)" }).first()).toBeDisabled();

  await page.goto("/workflow/wf_a01");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("production execution")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Run state")).toHaveText("Succeeded");
});
