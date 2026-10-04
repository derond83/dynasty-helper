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

  // ---------- Rookie draft ----------

  /**
   * Tabs to show. Draft and Matchup take turns: Draft while a rookies-only draft is pending,
   * Matchup during the season otherwise.
   */
  DH.visibleTabs = (tabs, rookieDraft, league) => tabs.filter((t) =>
    t.id === "draft" ? !!rookieDraft : t.id === "matchup" ? !rookieDraft && league.status === "in_season" : true);

  /** If the page asks for a tab that isn't shown (e.g. Draft with no draft pending), go to the first one. */
  DH.settleTab = function (ctx, tabs) {
    if (tabs.some((t) => t.id === ctx.tab)) return;
    ctx.tab = tabs[0].id;
    ctx.store.set("tab", ctx.tab);
    history.replaceState(null, "", `#/${ctx.id}/${ctx.tab}`);
  };

  /** The draft board: a card per pick you own. fmt: { rank(p) text, sub(p) html, basis } */
  DH.draftHtml = function (ctx, rd, myRosterId, fmt) {
    if (!rd) return "";
    const date = rd.start ? new Date(rd.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "date not set";
    const note = `${rd.rounds}-round ${rd.type} rookie draft, ${date}. Rookies are kept off the waiver wire (Team tab) until it's done. Targets assume the room drafts close to ${fmt.basis}, with a one-pick cushion, and are sorted by fit for your roster.`;
    let body;
    if (!rd.picks.length) {
      body = `<div class="empty">You don't own a pick in this draft. The top rookies on the board: ${rd.board.slice(0, 6).map((p) => `${esc(p.name)} (${esc(fmt.rank(p))})`).join(", ")}.</div>`;
    } else {
      body = `<div class="picks">${rd.picks.map((pk) => {
        const from = String(pk.fromRoster) !== String(myRosterId) ? `<small>via ${esc(DH.teamName(ctx.data, pk.fromRoster))}</small>` : "";
        const items = pk.targets.map((p, i) => `<li><span class="nm">${esc(p.name)}</span><span class="rank">${esc(fmt.rank(p))}</span>
            <span class="sub">${fmt.sub(p)}${i === 0 ? ' <span class="tag fit">Top fit</span>' : ""}</span></li>`).join("");
        return `<article class="pick">
          <div class="num">${pk.round}.${String(pk.pick).padStart(2, "0")}${from}</div>
          <div class="small muted">Pick ${pk.overall} overall · about ${pk.expected ? `the ${DH.fmt.ordinal(pk.overall)}-best rookie` : "end of the board"}</div>
          <ol>${items || '<li class="muted">No ranked rookies expected to be left.</li>'}</ol>
        </article>`;
      }).join("")}</div>`;
    }
    return `<section class="section"><div class="section-head"><h2>Rookie draft</h2><p>${esc(note)}</p></div>${body}</section>`;
  };

  // ---------- Matchup ----------

  const matchupCache = new Map(); // "<league>:<week>" -> Sleeper matchups (or a pending promise)

  /**
   * The Matchup tab. sp: { sport, fits(id, slot), spread(points), chips(groups) html, groupsOf(id),
   * note } — the sport's slot rules. Loads this week's projections and matchups on first view.
   */
  DH.matchupHtml = function (ctx, sp) {
    const Lineup = root.LineupEngine;
    const proj = root[`PROJ_${sp.sport.toUpperCase()}`];
    if (!proj) {
      DH.loadScript(`data/${sp.sport}/proj.js`).then(ctx.rerender, () => {});
      return '<div class="loading" role="status">Loading this week\'s projections…</div>';
    }
    const data = ctx.data, league = data.league, week = proj.week;
    const key = `${ctx.id}:${week}`;
    if (!matchupCache.has(key)) {
      const saved = data.matchups && data.matchups.week === week ? data.matchups.teams : null;
      matchupCache.set(key, saved);
      DH.sleeper.get(`/league/${ctx.id}/matchups/${week}`)
        .then((m) => { matchupCache.set(key, (m || []).map((x) => ({ roster_id: x.roster_id, matchup_id: x.matchup_id, starters: x.starters }))); ctx.rerender(); })
        .catch(() => {});
    }
    const matchups = matchupCache.get(key) || [];
    const rp = league.roster_positions || [];
    const slots = rp.filter((s) => !["BN", "IR", "TAXI"].includes(s));
    const scoring = league.scoring_settings || {};
    const players = data.players || {};
    const pname = (id) => (players[id] && players[id].full_name) || (/^[A-Z]{2,3}$/.test(id) ? `${id} defense` : `Player ${id}`);
    const injury = (id) => (players[id] && players[id].injury_status) || null;
    const raw = (id) => { const p = proj.players[id]; return p ? Lineup.score(p.s, scoring) : 0; };
    const factor = (id) => Lineup.AVAILABLE[injury(id)] ?? 1;
    const pts = (id) => raw(id) * factor(id);
    const active = (r) => { const out = new Set([...(r.reserve || []), ...(r.taxi || [])].map(String)); return (r.players || []).map(String).filter((id) => !out.has(id)); };
    const mineRoster = data.rosters.find((r) => String(r.roster_id) === String(ctx.rosterId));
    const myM = matchups.find((m) => String(m.roster_id) === String(ctx.rosterId));
    const oppM = myM && myM.matchup_id != null ? matchups.find((m) => m.matchup_id === myM.matchup_id && String(m.roster_id) !== String(ctx.rosterId)) : null;
    const oppRoster = oppM ? data.rosters.find((r) => r.roster_id === oppM.roster_id) : null;
    const res = Lineup.matchup({
      slots, fits: sp.fits, pts, spread: sp.spread,
      mine: { active: active(mineRoster), starters: (myM && myM.starters) || mineRoster.starters },
      theirs: oppRoster ? { active: active(oppRoster), starters: (oppM && oppM.starters) || oppRoster.starters } : null,
    });
    const f1 = (v) => v.toFixed(1);
    const oppName = oppRoster ? DH.teamName(data, oppRoster.roster_id) : null;
    const tag = (id) => {
      const inj = injury(id), p = proj.players[id];
      const bits = [];
      if (inj) bits.push(`<span class="tag inj">${esc(inj)}</span>`);
      if (!p) bits.push(`<span class="tag warn">${sp.sport === "nfl" ? "No game" : "No games"}</span>`);
      else if (sp.sport === "nba") bits.push(`<span class="tag">${p.g} game${p.g === 1 ? "" : "s"}</span>`);
      else if (p.opp && p.opp.length) bits.push(`<span class="muted small">vs ${esc(p.opp.join(", "))}</span>`);
      return bits.join(" ");
    };
    const who = (id) => id ? `<span class="pname"><strong>${esc(pname(id))}</strong> ${sp.chips(sp.groupsOf(id))} ${tag(id)}</span>` : '<span class="muted">Empty</span>';

    // Scoreboard
    const wp = res.winProb;
    const board = `<section class="card section scoreboard">
      <div class="section-head"><h2>Week ${week}${oppName ? ` · vs ${esc(oppName)}` : ""}</h2>
        <p>Best lineups by projected points, scored with this league's settings${sp.note ? `. ${sp.note}` : ""}.</p></div>
      <div class="sb-row">
        <div class="sb-side"><span class="eyebrow">You</span><span class="big">${f1(res.me.bestTotal)}</span>
          <span class="small muted">Your Sleeper lineup: ${f1(res.me.currentTotal)}${res.me.bestTotal - res.me.currentTotal > 0.05 ? ` (+${f1(res.me.bestTotal - res.me.currentTotal)} with the changes below)` : " (already your best)"}</span></div>
        ${res.them ? `<div class="sb-mid"><span class="eyebrow">Win chance</span><span class="big">${Math.round(wp * 100)}%</span>
          <div class="wp" role="img" aria-label="Win chance ${Math.round(wp * 100)} percent"><i style="width:${(wp * 100).toFixed(0)}%"></i></div></div>
        <div class="sb-side right"><span class="eyebrow">${esc(oppName)}</span><span class="big">${f1(res.them.bestTotal)}</span>
          <span class="small muted">Their Sleeper lineup: ${f1(res.them.currentTotal)}</span></div>`
        : `<div class="sb-side"><span class="muted">${matchups.length ? "No opponent this week." : "Matchups for this week aren't set in Sleeper yet."}</span></div>`}
      </div></section>`;

    // Changes
    let changes;
    if (!res.changes.length && !res.emptySlots) changes = '<div class="empty">Your Sleeper lineup is already your best by projections.</div>';
    else changes = `<ol class="changes">${res.changes.map((c) => `<li>Start ${who(c.start)} <span class="muted">at ${esc(c.slot)}, ${f1(pts(c.start))}</span>${c.sit ? ` over ${who(c.sit)} <span class="muted">${f1(pts(c.sit))}</span> <span class="tag fit">+${f1(pts(c.start) - pts(c.sit))}</span>` : " <span class=\"tag warn\">fills an empty slot</span>"}</li>`).join("")}</ol>`;

    // Slot by slot
    const rows = res.rows.map((r) => {
      const a = r.mine ? pts(r.mine) : 0, b = r.theirs ? pts(r.theirs) : 0, d = a - b;
      return `<tr><td class="slot">${esc(r.slot)}</td><td>${who(r.mine)}</td><td class="num">${f1(a)}</td>
        ${res.them ? `<td>${who(r.theirs)}</td><td class="num">${f1(b)}</td><td class="num ${d > 0.05 ? "good" : d < -0.05 ? "bad" : ""}">${d > 0 ? "+" : ""}${f1(d)}</td>` : ""}</tr>`;
    }).join("");
    const table = `<div class="table-wrap"><table><thead><tr><th>Slot</th><th>You</th><th class="num">Proj</th>${res.them ? `<th>${esc(oppName)}</th><th class="num">Proj</th><th class="num">Edge</th>` : ""}</tr></thead><tbody>${rows}</tbody></table></div>`;

    // What decides it
    const notes = [];
    if (res.them) {
      const bySlot = {};
      for (const r of res.rows) bySlot[r.slot] = (bySlot[r.slot] || 0) + (r.mine ? pts(r.mine) : 0) - (r.theirs ? pts(r.theirs) : 0);
      const ranked = Object.entries(bySlot).sort((x, y) => y[1] - x[1]);
      const plus = ranked.filter(([, d]) => d > 1).slice(0, 3), minus = ranked.filter(([, d]) => d < -1).slice(-3).reverse();
      if (plus.length) notes.push(`You're ahead at ${plus.map(([g, d]) => `${esc(g)} (+${f1(d)})`).join(", ")}.`);
      if (minus.length) notes.push(`They're ahead at ${minus.map(([g, d]) => `${esc(g)} (${f1(d)})`).join(", ")}.`);
      const gap = res.them.bestTotal - res.them.currentTotal;
      if (gap > 1) {
        const dead = res.them.current.filter((id) => id && pts(id) === 0).map(pname);
        notes.push(`Their current Sleeper lineup is ${f1(gap)} points below their best${dead.length ? `; it starts ${esc(dead.join(", "))}, projected for 0` : ""}. If they don't fix it, your chances improve.`);
      }
      if (res.them.current.some((id) => !id)) notes.push("They have an empty starting slot right now.");
    }
    const risky = res.me.best.filter((id) => id && ["Questionable", "Doubtful"].includes(injury(id)));
    if (risky.length) notes.push(`Check before kickoff: ${risky.map((id) => `${esc(pname(id))} (${esc(injury(id))})`).join(", ")}. Projections count Questionable at 85% and Doubtful at 25%.`);
    const benchIds = active(mineRoster).filter((id) => !res.me.best.includes(id));
    const tossups = res.me.best.map((id, i) => {
      if (!id) return null;
      const alt = benchIds.filter((b) => sp.fits(b, slots[i])).sort((x, y) => pts(y) - pts(x))[0];
      return alt && pts(id) - pts(alt) < 1 ? `${esc(pname(id))} over ${esc(pname(alt))} at ${esc(slots[i])} is a toss-up (${f1(pts(id))} vs ${f1(pts(alt))})` : null;
    }).filter(Boolean);
    if (tossups.length) notes.push(`${tossups.slice(0, 3).join("; ")}.`);
    // Bench tables: every active non-starter, with where he could start and how far he is from it.
    const benchTable = (ids, lineup, mine) => {
      if (!ids.length) return '<p class="muted small">No one on the bench.</p>';
      const rows = ids.slice().sort((x, y) => pts(y) - pts(x)).map((id) => {
        const p = pts(id), pr = proj.players[id];
        const open = slots.map((slot, i) => ({ slot, i })).filter(({ slot }) => sp.fits(id, slot));
        // The starter he'd most easily replace: the eligible slot whose starter projects lowest.
        const best = open.map(({ slot, i }) => ({ slot, starter: lineup[i], gap: (lineup[i] ? pts(lineup[i]) : 0) - p }))
          .sort((x, y) => x.gap - y.gap)[0];
        const status = injury(id) ? `<span class="tag inj">${esc(injury(id))}</span>`
          : !pr ? `<span class="tag warn">${sp.sport === "nfl" ? "Bye" : "No games"}</span>` : "";
        const opp = pr ? (sp.sport === "nba" ? `${pr.g} game${pr.g === 1 ? "" : "s"}` : (pr.opp || []).map((o) => `vs ${esc(o)}`).join(", ")) : "–";
        const where = !open.length ? '<span class="muted">No slot</span>'
          : `${[...new Set(open.map((o) => o.slot))].map(esc).join(", ")}`;
        const gap = !best ? "–" : best.gap <= 0.05 ? `<span class="tag fit">Ahead of ${esc(pname(best.starter))}</span>`
          : `${f1(best.gap)} behind ${esc(best.starter ? pname(best.starter) : "an empty slot")} <span class="muted">(${esc(best.slot)})</span>`;
        return `<tr><td><span class="pname"><strong>${esc(pname(id))}</strong> ${sp.chips(sp.groupsOf(id))}</span></td>
          <td class="small">${opp}</td><td>${status}</td><td class="num"><span class="val">${f1(p)}</span></td>
          <td class="small">${where}</td><td class="small">${gap}</td></tr>`;
      }).join("");
      return `<div class="table-wrap"><table><thead><tr><th>Player</th><th>${sp.sport === "nfl" ? "Opponent" : "Games"}</th><th>Status</th>
        <th class="num">Proj</th><th>Can start at</th><th>${mine ? "Vs your starter" : "Vs their starter"}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    const theirBenchIds = oppRoster ? active(oppRoster).filter((id) => !res.them.best.includes(id)) : [];

    return `${board}
      <section class="section"><div class="section-head"><h2>Lineup changes</h2><p>Compared with the lineup you have set in Sleeper for week ${week}.</p></div>${changes}</section>
      <section class="section"><div class="section-head"><h2>Slot by slot</h2><p>Your best lineup against ${oppName ? `${esc(oppName)}'s best` : "no opponent"}. Out, IR and suspended players count 0; players without a game ${sp.sport === "nfl" ? "(byes)" : ""} count 0.</p></div>${table}</section>
      ${notes.length ? `<section class="section"><div class="section-head"><h2>What decides it</h2></div><ul class="notes">${notes.map((n) => `<li>${n}</li>`).join("")}</ul></section>` : ""}
      <section class="section"><div class="section-head"><h2>Your bench</h2>
        <p>Everyone not in your best lineup, by projection, with the slots he can fill and how far he is from the weakest starter there. IR and taxi players aren't listed.</p></div>
        ${benchTable(benchIds, res.me.best, true)}</section>
      ${oppRoster ? `<details class="srcs card"><summary><strong>${esc(oppName)}'s bench</strong> <span class="muted">(${theirBenchIds.length})</span></summary>${benchTable(theirBenchIds, res.them.best, false)}</details>` : ""}
      <p class="small muted">Projections: Sleeper, week ${week}, refreshed ${esc(new Date(proj.updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} (twice a day). Win chance assumes both teams start their best lineup.</p>`;
  };

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
      // Your position counts that change, against the depth you aim to carry.
      if (t.shape && t.shape.length) {
        why.push(`<span>Your roster: ${t.shape.map((c) => `${esc(fmt.group(c.group))} ${c.before} → ${c.after} <span class="muted">(aim ${c.target})</span>`).join(", ")}</span>`);
      }
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
