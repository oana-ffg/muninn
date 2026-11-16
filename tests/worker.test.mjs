import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
let mf, db, bucket;
const origin = "https://relay.example.test",
  sha = (b) => createHash("sha256").update(b).digest("hex");
const appToken = "test-only-machine",
  deliveryToken = "test-only-session";
const owner = {
  "oai-authenticated-user-id": "owner-id",
  "oai-authenticated-user-email": "owner@example.test",
};
const bytes = Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]);
const machine = { Authorization: `Bearer ${appToken}` };
const delivery = {
  Authorization: `Bearer ${deliveryToken}`,
  "X-Muninn-Environment": "machine-a",
  "X-Muninn-Thread": "chat-a",
};
async function req(path, method = "GET", headers = {}, body) {
  return mf.dispatchFetch(origin + path, { method, headers, body });
}
async function create() {
  const id = randomUUID();
  const r = await req(
    "/api/sessions",
    "POST",
    machine,
    JSON.stringify({
      id,
      environment: "machine-a",
      thread: "chat-a",
      label: "A synthetic test chat",
      delivery_hash: sha(deliveryToken),
    }),
  );
  assert.equal(r.status, 200, await r.clone().text());
  return id;
}
async function upload(id, photo = randomUUID(), content = bytes) {
  const r = await req(
    `/api/sessions/${id}/photos/${photo}`,
    "PUT",
    {
      ...owner,
      "Content-Type": "image/jpeg",
      "X-Content-SHA256": sha(content),
    },
    content,
  );
  return { r, photo };
}
before(async () => {
  mf = new Miniflare({
    modules: true,
    script: await readFile("dist/server/index.js", "utf8"),
    compatibilityDate: "2026-01-01",
    d1Databases: ["DB"],
    r2Buckets: ["BUCKET"],
    bindings: {
      OWNER_EMAIL: "owner@example.test",
      APP_ORIGIN: origin,
      MACHINE_TOKEN_SHA256: sha(appToken),
    },
  });
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("BUCKET");
  for (const file of (await readdir("drizzle"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const statements = (await readFile("drizzle/" + file, "utf8"))
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
});
after(async () => mf?.dispose());
test("anonymous and wrong-owner requests fail closed", async () => {
  assert.equal((await req("/")).status, 403);
  assert.equal(
    (
      await req("/", "GET", {
        "oai-authenticated-user-id": "other",
        "oai-authenticated-user-email": "other@example.test",
      })
    ).status,
    403,
  );
  assert.equal((await req("/api/sessions", "POST", {}, "{}")).status, 401);
});
test("two photos, Done, scoped delivery, exact ack, R2 deletion, retry", async () => {
  const id = await create(),
    a = await upload(id),
    b = await upload(id);
  assert.equal(a.r.status, 200);
  assert.equal(b.r.status, 200);
  assert.equal(
    (await req(`/api/sessions/${id}/done`, "POST", owner)).status,
    200,
  );
  assert.equal(
    (
      await req(`/api/sessions/${id}`, "GET", {
        ...delivery,
        "X-Muninn-Thread": "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await req(`/api/sessions/${id}`, "GET", {
        ...delivery,
        Authorization: "Bearer wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (await req(`/api/sessions/${id}/photos/${a.photo}`, "GET", owner)).status,
    403,
  );
  assert.deepEqual(
    Buffer.from(
      await (
        await req(`/api/sessions/${id}/photos/${a.photo}`, "GET", delivery)
      ).arrayBuffer(),
    ),
    bytes,
  );
  assert.equal(
    (
      await req(
        `/api/sessions/${id}/ack`,
        "POST",
        delivery,
        JSON.stringify({ photos: [] }),
      )
    ).status,
    422,
  );
  const ack = JSON.stringify({
    photos: [a, b].map((p) => ({ id: p.photo, sha256: sha(bytes) })),
  });
  assert.equal(
    (await req(`/api/sessions/${id}/ack`, "POST", delivery, ack)).status,
    200,
  );
  assert.equal(
    (await bucket.list({ prefix: `sessions/${id}/` })).objects.length,
    0,
  );
  assert.equal(
    (await req(`/api/sessions/${id}/ack`, "POST", delivery, ack)).status,
    200,
  );
  assert.equal((await upload(id)).r.status, 410);
});
test("expired URLs refuse upload and cleanup removes expired bytes", async () => {
  const id = await create();
  assert.equal((await upload(id)).r.status, 200);
  await db
    .prepare("UPDATE sessions SET expires_at=0 WHERE id=?")
    .bind(id)
    .run();
  assert.equal((await upload(id)).r.status, 410);
  await db.prepare("UPDATE sessions SET purge_at=0 WHERE id=?").bind(id).run();
  const r = await req("/api/cleanup", "POST", machine, "{}");
  assert.equal(r.status, 200);
  assert.equal(
    (await bucket.list({ prefix: `sessions/${id}/` })).objects.length,
    0,
  );
  assert.equal((await req(`/api/sessions/${id}`, "GET", delivery)).status, 404);
});
test("idempotent upload, conflicting reuse, and write origin checks", async () => {
  const id = await create(),
    photo = randomUUID();
  assert.equal((await upload(id, photo)).r.status, 200);
  assert.equal((await upload(id, photo)).r.status, 200);
  assert.equal(
    (await upload(id, photo, Buffer.from([255, 216, 255, 12, 255, 217]))).r
      .status,
    409,
  );
  assert.equal(
    (
      await req(`/api/sessions/${id}/done`, "POST", {
        ...owner,
        Origin: "https://other.example.test",
      })
    ).status,
    403,
  );
});
test("empty session cannot finish; machine cannot upload or finish", async () => {
  const id = await create();
  assert.equal(
    (await req(`/api/sessions/${id}/done`, "POST", owner)).status,
    409,
  );
  assert.equal(
    (await req(`/api/sessions/${id}/done`, "POST", delivery)).status,
    403,
  );
  assert.equal(
    (
      await req(
        `/api/sessions/${id}/photos/${randomUUID()}`,
        "PUT",
        delivery,
        bytes,
      )
    ).status,
    403,
  );
});
test("concurrent uploads respect photo cap, Done excludes pending reservations", async () => {
  const id = await create();
  const results = await Promise.all(
    Array.from({ length: 23 }, () => upload(id)),
  );
  assert.equal(results.filter((r) => r.r.status === 200).length, 20);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM photos WHERE session=?")
        .bind(id)
        .first()
    ).n,
    20,
  );
  const pending = await create();
  await db
    .prepare(
      "INSERT INTO photos(session,id,sha256,size,position) VALUES(?,?,?,?,?)",
    )
    .bind(pending, randomUUID(), sha(bytes), bytes.length, 0)
    .run();
  assert.equal(
    (await req(`/api/sessions/${pending}/done`, "POST", owner)).status,
    409,
  );
});
