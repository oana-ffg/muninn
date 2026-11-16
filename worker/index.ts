declare const PAGE_HTML: string;
declare const CLIENT_JS: string;
interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  OWNER_EMAIL: string;
  APP_ORIGIN: string;
  MACHINE_TOKEN_SHA256: string;
}
interface Session {
  id: string;
  environment: string;
  thread: string;
  label: string;
  delivery_hash: string;
  state: string;
  created_at: number;
  expires_at: number;
  purge_at: number;
}
interface Photo {
  session: string;
  id: string;
  sha256: string;
  size: number;
  ready: number;
  position: number;
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_PHOTO = 8 * 1024 * 1024,
  MAX_PHOTOS = 20;
class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function requireThat(ok: unknown, status: number, message: string): asserts ok {
  if (!ok) throw new Problem(status, message);
}
async function digest(bytes: BufferSource) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
async function tokenHash(request: Request) {
  const value = request.headers.get("Authorization");
  requireThat(
    value && value.startsWith("Bearer "),
    401,
    "Machine credential required.",
  );
  return digest(new TextEncoder().encode(value.slice(7)));
}
function context(request: Request, s: Session) {
  requireThat(
    request.headers.get("X-Muninn-Environment") === s.environment &&
      request.headers.get("X-Muninn-Thread") === s.thread,
    403,
    "This session belongs to a different chat.",
  );
}
function owner(request: Request, env: Env) {
  requireThat(
    request.headers.get("oai-authenticated-user-id") &&
      request.headers.get("oai-authenticated-user-email")?.toLowerCase() ===
        env.OWNER_EMAIL.toLowerCase(),
    403,
    "Sign in with the Site owner account.",
  );
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function body(request: Request) {
  requireThat(
    Number(request.headers.get("Content-Length") || 0) <= 4096,
    413,
    "Request is too large.",
  );
  const raw = await limitedBytes(request, 4096);
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Problem(400, "Invalid JSON.");
  }
}
async function limitedBytes(request: Request, limit: number) {
  const reader = request.body?.getReader();
  requireThat(reader, 400, "Request body required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Problem(413, "Photo or request is too large.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}
const key = (session: string, id: string) => `sessions/${session}/${id}.jpg`;
async function list(env: Env, id: string) {
  return (
    await env.DB.prepare(
      "SELECT * FROM photos WHERE session=? ORDER BY position,id",
    )
      .bind(id)
      .all<Photo>()
  ).results;
}
async function session(env: Env, id: string) {
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE id=?")
    .bind(id)
    .first<Session>();
  requireThat(s, 404, "Session not found.");
  requireThat(
    s.purge_at > Math.floor(Date.now() / 1000),
    410,
    "Session has expired.",
  );
  return s;
}
function open(s: Session) {
  requireThat(
    s.state === "open" && s.expires_at > Math.floor(Date.now() / 1000),
    410,
    "This capture session is closed or expired.",
  );
}
async function machine(request: Request, env: Env) {
  requireThat(
    SHA.test(env.MACHINE_TOKEN_SHA256) &&
      (await tokenHash(request)) === env.MACHINE_TOKEN_SHA256,
    403,
    "Invalid machine credential.",
  );
}
async function delivery(request: Request, s: Session) {
  context(request, s);
  requireThat(
    (await tokenHash(request)) === s.delivery_hash,
    403,
    "Invalid delivery credential.",
  );
}
async function cleanup(env: Env) {
  const expired = (
    await env.DB.prepare(
      "SELECT id FROM sessions WHERE purge_at<=? ORDER BY purge_at LIMIT 25",
    )
      .bind(Math.floor(Date.now() / 1000))
      .all<{ id: string }>()
  ).results;
  for (const s of expired) {
    const objects = await env.BUCKET.list({
      prefix: `sessions/${s.id}/`,
      limit: 100,
    });
    requireThat(
      !objects.truncated,
      500,
      "Unexpected session object count. Cleanup is incomplete.",
    );
    if (objects.objects.length)
      await env.BUCKET.delete(objects.objects.map((o) => o.key));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM photos WHERE session=?").bind(s.id),
      env.DB.prepare("DELETE FROM sessions WHERE id=? AND purge_at<=?").bind(
        s.id,
        Math.floor(Date.now() / 1000),
      ),
    ]);
  }
  return { purged_sessions: expired.length, more: expired.length === 25 };
}
async function route(request: Request, env: Env): Promise<Response> {
  requireThat(
    env.OWNER_EMAIL && env.APP_ORIGIN && env.MACHINE_TOKEN_SHA256,
    503,
    "Site configuration is incomplete.",
  );
  const url = new URL(request.url);
  requireThat(url.origin === env.APP_ORIGIN, 403, "Wrong Site origin.");
  const origin = request.headers.get("Origin");
  requireThat(
    !origin || origin === env.APP_ORIGIN,
    403,
    "Cross-origin requests are refused.",
  );
  requireThat(
    request.headers.get("Sec-Fetch-Site") !== "cross-site" ||
      request.method === "GET",
    403,
    "Cross-site write refused.",
  );
  if (request.method === "POST" && url.pathname === "/api/sessions") {
    await machine(request, env);
    const b = await body(request);
    requireThat(
      UUID.test(b.id) && SHA.test(b.delivery_hash),
      400,
      "Invalid session identity.",
    );
    for (const field of ["environment", "thread", "label"])
      requireThat(
        typeof b[field] === "string" &&
          b[field].length > 0 &&
          b[field].length <= 200,
        400,
        `Invalid ${field}.`,
      );
    const now = Math.floor(Date.now() / 1000);
    await cleanup(env);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sessions(id,environment,thread,label,delivery_hash,created_at,expires_at,purge_at) VALUES(?,?,?,?,?,?,?,?)",
    )
      .bind(
        b.id,
        b.environment,
        b.thread,
        b.label,
        b.delivery_hash,
        now,
        now + 1800,
        now + 86400,
      )
      .run();
    const s = await session(env, b.id);
    requireThat(
      s.delivery_hash === b.delivery_hash &&
        s.environment === b.environment &&
        s.thread === b.thread,
      409,
      "Session identity conflict.",
    );
    return json({
      id: s.id,
      url: `${env.APP_ORIGIN}/s/${s.id}`,
      expires_at: s.expires_at,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/cleanup") {
    await machine(request, env);
    return json(await cleanup(env));
  }
  const match = url.pathname.match(
    /^\/api\/sessions\/([^/]+)(?:\/(done|ack|photos)(?:\/([^/]+))?)?$/,
  );
  if (match) {
    const [, id, action, photoId] = match;
    requireThat(UUID.test(id), 404, "Session not found.");
    const s = await session(env, id);
    const isMachine = request.headers.has("Authorization");
    if (isMachine) await delivery(request, s);
    else owner(request, env);
    if (request.method === "GET" && !action) {
      if (!isMachine && s.state === "open") open(s);
      return json({
        id: s.id,
        environment: s.environment,
        thread: s.thread,
        label: s.label,
        state: s.state,
        ...(isMachine && s.state === "delivered"
          ? {
              remote_deleted:
                (await env.BUCKET.list({ prefix: `sessions/${id}/`, limit: 1 }))
                  .objects.length === 0,
            }
          : {}),
        expires_at: s.expires_at,
        photos: (await list(env, id))
          .filter((p) => p.ready === 1)
          .map((p) => ({ id: p.id, sha256: p.sha256, size: p.size })),
      });
    }
    if (request.method === "PUT" && action === "photos" && photoId) {
      requireThat(!isMachine, 403, "Only the signed-in owner can upload.");
      open(s);
      requireThat(UUID.test(photoId), 400, "Invalid photo identity.");
      requireThat(
        request.headers.get("Content-Type") === "image/jpeg",
        415,
        "Photos must be JPEG.",
      );
      const bytes = await limitedBytes(request, MAX_PHOTO);
      requireThat(
        bytes.length >= 4 &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes[2] === 255 &&
          bytes.at(-2) === 255 &&
          bytes.at(-1) === 217,
        415,
        "Invalid JPEG bytes.",
      );
      const sha = await digest(bytes);
      requireThat(
        sha === request.headers.get("X-Content-SHA256"),
        422,
        "Photo checksum mismatch.",
      );
      const count = (await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM photos WHERE session=?",
      )
        .bind(id)
        .first<{ n: number }>())!.n;
      // SQL owns the open/expiry/limit invariant, including concurrent uploads and Done.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO photos(session,id,sha256,size,position) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND state='open' AND expires_at>unixepoch()) AND (SELECT COUNT(*) FROM photos WHERE session=?)<?`,
      )
        .bind(id, photoId, sha, bytes.length, count, id, id, MAX_PHOTOS)
        .run();
      const p = await env.DB.prepare(
        "SELECT * FROM photos WHERE session=? AND id=?",
      )
        .bind(id, photoId)
        .first<Photo>();
      requireThat(p, 409, "Session is closed or the photo limit was reached.");
      requireThat(
        p.sha256 === sha && p.size === bytes.length,
        409,
        "Photo identity was already used for different bytes.",
      );
      if (p.ready === 1) return json({ id: photoId, sha256: sha });
      await env.BUCKET.put(key(id, photoId), bytes, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      await env.DB.prepare("UPDATE photos SET ready=1 WHERE session=? AND id=?")
        .bind(id, photoId)
        .run();
      const current = await env.DB.prepare(
        "SELECT state FROM sessions WHERE id=?",
      )
        .bind(id)
        .first<{ state: string }>();
      if (!current || ["acknowledging", "delivered"].includes(current.state))
        await env.BUCKET.delete(key(id, photoId));
      return json({ id: photoId, sha256: sha });
    }
    if (request.method === "POST" && action === "done") {
      requireThat(
        !isMachine,
        403,
        "Only the signed-in owner can finish capture.",
      );
      if (s.state === "done" || s.state === "delivered")
        return json({ state: s.state });
      open(s);
      const result = await env.DB.prepare(
        `UPDATE sessions SET state='done' WHERE id=? AND state='open' AND expires_at>unixepoch() AND EXISTS(SELECT 1 FROM photos WHERE session=?) AND NOT EXISTS(SELECT 1 FROM photos WHERE session=? AND ready=0)`,
      )
        .bind(id, id, id)
        .run();
      requireThat(
        result.meta.changes === 1,
        409,
        "Add at least one photo and wait for uploads to finish.",
      );
      return json({ state: "done" });
    }
    if (request.method === "GET" && action === "photos" && photoId) {
      requireThat(isMachine, 403, "Delivery credential required.");
      requireThat(
        s.state === "done",
        409,
        "Photos are not available for delivery.",
      );
      const p = (await list(env, id)).find(
        (p) => p.id === photoId && p.ready === 1,
      );
      requireThat(p, 404, "Photo not found.");
      const object = await env.BUCKET.get(key(id, photoId));
      requireThat(object, 500, "Saved photo is missing.");
      return new Response(object.body, {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(p.size),
          "X-Content-SHA256": p.sha256,
        },
      });
    }
    if (request.method === "POST" && action === "ack") {
      requireThat(isMachine, 403, "Delivery credential required.");
      requireThat(
        ["done", "acknowledging", "delivered"].includes(s.state),
        409,
        "Session is not ready.",
      );
      const b = await body(request),
        photos = await list(env, id);
      requireThat(
        Array.isArray(b.photos) &&
          b.photos.length === photos.length &&
          photos.every((p) =>
            b.photos.some(
              (v: { id: string; sha256: string }) =>
                v.id === p.id && v.sha256 === p.sha256,
            ),
          ),
        422,
        "Acknowledgement must match every saved photo.",
      );
      // Fence uploads before deleting. A failed delete leaves acknowledgement retryable.
      await env.DB.prepare(
        "UPDATE sessions SET state='acknowledging' WHERE id=? AND state='done'",
      )
        .bind(id)
        .run();
      await env.BUCKET.delete(photos.map((p) => key(id, p.id)));
      await env.DB.prepare(
        "UPDATE sessions SET state='delivered' WHERE id=? AND state='acknowledging'",
      )
        .bind(id)
        .run();
      return json({ state: "delivered" });
    }
    throw new Problem(405, "Operation not allowed.");
  }
  owner(request, env);
  if (request.method === "GET" && url.pathname === "/app.js")
    return new Response(CLIENT_JS, {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  if (
    request.method === "GET" &&
    (url.pathname === "/" || /^\/s\/[a-f0-9-]+$/.test(url.pathname))
  )
    return new Response(PAGE_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  throw new Problem(404, "Page not found.");
}
export default {
  async fetch(request: Request, env: Env) {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      if (error instanceof Problem)
        response = json({ error: error.message }, error.status);
      else {
        console.error(
          "Muninn request failed",
          error instanceof Error ? error.message : "Unknown error",
        );
        response = json(
          {
            error:
              "Storage or server failure. Nothing has been acknowledged. Retry, or tell the waiting agent.",
          },
          500,
        );
      }
    }
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob:; media-src blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "Permissions-Policy": "camera=(self), microphone=()",
    }))
      headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },
};
