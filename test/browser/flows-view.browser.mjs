import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { BlobReader, BlobWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { startReportViewer } from "../ci/lib/report-viewer.mjs";

// The recorded Meow review with one e2e flow added: "send money to a contact" passed on base with three frames and
// failed on head at step 8 with two, so the Flows view shows a compared pair, a base-only frame and a stopped side.
const REPORT = new URL("../fixtures/example-review-artifact.zip", import.meta.url);
const FLOW = JSON.parse(await readFile(new URL("../fixtures/flows/public-review-flow.json", import.meta.url), "utf8"));

async function reportWithFlow(flowsFailure) {
  const reader = new ZipReader(new BlobReader(new Blob([await readFile(REPORT)])));
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  for (const entry of await reader.getEntries()) {
    const bytes = await entry.getData(new Uint8ArrayWriter());
    if (entry.filename !== "review.json") { await writer.add(entry.filename, new Uint8ArrayReader(bytes), { level: 0 }); continue; }
    const report = JSON.parse(new TextDecoder().decode(bytes));
    report.review = { ...report.review, flows: [FLOW], ...(flowsFailure ? { flowsFailure } : {}) };
    await writer.add("review.json", new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(report))), { level: 6 });
  }
  await reader.close();
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

async function openReport(t, bytes, viewport = { width: 1440, height: 900 }) {
  const cacheDir = await mkdtemp(join(tmpdir(), "explore-flows-viewer-"));
  const { server, url } = await startReportViewer({ bytes, port: "free", watch: false, cacheDir });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { page, url, errors };
}

test("the Flows view shows each flow's outcome per side, its frames and steps, and opens a frame in the inspector", async t => {
  const { page, url, errors } = await openReport(t, await reportWithFlow());
  await page.goto(`${url}#/flows`);
  const card = page.getByRole("region", { name: "send money to a contact" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("flows/send-money.e2e.ts");
  await expect(card.locator(".flow-outcome", { hasText: "After" })).toContainText("failed at step 8");
  await expect(card.locator(".flow-outcome", { hasText: "Before" })).toContainText("passed");
  await expect(card.locator(".flow-failure")).toContainText('expect.toBeVisible getByTestId("send-confirm")');
  // Both sides took contacts and amount; only base reached review.
  await expect(card.locator(".flow-frame-caption", { hasText: "contacts" })).toBeVisible();
  const contacts = card.locator(".flow-frame", { has: page.locator(".flow-frame-caption", { hasText: "contacts" }) });
  await expect(contacts).toHaveAttribute("data-side", "head");
  await expect(contacts.locator(".flow-frame-flip")).toHaveText("After");
  await contacts.locator(".flow-frame-flip").click();
  await expect(contacts).toHaveAttribute("data-side", "base");
  await expect(contacts.locator(".flow-frame-flip")).toHaveText("Before");
  await expect(contacts.locator(".flow-frame-image")).toHaveAttribute("alt", /Before$/);
  await contacts.locator(".flow-frame-flip").click();
  await expect(contacts).toHaveAttribute("data-side", "head");
  const review = card.locator(".flow-frame", { has: page.locator(".flow-frame-caption", { hasText: "review" }) });
  await expect(review.locator(".flow-frame-missing")).toContainText("Not reached");
  await review.locator(".flow-frame-flip").click();
  await expect(review.locator(".flow-frame-image")).toBeVisible();
  await expect(card).toContainText("Not reached after");
  await expect(card.locator("img")).toHaveCount(3, "one face per frame: contacts and amount on After, review flipped to Before");
  for (const image of await card.locator("img").all()) {
    expect(await image.evaluate(element => element.naturalWidth), "every frame decodes from the report's assets").toBeGreaterThan(0);
  }
  const steps = card.locator("ol.flow-steps").first().locator("li");
  await expect(steps).toHaveCount(8);
  await expect(steps.nth(7)).toHaveClass(/failed/);
  // A frame opens in the inspector, beside the flow.
  await card.locator(".flow-frame-button").first().click();
  await expect(page).toHaveURL(/#\/flows\/flow:send-money/);
  await expect(page.getByRole("complementary", { name: "Inspector panel" })).toContainText("send money to a contact › contacts");
  // The inspector explains the frame by its flow, not by a route transition: the step, the steps around it, the e2e source.
  const inspector = page.getByRole("complementary", { name: "Inspector panel" });
  await expect(inspector.locator(".flow-section")).toContainText("Frame from step 3 of 8");
  await expect(inspector.locator(".transition-section")).toHaveCount(0);
  await expect(inspector.locator(".flow-section-step-row").nth(2)).toHaveClass(/current/);
  await expect(inspector.locator(".flow-section-step-row").nth(2).locator("a")).toHaveAttribute("href", /github\.com\/expo\/explore-playground\/blob\/[0-9a-f]{40}\/flows\/send-money\.e2e\.ts#L6$/);
  await expect(card.locator(".flow-file a")).toHaveAttribute("href", /send-money\.e2e\.ts#L3$/);
  assert.deepEqual(errors, []);
});

test("flow frames leave the Screens tree while the Changes count keeps the compared frames", async t => {
  const { page, url } = await openReport(t, await reportWithFlow());
  await page.goto(`${url}#/screens`);
  await expect(page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Screens", exact: true })).toBeVisible();
  await expect(page.locator(".screens-view, main").first()).not.toContainText("send money to a contact");
  await expect(page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Flows", exact: true })).toBeVisible();
});

test("a side whose flows did not run is announced on the Flows view, and the tab stays reachable", async t => {
  const failure = { head: { code: "FLOWS_NOT_RUN", message: "Error: Cannot find module 'e2e/runner'" } };
  const { page, url } = await openReport(t, await reportWithFlow(failure));
  await page.goto(`${url}#/flows`);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The flows did not run");
  await expect(alert).toContainText("FLOWS_NOT_RUN");
  await expect(alert).toContainText("Cannot find module 'e2e/runner'");
  await expect(page.getByRole("region", { name: "send money to a contact" })).toBeVisible();
});

test("on a phone the Flows tab lists the flow with its frames as a filmstrip", async t => {
  const { page, url } = await openReport(t, await reportWithFlow(), { width: 390, height: 844 });
  await page.goto(`${url}#/flows`);
  const card = page.getByRole("region", { name: "send money to a contact" });
  await expect(card).toBeVisible();
  const strip = card.locator(".flow-filmstrip");
  const widths = await strip.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  assert.ok(widths.scroll > widths.client, `the filmstrip scrolls sideways (${widths.scroll} > ${widths.client})`);
  for (const button of await card.getByRole("button").all()) {
    const box = await button.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, `touch target ${JSON.stringify(box)}`);
  }
});
