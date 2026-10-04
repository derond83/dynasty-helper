// Tests the sync Worker with an in-memory KV: node tests/worker.mjs
import worker from "../worker/src/index.js";

const store = new Map();
const env = { KV: {
  async get(k, type) { const v = store.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
} };
const KEY = "abcdefghijklmnopqrstuvwxyz012345";
const call = (method, body, { key = KEY, origin = "https://derond83.github.io" } = {}) => worker.fetch(new Request("https://x.workers.dev/v1/state", {
  method, headers: { Authorization: `Bearer ${key}`, Origin: origin, "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body),
}), env);
let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) failed++; };

ok((await call("GET")).status === 404, "nothing saved yet is a 404");
let r = await call("PATCH", { set: { "dh.user": '{"username":"a"}', "dh.L.1.team": '"3"' } });
let b = await r.json();
ok(r.status === 200 && b.rev === 1 && b.doc["dh.L.1.team"] === '"3"', "patch creates the document");
ok(r.headers.get("Access-Control-Allow-Origin") === "https://derond83.github.io", "CORS allows the app");
r = await call("PATCH", { set: { "dh.L.1.team": null, "dh.leagues": "[]" } }); b = await r.json();
ok(b.rev === 2 && !("dh.L.1.team" in b.doc) && b.doc["dh.leagues"] === "[]" && b.doc["dh.user"], "patch merges and deletes");
ok((await (await call("GET")).json()).rev === 2, "get returns the latest");
ok(![...store.keys()].some((k) => k.includes(KEY)), "the sync key itself isn't stored");
ok((await call("GET", null, { key: "short" })).status === 401, "malformed key refused");
ok((await call("PATCH", { set: { "other.key": "1" } })).status === 400, "keys outside dh. refused");
ok((await call("PATCH", { set: { "dh.x": 5 } })).status === 400, "non-string values refused");
ok((await call("PATCH", { set: { "dh.x": "y".repeat(40000) } })).status === 400, "oversized value refused");
ok(!(await call("GET", null, { origin: "https://evil.example" })).headers.get("Access-Control-Allow-Origin"), "other origins get no CORS");
ok((await call("DELETE")).status === 204 && (await call("GET")).status === 404, "delete removes everything");
const fb = (body, origin = "https://derond83.github.io") => worker.fetch(new Request("https://x.workers.dev/v1/feedback", {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
ok((await fb({ message: "Love it", from: "Sam", context: { page: "#/1/team" } })).status === 204, "feedback is saved");
const fbKey = [...store.keys()].find((k) => k.startsWith("fb:"));
ok(fbKey && JSON.parse(store.get(fbKey)).message === "Love it", "feedback stored under fb:");
ok((await fb({ message: "  " })).status === 400, "empty feedback refused");
ok((await fb({ message: "hi" }, "https://evil.example")).status === 403, "feedback from other sites refused");
for (let i = 0; i < 45; i++) await fb({ message: "spam " + i });
ok([...store.keys()].filter((k) => k.startsWith("fb:")).length === 40, "feedback capped per day");
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
