// Settings sync for Dynasty Helper. Each person's settings are one small JSON document in Workers KV,
// found by a random sync key their browser makes. The key is never stored: KV holds its SHA-256, so
// listing the namespace reveals nothing usable.
//
//   GET    /v1/state   -> { rev, updated, doc }   (404 if nothing saved yet)
//   PATCH  /v1/state   { set: { key: value | null } } -> { rev, updated, doc }
//   DELETE /v1/state   -> 204
//   GET    /health     -> "ok"
// Requests carry "Authorization: Bearer <sync key>". doc maps app storage keys ("dh.…") to their
// stored strings; a null in a patch removes that key.

const ORIGINS = [/^https:\/\/derond83\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const KEY_RE = /^[A-Za-z0-9_-]{32,64}$/;
const NAME_RE = /^dh\.[A-Za-z0-9_.-]{1,120}$/;
const LIMITS = { body: 64 * 1024, doc: 200 * 1024, keys: 2000, value: 32 * 1024 };

function cors(req) {
  const origin = req.headers.get("Origin") || "";
  const ok = ORIGINS.some((re) => re.test(origin));
  return ok ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  } : { Vary: "Origin" };
}

const json = (req, status, body) => new Response(body == null ? null : JSON.stringify(body), {
  status, headers: { ...cors(req), ...(body == null ? {} : { "Content-Type": "application/json" }), "Cache-Control": "no-store" },
});
const fail = (req, status, error) => json(req, status, { error });

async function storageKey(syncKey) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(syncKey));
  return "u:" + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (url.pathname === "/health") return new Response("ok", { headers: { ...cors(req), "Cache-Control": "no-store" } });
    if (url.pathname !== "/v1/state") return fail(req, 404, "Not found");

    const auth = req.headers.get("Authorization") || "";
    const syncKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!KEY_RE.test(syncKey)) return fail(req, 401, "Missing or malformed sync key");
    const id = await storageKey(syncKey);

    if (req.method === "GET") {
      const saved = await env.KV.get(id, "json");
      return saved ? json(req, 200, saved) : fail(req, 404, "Nothing saved for this sync key");
    }
    if (req.method === "DELETE") {
      await env.KV.delete(id);
      return json(req, 204, null);
    }
    if (req.method !== "PATCH") return fail(req, 405, "Method not allowed");

    const text = await req.text();
    if (text.length > LIMITS.body) return fail(req, 413, "Too large");
    let patch;
    try { patch = JSON.parse(text); } catch (e) { return fail(req, 400, "Body isn't JSON"); }
    const set = patch && patch.set;
    if (!set || typeof set !== "object" || Array.isArray(set)) return fail(req, 400, "Expected { set: { … } }");
    for (const [k, v] of Object.entries(set)) {
      if (!NAME_RE.test(k)) return fail(req, 400, `Bad key ${k.slice(0, 40)}`);
      if (v !== null && (typeof v !== "string" || v.length > LIMITS.value)) return fail(req, 400, `Bad value for ${k}`);
    }

    const saved = (await env.KV.get(id, "json")) || { rev: 0, doc: {} };
    const doc = { ...saved.doc };
    for (const [k, v] of Object.entries(set)) {
      if (v === null) delete doc[k]; else doc[k] = v;
    }
    if (Object.keys(doc).length > LIMITS.keys || JSON.stringify(doc).length > LIMITS.doc) return fail(req, 413, "Too many settings");
    const next = { rev: saved.rev + 1, updated: new Date().toISOString(), doc };
    try { await env.KV.put(id, JSON.stringify(next)); } catch (e) {
      return fail(req, 503, "Storage is busy; try again shortly"); // e.g. the free tier's daily write limit
    }
    return json(req, 200, next);
  },
};
