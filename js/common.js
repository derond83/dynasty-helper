// Shared helpers for the app shell and the sport views. No league logic here.
(function (root) {
  "use strict";
  const DH = (root.DH = root.DH || {});
  DH.sports = DH.sports || {};

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ordinal = (n) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  const int = (v) => Math.round(v).toLocaleString();
  const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
  DH.fmt = { esc, ordinal, int, pct };

  // ---------- Storage ----------
  // Everything lives under "dh."; per-league settings under "dh.L.<league id>.".
  const raw = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
  };
  const getJSON = (k, fallback) => { try { const v = JSON.parse(raw.get(k)); return v ?? fallback; } catch (e) { return fallback; } };
  const setJSON = (k, v) => raw.set(k, JSON.stringify(v));
  DH.store = {
    get: (k, fallback) => getJSON("dh." + k, fallback),
    set: (k, v) => setJSON("dh." + k, v),
    del: (k) => raw.del("dh." + k),
    league(id) {
      const p = `dh.L.${id}.`;
      return { get: (k, fallback) => getJSON(p + k, fallback), set: (k, v) => setJSON(p + k, v) };
    },
    // Move one league's settings to a new id (a league renewed for a new season).
    moveLeague(from, to) {
      for (const k of ["team", "locked", "options"]) {
        const v = raw.get(`dh.L.${from}.${k}`);
        if (v != null && raw.get(`dh.L.${to}.${k}`) == null) raw.set(`dh.L.${to}.${k}`, v);
      }
    },
  };

  // Settings saved by the two single-league pages this app replaces (same github.io origin).
  DH.migrateOldSettings = function () {
    if (raw.get("dh.migrated")) return;
    const football = "1312071895943745536", basketball = "1344379308411469824";
    const team = raw.get("dynasty-helper.team");
    if (team) setJSON(`dh.L.${football}.team`, team);
    const locked = getJSON("dynasty-helper.locked", null);
    if (locked) setJSON(`dh.L.${football}.locked`, locked);
    const opts = getJSON("dynasty-helper.options", null);
    if (opts) { delete opts.idpFloor; setJSON(`dh.L.${football}.options`, opts); }
    const bTeam = raw.get("assoc-waivers.team");
    if (bTeam) setJSON(`dh.L.${basketball}.team`, bTeam);
    const bLocked = getJSON("assoc-waivers.locked", null);
    if (bLocked) setJSON(`dh.L.${basketball}.locked`, bLocked);
    raw.set("dh.migrated", "1");
  };

  // ---------- Scripts ----------
  const loaded = new Map();
  DH.loadScript = function (src) {
    if (!loaded.has(src)) {
      loaded.set(src, new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => { loaded.delete(src); reject(new Error(`Couldn't load ${src}`)); };
        document.head.appendChild(s);
      }));
    }
    return loaded.get(src);
  };

  // ---------- Shared page pieces ----------
  const LEAGUE_TYPES = { 0: "redraft", 1: "keeper", 2: "dynasty", 3: "guillotine" };
  DH.leagueType = (league) => LEAGUE_TYPES[(league.settings || {}).type] || "other";

  DH.teamName = function (data, rosterId) {
    const r = data.rosters.find((x) => String(x.roster_id) === String(rosterId));
    const u = r && data.users.find((x) => x.user_id === r.owner_id);
    if (!u) return `Team ${rosterId}`;
    return (u.team_name || (u.metadata && u.metadata.team_name) || u.display_name || `Team ${rosterId}`).trim();
  };
  DH.ownerName = function (data, rosterId) {
    const r = data.rosters.find((x) => String(x.roster_id) === String(rosterId));
    const u = r && data.users.find((x) => x.user_id === r.owner_id);
    return u ? u.display_name : "";
  };

  /** League title block: meta line, name, extra controls (left of the team picker), team picker. */
  DH.leagueHead = function (ctx, { meta, controls = "" }) {
    const data = ctx.data;
    const options = data.rosters.slice()
      .sort((a, b) => DH.teamName(data, a.roster_id).localeCompare(DH.teamName(data, b.roster_id)))
      .map((r) => {
        const t = DH.teamName(data, r.roster_id), o = DH.ownerName(data, r.roster_id);
        return `<option value="${r.roster_id}"${String(r.roster_id) === String(ctx.rosterId) ? " selected" : ""}>${esc(t)}${o && o !== t ? " · " + esc(o) : ""}</option>`;
      }).join("");
    return `<header class="top">
      <div class="brand">
        <span class="eyebrow">${esc(meta)}</span>
        <h1>${esc(data.league.name)}</h1>
      </div>
      <div class="pickers">
        ${controls}
        <div class="field">
          <label for="team-${esc(ctx.id)}">Your team</label>
          <select id="team-${esc(ctx.id)}" class="team-select" data-team>${options}</select>
        </div>
      </div>
    </header>
    ${ctx.teamGuessed ? `<div class="banner"><span><strong>Pick your team.</strong> Suggestions are showing for ${esc(DH.teamName(data, ctx.rosterId))}. Choose yours from the menu above, or add your Sleeper username on the <a href="#/leagues">Leagues</a> page so every league opens on your team.</span></div>` : ""}`;
  };

  DH.sourceLine = function (ctx, extra) {
    const when = ctx.fetched ? new Date(ctx.fetched).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const live = ctx.source === "live";
    return `<div class="sources"><span><span class="dot ${live ? "live" : ""}"></span>${live ? "Live from Sleeper" : `Sleeper snapshot from ${esc(when)}`}</span>
      <details class="srcs"><summary>Data sources</summary><ul>${extra.map((x) => `<li>${x}</li>`).join("")}</ul></details></div>`;
  };

  DH.warnBanner = (warns) => warns.length
    ? `<div class="banner"><span><strong>Some data couldn't be refreshed.</strong> The last good copy is in use. ${warns.map(esc).join(" · ")}</span></div>` : "";

  DH.summary = (cells) => `<div class="summary">${cells.map(([v, l]) => `<div><span class="big">${v}</span><span class="small muted">${l}</span></div>`).join("")}</div>`;

  DH.subtabs = (ctx, tabs) => `<nav class="subtabs" aria-label="Sections">${tabs.map((t) =>
    `<a href="#/${esc(ctx.id)}/${t.id}"${t.id === ctx.tab ? ' aria-current="page"' : ""}>${esc(t.label)}${t.badge ? ` <span class="count">${esc(t.badge)}</span>` : ""}</a>`).join("")}</nav>`;

  DH.lockBtn = function (locked, p) {
    const on = locked.has(String(p.id));
    return `<button type="button" class="lock" data-lock="${esc(p.id)}" aria-pressed="${on}" aria-label="${on ? "Unlock" : "Lock"} ${esc(p.name)}" title="${on ? "Locked: never suggested as a drop. Click to unlock." : "Lock to keep him out of drop suggestions"}">${on ? "🔒 Locked" : "Lock"}</button>`;
  };

  /** Re-render, then put keyboard focus back on the control with this selector, if it still exists. */
  DH.refocus = function (selector) {
    const el = selector && document.querySelector(selector);
    if (el) el.focus();
  };
})(typeof window !== "undefined" ? window : globalThis);
