// Settings sync across devices, through the sync Worker (worker/). Everything the app saves under
// "dh." is mirrored to one small document per person, found by a random sync key this browser makes.
// Changes are sent a few seconds after the last edit (the free tier allows 1,000 saves a day across
// everyone), and fetched when the app opens or comes back to the foreground.
// Sync state itself lives under "dhx." so it never syncs.
(function (root) {
  "use strict";
  const DH = root.DH;
  const DEFAULT_URL = "https://dynasty-helper-sync.deron-dantzler.workers.dev";
  const DEBOUNCE = 4000, PULL_EVERY = 60000, RETRY = 60000;

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
    keys() { try { return Object.keys(localStorage); } catch (e) { return []; } },
  };
  const url = () => ls.get("dhx.syncUrl") || DEFAULT_URL; // overridable for local testing
  const key = () => ls.get("dhx.syncKey");

  // What syncs: every "dh." setting except where you are in the app on this device.
  const LOCAL_ONLY = /^dh\.(last|migrated|listV2)$|^dh\.L\.[^.]+\.tab$/;
  const synced = (k) => k.startsWith("dh.") && !LOCAL_ONLY.test(k);
  const localDoc = () => Object.fromEntries(ls.keys().filter(synced).map((k) => [k, ls.get(k)]));

  const dirty = new Set(JSON.parse(ls.get("dhx.dirty") || "[]"));
  const saveDirty = () => ls.set("dhx.dirty", JSON.stringify([...dirty]));

  let status = { state: key() ? "idle" : "off", at: Number(ls.get("dhx.syncedAt")) || null, error: null };
  const listeners = new Set();
  const setStatus = (s) => { status = { ...status, ...s }; listeners.forEach((f) => f(status)); };

  function newKey() {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function request(method, body, k = key(), opts = {}) {
    const res = await fetch(`${url()}/v1/state`, {
      method, keepalive: !!opts.keepalive,
      headers: { Authorization: `Bearer ${k}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === "GET") return null;
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  /** Write the server's copy into this browser, leaving keys with unsent local changes alone. */
  function apply(doc) {
    let changed = false;
    for (const [k, v] of Object.entries(doc)) {
      if (!synced(k) || dirty.has(k) || ls.get(k) === v) continue;
      ls.set(k, v); changed = true;
    }
    for (const k of ls.keys().filter(synced)) {
      if (!(k in doc) && !dirty.has(k)) { ls.del(k); changed = true; }
    }
    return changed;
  }
  const done = () => { const at = Date.now(); ls.set("dhx.syncedAt", String(at)); setStatus({ state: "idle", at, error: null }); };

  let timer = null, busy = null, lastPull = 0;

  /** Send unsent changes. */
  async function push(opts = {}) {
    if (!key() || !dirty.size) return;
    const keys = [...dirty];
    const set = Object.fromEntries(keys.map((k) => [k, ls.get(k)]));
    setStatus({ state: "saving" });
    try {
      const saved = await request("PATCH", { set }, key(), opts);
      // Anything edited again while this was in flight stays dirty.
      for (const k of keys) if (ls.get(k) === set[k]) dirty.delete(k);
      saveDirty();
      const changed = apply(saved.doc);
      done();
      if (changed) DH.sync.onRemoteChange();
    } catch (e) {
      setStatus({ state: "error", error: e.message });
      clearTimeout(timer); timer = setTimeout(() => run(push), RETRY);
    }
  }

  /** Fetch the latest copy; on the very first sync, send everything this browser has. */
  async function pull() {
    if (!key()) return;
    lastPull = Date.now();
    setStatus({ state: "saving" });
    try {
      const saved = await request("GET");
      if (!saved) { Object.keys(localDoc()).forEach((k) => dirty.add(k)); saveDirty(); return push(); }
      const changed = apply(saved.doc);
      done();
      if (changed) DH.sync.onRemoteChange();
      if (dirty.size) return push();
    } catch (e) { setStatus({ state: "error", error: e.message }); }
  }

  // One request at a time.
  const run = (fn, ...args) => (busy = (busy || Promise.resolve()).then(() => fn(...args)).catch(() => {}).finally(() => { busy = null; }));

  DH.sync = {
    onRemoteChange: () => {}, // set by the app: re-render after settings arrive from another device
    status: () => status,
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    enabled: () => !!key(),
    link: () => (key() ? `${location.origin}${location.pathname}#/sync/${key()}` : null),

    /** Called by the app's storage on every save. */
    touch(k) {
      if (!synced(k) || ls.get("dhx.syncOff")) return;
      if (!key()) { ls.set("dhx.syncKey", newKey()); Object.keys(localDoc()).forEach((x) => dirty.add(x)); setStatus({ state: "idle" }); }
      dirty.add(k); saveDirty();
      clearTimeout(timer); timer = setTimeout(() => run(push), DEBOUNCE);
    },

    start() {
      if (key()) run(pull);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") { if (dirty.size) { clearTimeout(timer); push({ keepalive: true }); } }
        else if (Date.now() - lastPull > PULL_EVERY) run(pull);
      });
    },

    /** Use another device's sync key here: its settings replace this browser's. */
    async join(k) {
      const saved = await request("GET", null, k);
      if (!saved) throw new Error("Nothing is saved under that sync link. Open the app on your other device first.");
      clearTimeout(timer);
      for (const x of ls.keys().filter(synced)) ls.del(x);
      dirty.clear(); saveDirty();
      ls.set("dhx.syncKey", k); ls.del("dhx.syncOff");
      apply(saved.doc);
      done();
    },

    /** Stop syncing in this browser (settings stay here; the saved copy stays for other devices). */
    stop() { clearTimeout(timer); ls.del("dhx.syncKey"); ls.set("dhx.syncOff", "1"); dirty.clear(); saveDirty(); setStatus({ state: "off", at: null }); },

    /** Turn sync back on here with a new sync key. */
    resume() { ls.del("dhx.syncOff"); const any = Object.keys(localDoc())[0]; if (any) this.touch(any); else setStatus({ state: "off" }); },

    /** Delete the saved copy everywhere and stop syncing here. */
    async erase() { if (key()) await request("DELETE"); this.stop(); },

    validKey: (k) => /^[A-Za-z0-9_-]{32,64}$/.test(k || ""),
  };
})(window);
