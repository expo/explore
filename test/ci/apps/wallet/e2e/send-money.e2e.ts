// The wallet app's e2e flow. Explore runs it on both revisions after setup signed the review account in;
// each app.screenshot is a frame the review compares, and a failing step keeps the frames before it.
import { expect, test } from "e2e";

test("send money to a contact", async ({ app, device, screen }) => {
  await device.openLink("explore-example-wallet://send/contacts");
  await expect(screen.getByTestId("contacts-list")).toBeVisible();
  await app.screenshot("contacts");

  await screen.getByText("Alex Rivera").tap();
  await expect(screen.getByTestId("send-amount-input")).toBeVisible();
  await screen.getByTestId("send-amount-input").fill("25");
  await app.screenshot("amount");

  await screen.getByTestId("send-amount-continue").tap();
  await expect(screen.getByTestId("send-confirm")).toBeVisible();
  await app.screenshot("review");
});
