import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { chromium } from "@playwright/test";
const origin = "https://relay.example.test";
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(run) {
  const mf = new Miniflare({
    modules: true,
    script: await readFile("dist/server/index.js", "utf8"),
    compatibilityDate: "2026-01-01",
    d1Databases: ["DB"],
    r2Buckets: ["BUCKET"],
    bindings: {
      OWNER_EMAIL: "owner@example.test",
      APP_ORIGIN: origin,
      MACHINE_TOKEN_SHA256: sha("test-machine"),
    },
  });
  let browser;
  try {
    const db = await mf.getD1Database("DB");
    for (const file of (await readdir("drizzle"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.batch(
        (await readFile("drizzle/" + file, "utf8"))
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    const id = randomUUID();
    const created = await mf.dispatchFetch(origin + "/api/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer test-machine" },
      body: JSON.stringify({
        id,
        environment: "test-host",
        thread: "test-chat",
        label: "Synthetic UI test",
        delivery_hash: sha("test-delivery"),
      }),
    });
    assert.equal(created.status, 200);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (e) => failures.push(e.message));
    let failUpload = false;
    await page.route(origin + "/**", async (route) => {
      const request = route.request();
      if (failUpload && request.method() === "PUT") {
        failUpload = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Synthetic upload interruption. Tap Done to retry.",
          }),
        });
      }
      const response = await mf.dispatchFetch(request.url(), {
        method: request.method(),
        headers: {
          ...request.headers(),
          "oai-authenticated-user-id": "test-owner",
          "oai-authenticated-user-email": "owner@example.test",
        },
        body: request.postDataBuffer() || undefined,
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 2560;
        canvas.height = 1920;
        const c = canvas.getContext("2d");
        c.fillStyle = "#8cab64";
        c.fillRect(0, 0, 2560, 1920);
        c.fillStyle = "#152321";
        c.font = "180px sans-serif";
        c.fillText("Synthetic photo", 120, 1000);
        return canvas.captureStream(10);
      };
    });
    await page.goto(origin + "/s/" + id);
    await page
      .getByRole("button", { name: "Enable camera", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector("video").videoWidth > 0,
    );
    await run({
      page,
      db,
      mf,
      id,
      interrupt: () => {
        failUpload = true;
      },
    });
    assert.deepEqual(failures, []);
  } finally {
    await browser?.close();
    await mf.dispose();
  }
}
test("phone layout captures multiple JPEGs, removes a preview, sends Done", async () =>
  fixture(async ({ page, mf, id }) => {
    for (let i = 0; i < 3; i++) {
      await page
        .getByRole("button", { name: "Take photo", exact: true })
        .click();
      await page.locator("figure").nth(i).waitFor();
    }
    await page
      .getByRole("button", { name: "Remove photo 2", exact: true })
      .click();
    assert.equal(await page.locator("figure").count(), 2);
    await page
      .getByRole("button", { name: "Done · send 2 photos", exact: true })
      .click();
    await page.locator("#success").waitFor();
    const state = await (
      await mf.dispatchFetch(origin + "/api/sessions/" + id, {
        headers: {
          Authorization: "Bearer test-delivery",
          "X-Muninn-Environment": "test-host",
          "X-Muninn-Thread": "test-chat",
        },
      })
    ).json();
    assert.equal(state.state, "done");
    assert.equal(state.photos.length, 2);
    const image = await (
      await mf.dispatchFetch(
        origin + `/api/sessions/${id}/photos/${state.photos[0].id}`,
        {
          headers: {
            Authorization: "Bearer test-delivery",
            "X-Muninn-Environment": "test-host",
            "X-Muninn-Thread": "test-chat",
          },
        },
      )
    ).arrayBuffer();
    const dimensions = await page.evaluate(
      async (bytes) => {
        const image = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
        );
        return [image.width, image.height];
      },
      Array.from(new Uint8Array(image)),
    );
    assert.deepEqual(dimensions, [2000, 1500]);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }));
test("interrupted send keeps selection fixed and retries the same session", async () =>
  fixture(async ({ page, interrupt }) => {
    await page.getByRole("button", { name: "Take photo", exact: true }).click();
    await page.locator("figure").waitFor();
    interrupt();
    await page
      .getByRole("button", { name: "Done · send 1 photo", exact: true })
      .click();
    await page.locator("#status.error").waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Remove photo 1", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Enable camera", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Done · send 1 photo", exact: true })
      .click();
    await page.locator("#success").waitFor();
  }));
