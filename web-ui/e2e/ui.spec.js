import { expect, test } from "@playwright/test";

test("renders the shared VanJS shell when the backend is unavailable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ponlet" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create invite|招待を作成/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Choose file|ファイルを選択/ })).toBeVisible();
});
