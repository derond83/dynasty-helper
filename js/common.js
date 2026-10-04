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
  // The deploy stamps the commit into index.html; adding it to every file the app loads means a new
  // deploy gets new addresses, so browsers can't keep serving an older copy of one file.
  const meta = typeof document !== "undefined" && document.querySelector('meta[name="app-version"]');
  DH.version = meta && !/^__/.test(meta.content) ? meta.content : "dev";
  const loaded = new Map();
  DH.loadScript = function (src) {
    if (!loaded.has(src)) {
      loaded.set(src, new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = DH.version === "dev" ? src : `${src}?v=${DH.version}`;
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
  /** Options for the team picker, sorted by team name. */
  DH.teamOptions = function (data, selected) {
    return data.rosters.slice()
      .sort((a, b) => DH.teamName(data, a.roster_id).localeCompare(DH.teamName(data, b.roster_id)))
      .map((r) => {
        const t = DH.teamName(data, r.roster_id), o = DH.ownerName(data, r.roster_id);
        return `<option value="${r.roster_id}"${String(r.roster_id) === String(selected) ? " selected" : ""}>${esc(t)}${o && o !== t ? " · " + esc(o) : ""}</option>`;
      }).join("");
  };

  /** League title block: meta line, name, and your team (changed on the Settings tab). */
  DH.leagueHead = function (ctx, { meta }) {
    const data = ctx.data;
    const team = DH.teamName(data, ctx.rosterId), owner = DH.ownerName(data, ctx.rosterId);
    return `<header class="top">
      <div class="brand">
        <span class="eyebrow">${esc(meta)}</span>
        <h1>${esc(data.league.name)}</h1>
      </div>
      <div class="whoami">
        <span class="eyebrow">Your team</span>
        <span class="team-name">${esc(team)}${owner && owner !== team ? ` <span class="muted">· ${esc(owner)}</span>` : ""}</span>
        <a class="small settings-link" href="#/${esc(ctx.id)}/settings">${DH.icon("gear")}<span>Change in Settings</span></a>
      </div>
    </header>
    ${ctx.teamGuessed ? `<div class="banner"><span><strong>Pick your team.</strong> Suggestions are showing for ${esc(team)}. Choose yours on the <a href="#/${esc(ctx.id)}/settings">Settings</a> tab, or add your Sleeper username on the <a href="#/leagues">Leagues</a> page so every league opens on your team.</span></div>` : ""}`;
  };

  // ---------- Settings tab pieces ----------

  /** Sliders. defs: { key: { label, min, max, step, fmt(v), help } }; values: { key: number }. */
  DH.knobsHtml = (ctx, defs, values) => `<div class="knobs">${Object.entries(defs).map(([k, d]) => `<div class="knob">
      <div class="lab"><label for="k-${k}-${esc(ctx.id)}">${esc(d.label)}</label><output data-out="${k}">${esc(d.fmt(Number(values[k])))}</output></div>
      <input type="range" id="k-${k}-${esc(ctx.id)}" data-knob="${k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${values[k]}">
      <p>${d.help}</p></div>`).join("")}</div>`;

  /** Locked players with unlock buttons. players: [{ id, name, team, groups }] */
  DH.lockedListHtml = (locked, players, chips) => {
    const rows = players.filter((p) => locked.has(String(p.id)));
    return rows.length
      ? `<ul class="lrows">${rows.map((p) => `<li class="lrow"><span class="lrow-text"><span class="lname">${esc(p.name)}</span><span class="muted small">${chips(p.groups)} ${esc(p.team || "")}</span></span><span class="lrow-actions">${DH.lockBtn(locked, p)}</span></li>`).join("")}</ul>`
      : '<p class="muted">No locked players. Use the Lock button on a player in the Players tab, a recommended move or a trade to keep him off the drop and trade lists.</p>';
  };

  /** The Settings tab shell; sections: [{ title, note, body }]. */
  DH.settingsHtml = (sections) => sections.map((s) => `<section class="card section">
      <div class="section-head"><h2>${esc(s.title)}</h2>${s.note ? `<p>${s.note}</p>` : ""}</div>${s.body}</section>`).join("");

  // ---------- Trades ----------

  /**
   * Trade suggestion cards. fmt: { name(id), meta(id) (html), value(v) (text), unit, partner(rosterId) (text),
   * group(g) (text) }. t: a TradeEngine suggestion with theirRanks.
   */
  DH.tradeCards = function (ctx, trades, locked, info, fmt, teams) {
    if (!trades.length) return "";
    const side = (ids, mineSide) => ids.map((id) => `<li><span class="nm">${esc(info[id].name)}</span>
        <span class="meta">${fmt.meta(id)}</span>${mineSide ? DH.lockBtn(locked, info[id]) : ""}</li>`).join("");
    const signed = (v) => `${v >= 0 ? "+" : "−"}${fmt.value(Math.abs(v))}`;
    return trades.map((t, i) => {
      const why = [];
      for (const g of t.fills) why.push(`<span class="tag fit">Fills their ${esc(fmt.group(g))}${t.theirRanks && t.theirRanks[g] ? ` (${DH.fmt.ordinal(t.theirRanks[g])} of ${teams})` : ""}</span>`);
      if (t.myGain > 0) {
        const up = t.myChanges.filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]).map(([g, d]) => `${fmt.group(g)} ${signed(d)}`);
        why.push(`<span class="tag fit">Your starters ${signed(t.myGain)}${up.length ? ` (${esc(up.join(", "))})` : ""}</span>`);
      }
      why.push(`<span class="tag${t.myValue >= 0 ? " fit" : ""}">Value ${signed(t.myValue)} for you</span>`);
      // Fairness is judged with the premium for the best player in an uneven deal, so it can differ
      // from the plain value change above; say how close it is, not who "wins".
      const pctOff = Math.round(Math.abs(1 - t.fairness) * 100);
      const uneven = t.give.length !== t.get.length;
      why.push(`<span>${pctOff <= 2 ? "Even on value" : `Fair: ${pctOff}% apart`}${uneven ? ", counting the 2-for-1 premium" : ""} · their starters ${signed(t.theirGain)}</span>`);
      const drops = [];
      if (t.myDrop.length) drops.push(`You'd release ${t.myDrop.map((id) => esc(info[id].name)).join(", ")} to make room.`);
      if (t.theirDrop.length) drops.push(`They'd release ${t.theirDrop.map((id) => esc(info[id].name)).join(", ")} to make room.`);
      return `<article class="trade">
        <header><span class="step">${i + 1}</span><span>Trade with <strong>${esc(fmt.partner(t.partner))}</strong></span></header>
        <div class="trade-sides">
          <div class="tside"><span class="verb drop">You give</span><ul>${side(t.give, true)}</ul></div>
          <div class="arrow" aria-hidden="true">⇄</div>
          <div class="tside"><span class="verb add">You get</span><ul>${side(t.get, false)}</ul></div>
        </div>
        <div class="why">${why.join("")}</div>
        ${drops.length ? `<p class="small muted">${drops.join(" ")}</p>` : ""}
      </article>`;
    }).join("");
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

  // Small inline icons (stroke follows the text color, so they suit light and dark themes).
  const ICONS = {
    gear: '<svg class="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  };
  DH.icon = (name) => ICONS[name] || "";

  DH.subtabs = (ctx, tabs) => `<nav class="subtabs" aria-label="Sections">${tabs.map((t) =>
    `<a href="#/${esc(ctx.id)}/${t.id}"${t.id === ctx.tab ? ' aria-current="page"' : ""}${t.icon ? ` class="has-icon tab-${t.id}"` : ""}>${t.icon ? DH.icon(t.icon) : ""}<span>${esc(t.label)}</span>${t.badge ? ` <span class="count">${esc(t.badge)}</span>` : ""}</a>`).join("")}</nav>`;

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
