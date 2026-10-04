// App shell: league list, navigation, the Leagues page, and loading a league for its sport view.
(function () {
  "use strict";
  const DH = window.DH;
  const { esc } = DH.fmt;
  const S = DH.sleeper;
  const $ = (sel) => document.querySelector(sel);
  const SPORT_NAMES = { nfl: "football", nba: "basketball" };

  DH.migrateOldSettings();

  // ---------- League list ----------
  // Built-in leagues ship with a daily snapshot; imported ones live in this browser only.
  // "renamed" maps a league to the id it renewed into for a new Sleeper season.
  function leagueList() {
    const renamed = DH.store.get("renamed", {});
    const home = (window.HOME_LEAGUES || []).map((l) => {
      const r = renamed[l.id];
      return r ? { ...l, ...r, builtin: true, snapshot: false } : { ...l, builtin: true, snapshot: true };
    });
    const seen = new Set(home.map((l) => l.id));
    const imported = DH.store.get("leagues", []).filter((l) => !seen.has(l.id) && DH.sports[l.sport]);
    return home.concat(imported);
  }
  const findLeague = (id) => leagueList().find((l) => l.id === id);

  function addLeague(league) {
    const list = DH.store.get("leagues", []).filter((l) => l.id !== league.league_id);
    list.push({ id: league.league_id, sport: league.sport, name: league.name, season: league.season });
    DH.store.set("leagues", list);
  }
  function removeLeague(id) {
    DH.store.set("leagues", DH.store.get("leagues", []).filter((l) => l.id !== id));
  }

  /** Why a Sleeper league can't be added, or null if it can. */
  function rejection(league) {
    if (!league) return "No Sleeper league has that ID.";
    if (!DH.sports[league.sport]) return `That's a ${esc(league.sport)} league. Only football and basketball leagues are supported.`;
    const type = DH.leagueType(league);
    if (type !== "dynasty") return `Only dynasty leagues can be added. ${esc(league.name)} is a ${type} league.`;
    return null;
  }

  // ---------- Your Sleeper account ----------
  const user = () => DH.store.get("user", null);
  const ownsRoster = (r, uid) => uid && (r.owner_id === uid || (r.co_owners || []).includes(uid));

  // A dynasty league gets a new id each Sleeper season. Follow your leagues to their new ids.
  async function followRenewals() {
    const u = user();
    if (!u) return [];
    const moved = [];
    for (const sport of Object.keys(DH.sports)) {
      const mine = leagueList().filter((l) => l.sport === sport);
      if (!mine.length) continue;
      let found;
      try { found = await S.userLeagues(u.user_id, sport); } catch (e) { continue; }
      for (const entry of mine) {
        if (found.leagues.some((l) => l.league_id === entry.id)) continue;
        const next = found.leagues.find((l) => l.previous_league_id === entry.id);
        if (!next) continue;
        DH.store.moveLeague(entry.id, next.league_id);
        DH.store.set("moved", { ...DH.store.get("moved", {}), [entry.id]: next.league_id });
        const fresh = { id: next.league_id, name: next.name, season: next.season };
        if (entry.builtin) {
          const renamed = DH.store.get("renamed", {});
          const origin = (window.HOME_LEAGUES || []).find((h) => h.id === entry.id || (renamed[h.id] && renamed[h.id].id === entry.id));
          if (origin) { renamed[origin.id] = fresh; DH.store.set("renamed", renamed); }
        } else {
          // If the renewed league is already in the list (e.g. built in), just drop the old one.
          const known = leagueList().some((l) => l.id === next.league_id);
          DH.store.set("leagues", DH.store.get("leagues", []).flatMap((l) => (l.id !== entry.id ? [l] : known ? [] : [{ ...l, ...fresh }])));
        }
        if (DH.store.get("last") === entry.id) DH.store.set("last", next.league_id);
        moved.push(`${next.name} moved to its ${next.season} season.`);
      }
    }
    return moved;
  }

  // ---------- Navigation ----------
  function route() {
    const h = location.hash.replace(/^#\/?/, "");
    if (h === "leagues") return { page: "leagues" };
    const [id, tab] = h.split("/");
    if (id && /^\d+$/.test(id)) return { page: "league", id, tab };
    return { page: "home" };
  }

  function drawNav(activeId) {
    const list = leagueList();
    const tabs = list.map((l) => {
      const team = DH.store.league(l.id).get("teamName", "");
      return `<a class="ltab" href="#/${esc(l.id)}"${l.id === activeId ? ' aria-current="page"' : ""}>
        <span class="sport-badge" data-sport="${esc(l.sport)}">${esc(DH.sports[l.sport].short)}</span>
        <span class="ltab-text"><span class="lname">${esc(l.name)}</span>${team ? `<span class="lteam">${esc(team)}</span>` : ""}</span></a>`;
    }).join("");
    $("#league-tabs").innerHTML = tabs + `<a class="ltab add" href="#/leagues"${activeId === "leagues" ? ' aria-current="page"' : ""}><span aria-hidden="true">＋</span> Add league</a>`;
    if (activeId === "leagues") $("#manage-link").setAttribute("aria-current", "page");
    else $("#manage-link").removeAttribute("aria-current");
    const cur = $("#league-tabs [aria-current]");
    if (cur) cur.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  let notices = [];
  function noticeHtml() {
    return notices.length ? `<div class="banner" role="status"><span>${notices.map(esc).join(" ")}</span></div>` : "";
  }

  // ---------- League page ----------
  let current = 0; // bumps on every navigation, so late responses for an old page are ignored
  const extraPlayers = {}; // per sport: players fetched live because the bundled list lacked them

  async function openLeague(entry, tab) {
    const token = ++current;
    const sport = DH.sports[entry.sport];
    const tabId = sport.tabs.some((t) => t.id === tab) ? tab : (DH.store.league(entry.id).get("tab", "moves"));
    DH.store.set("last", entry.id);
    DH.store.league(entry.id).set("tab", tabId);
    document.title = `${entry.name} · Dynasty Helper`;
    drawNav(entry.id);
    const main = $("#main");
    main.innerHTML = `${noticeHtml()}<div class="loading" role="status"><span class="sport-badge" data-sport="${esc(entry.sport)}">${esc(sport.short)}</span> Loading ${esc(entry.name)}…</div>`;

    let snapshot = null;
    if (entry.snapshot) {
      try {
        await DH.loadScript(`data/leagues/${entry.id}.js`);
        snapshot = (window.LEAGUE_SNAPSHOTS || {})[entry.id] || null;
      } catch (e) { snapshot = null; }
    }
    const live = S.leagueData(entry.id, entry.sport, snapshot);
    let base, source = "snapshot";
    if (snapshot) base = snapshot;
    else {
      try { base = await live; source = "live"; } catch (e) {
        if (token !== current) return;
        main.innerHTML = `${noticeHtml()}<div class="empty">Couldn't load ${esc(entry.name)} from Sleeper (${esc(e.message)}). Check your connection and <a href="#/${esc(entry.id)}" data-retry>try again</a>.</div>`;
        return;
      }
    }
    try { await Promise.all(sport.files(base.league).map(DH.loadScript)); } catch (e) {
      if (token !== current) return;
      main.innerHTML = `<div class="empty">${esc(e.message)}. Reload the page to try again.</div>`;
      return;
    }
    if (token !== current) return;

    const el = document.createElement("div");
    el.className = "stack league-page";
    main.innerHTML = noticeHtml();
    main.appendChild(el);
    const store = DH.store.league(entry.id);
    const ctx = { id: entry.id, entry, tab: tabId, store, el };

    const withPlayers = (d) => ({ ...d, players: { ...(window[sport.playersGlobal] || {}), ...(extraPlayers[entry.sport] || {}) } });
    function pickTeam() {
      const ids = ctx.data.rosters.map((r) => String(r.roster_id));
      const saved = store.get("team", null);
      const u = user();
      const mine = u && ctx.data.rosters.find((r) => ownsRoster(r, u.user_id));
      if (saved != null && ids.includes(String(saved))) { ctx.rosterId = String(saved); ctx.teamGuessed = false; }
      else if (mine) { ctx.rosterId = String(mine.roster_id); ctx.teamGuessed = false; }
      else { ctx.rosterId = ids[0]; ctx.teamGuessed = true; }
    }
    function draw() {
      sport.render(ctx, el);
      const name = DH.teamName(ctx.data, ctx.rosterId);
      if (!ctx.teamGuessed && store.get("teamName", "") !== name) { store.set("teamName", name); drawNav(entry.id); }
    }
    ctx.rerender = draw;
    ctx.setTeam = (v) => { store.set("team", String(v)); ctx.rosterId = String(v); ctx.teamGuessed = false; draw(); };
    ctx.data = withPlayers(base);
    ctx.source = source;
    ctx.fetched = base.fetched;
    pickTeam();
    draw();

    // Upgrade a snapshot to live data, and fill in any rostered player the bundled list lacks.
    const upgrade = async (d) => {
      if (token !== current) return;
      ctx.data = withPlayers(d); ctx.source = "live"; ctx.fetched = d.fetched;
      pickTeam(); draw();
      const missing = [...new Set(d.rosters.flatMap((r) => r.players || []))].filter((id) => !ctx.data.players[id]);
      if (!missing.length) return;
      try {
        extraPlayers[entry.sport] = { ...(extraPlayers[entry.sport] || {}), ...(await S.missingPlayers(entry.sport, missing)) };
        if (token === current) { ctx.data = withPlayers(d); draw(); }
      } catch (e) { /* those players show by id */ }
    };
    if (source === "snapshot") live.then(upgrade).catch(() => { /* blocked or offline: keep the snapshot */ });
    else upgrade(base);
  }

  // ---------- Leagues page ----------
  let found = null; // { sport: { season, leagues } } for the saved username

  function leaguesPage() {
    ++current;
    document.title = "Leagues · Dynasty Helper";
    drawNav("leagues");
    const u = user();
    const list = leagueList();
    const ids = new Set(list.map((l) => l.id));
    const row = (l, actions) => `<li class="lrow">
        <span class="sport-badge" data-sport="${esc(l.sport)}">${esc((DH.sports[l.sport] || { short: l.sport.toUpperCase() }).short)}</span>
        <span class="lrow-text"><span class="lname">${esc(l.name)}</span><span class="muted small">${esc(l.meta)}</span></span>
        <span class="lrow-actions">${actions}</span></li>`;

    let foundHtml = "";
    if (u && found) {
      const items = Object.entries(found).flatMap(([sport, f]) => f.leagues.map((l) => ({ ...l, sportKey: sport })));
      foundHtml = items.length ? `<ul class="lrows">${items.map((l) => {
        const why = rejection(l);
        const meta = `${l.season} ${DH.leagueType(l)} · ${l.total_rosters} teams`;
        const action = ids.has(l.league_id) ? `<a class="more" href="#/${esc(l.league_id)}">Open</a>`
          : why ? `<span class="muted small" title="${esc(why.replace(/<[^>]+>/g, ""))}">Not dynasty</span>`
          : `<button type="button" class="more primary" data-add="${esc(l.league_id)}">Add</button>`;
        return row({ sport: l.sport, name: l.name, meta }, action);
      }).join("")}</ul>` : `<p class="muted">No football or basketball leagues found for ${esc(u.display_name)} this season.</p>`;
    } else if (u) foundHtml = '<p class="muted" role="status">Looking up your leagues…</p>';

    $("#main").innerHTML = `${noticeHtml()}<div class="stack leagues-page">
      <header class="top"><div class="brand"><span class="eyebrow">Dynasty Helper</span><h1>Leagues</h1></div></header>

      <section class="card section">
        <div class="section-head"><h2>Your Sleeper account</h2>
          <p>Optional. With your username, every league opens on your team, your leagues are listed below for one-click adding, and leagues are followed when Sleeper starts a new season. Nothing is sent anywhere but Sleeper's public API, and it's saved only in this browser.</p></div>
        <form class="inline-form" data-user-form>
          <label class="field"><span>Sleeper username</span><input type="text" name="username" autocomplete="username" spellcheck="false" value="${esc(u ? u.username : "")}" placeholder="e.g. Aubergines"></label>
          <button type="submit" class="more primary">${u ? "Update" : "Find my leagues"}</button>
          ${u ? '<button type="button" class="more" data-forget>Forget</button>' : ""}
        </form>
        <p class="form-msg" data-user-msg role="status">${u ? `Using <strong>${esc(u.display_name)}</strong>.` : ""}</p>
        ${foundHtml}
      </section>

      <section class="card section">
        <div class="section-head"><h2>Add by league ID</h2>
          <p>Any Sleeper dynasty football or basketball league. The ID is the long number in the league's Sleeper web address. Redraft, keeper and guillotine leagues aren't supported.</p></div>
        <form class="inline-form" data-id-form>
          <label class="field"><span>League ID</span><input type="text" name="league" inputmode="numeric" pattern="[0-9]*" spellcheck="false" placeholder="e.g. 1312071895943745536"></label>
          <button type="submit" class="more primary">Add league</button>
        </form>
        <p class="form-msg" data-id-msg role="status"></p>
      </section>

      <section class="card section">
        <div class="section-head"><h2>Your leagues</h2><p>Built-in leagues have a daily snapshot, so they open even when Sleeper can't be reached. Leagues you add are saved in this browser.</p></div>
        <ul class="lrows">${list.map((l) => row({ ...l, meta: `${DH.sports[l.sport].label} · ${l.season} · ${l.builtin ? "built in" : "added in this browser"}` },
          `<a class="more" href="#/${esc(l.id)}">Open</a>${l.builtin ? "" : `<button type="button" class="more" data-remove="${esc(l.id)}" aria-label="Remove ${esc(l.name)}">Remove</button>`}`)).join("")}</ul>
      </section>
    </div>`;
  }

  async function loadFound() {
    const u = user();
    if (!u) { found = null; return; }
    const out = {};
    for (const sport of Object.keys(DH.sports)) {
      try { out[sport] = await S.userLeagues(u.user_id, sport); } catch (e) { out[sport] = { leagues: [] }; }
    }
    found = out;
  }

  async function onSubmit(e) {
    const form = e.target;
    if (form.matches("[data-user-form]")) {
      e.preventDefault();
      const name = form.username.value.trim();
      const msg = $("[data-user-msg]");
      if (!name) { msg.textContent = "Enter your Sleeper username."; return; }
      msg.textContent = "Looking up…";
      let u;
      try { u = await S.user(name); } catch (err) { msg.textContent = `Couldn't reach Sleeper (${err.message}).`; return; }
      if (!u || !u.user_id) { msg.textContent = `No Sleeper user named “${name}”.`; return; }
      DH.store.set("user", { username: name, user_id: u.user_id, display_name: u.display_name || name });
      found = null;
      leaguesPage();
      await loadFound();
      if (route().page === "leagues") leaguesPage();
      followRenewals().then((m) => { if (m.length) { notices = m; render(); } });
    }
    if (form.matches("[data-id-form]")) {
      e.preventDefault();
      const id = form.league.value.trim().replace(/\D/g, "");
      const msg = $("[data-id-msg]");
      if (!id) { msg.textContent = "Enter a league ID (numbers only)."; return; }
      if (id.length < 15) { msg.textContent = "That doesn't look like a Sleeper league ID. It's the long number (18 digits or so) in the league's web address."; return; }
      if (findLeague(id)) { location.hash = `#/${id}`; return; }
      msg.textContent = "Checking with Sleeper…";
      let league;
      try { league = await S.league(id); } catch (err) { msg.textContent = /HTTP 404/.test(err.message) ? "No Sleeper league has that ID." : `Couldn't reach Sleeper (${err.message}).`; return; }
      const why = rejection(league);
      if (why) { msg.innerHTML = why; return; }
      addLeague(league);
      location.hash = `#/${id}`;
    }
  }

  async function onClick(e) {
    const b = e.target.closest("button, a[data-retry]");
    if (!b) return;
    if (b.dataset.add) {
      b.disabled = true; b.textContent = "Adding…";
      try {
        const league = await S.league(b.dataset.add);
        const why = rejection(league);
        if (why) { b.textContent = "Can't add"; b.title = why; return; }
        addLeague(league);
        location.hash = `#/${league.league_id}`;
      } catch (err) { b.disabled = false; b.textContent = "Try again"; }
    }
    if (b.dataset.remove) { removeLeague(b.dataset.remove); leaguesPage(); }
    if (b.hasAttribute("data-forget")) { DH.store.del("user"); found = null; leaguesPage(); }
    if (b.hasAttribute("data-retry")) { e.preventDefault(); render(); }
  }

  // ---------- Router ----------
  function render() {
    const r = route();
    if (r.page === "leagues") {
      leaguesPage();
      if (user() && !found) loadFound().then(() => { if (route().page === "leagues") leaguesPage(); });
      return;
    }
    const list = leagueList();
    if (r.page === "league") {
      const entry = findLeague(r.id);
      if (entry) return openLeague(entry, r.tab);
      const moved = DH.store.get("moved", {})[r.id];
      if (moved && findLeague(moved)) { location.replace(`#/${moved}${r.tab ? "/" + r.tab : ""}`); return; }
      // Not in your list: offer to add it rather than failing silently.
      location.replace("#/leagues");
      setTimeout(() => {
        const input = document.querySelector("[data-id-form] input");
        if (input) { input.value = r.id; input.focus(); }
      });
      return;
    }
    const last = DH.store.get("last", null);
    const entry = list.find((l) => l.id === last) || list[0];
    if (entry) location.replace(`#/${entry.id}`);
    else location.replace("#/leagues");
  }

  document.addEventListener("submit", onSubmit);
  document.addEventListener("click", onClick);
  window.addEventListener("hashchange", render);
  render();
  followRenewals().then((m) => { if (m.length) { notices = m; render(); } }).catch(() => { /* offline */ });
})();
