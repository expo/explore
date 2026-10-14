import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Open the Annotation task list behind the Tools / Annotation header tabs.
 */
export async function openAnnotationChat(page: Page): Promise<Locator> {
  const expand = page.getByRole("button", { name: "Expand inspector", exact: true });
  if (await expand.isVisible()) await expand.click();
  const annotation = page.getByRole("tablist", { name: "Simulator panel section", exact: true })
    .getByRole("tab", { name: "Annotation", exact: true });
  if (await annotation.getAttribute("aria-selected") !== "true") await annotation.click();
  const chat = page.locator(".live-right-panel").getByRole("region", { name: "Annotations", exact: true });
  await expect(chat).toBeVisible();
  return chat;
}

