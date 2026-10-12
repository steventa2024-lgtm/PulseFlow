import { expect, test } from "@playwright/test";

test("opens Hello Automation and runs it", async ({ page }) => {
  await page.goto("/workflow/wf_a01");
  await expect(page.getByRole("heading", { name: "Hello Automation is ready" })).toBeVisible();
  await page.getByRole("button", { name: "Run demo" }).click();
  await expect(page.getByText("succeeded").first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Open demo output" }).click();
  await expect(page.getByText("Hello, PulseFlow")).toBeVisible();
});
