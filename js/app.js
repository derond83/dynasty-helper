// App shell: league list, navigation, the Leagues page, and loading a league for its sport view.
(function () {
  "use strict";
  const DH = window.DH;
  const { esc } = DH.fmt;
  const S = DH.sleeper;
  const $ = (sel) => document.querySelector(sel);
  const SPORT_NAMES = { nfl: "football", nba: "basketball" };

  // ---------- League list ----------
  // Everyone has one list of leagues they added. Leagues in leagues.json also ship a daily snapshot,
  // so they open instantly and even when Sleeper can't be reached.
  const SNAPSHOT_IDS = new Set((window.HOME_LEAGUES || []).map((l) => l.id));

  // Before this list existed, the leagues in leagues.json were shown to every visitor. Keep them for
  // browsers that were already using the app (with any season renewals they followed); new visitors
  // start with an empty list.
  (function migrateList() {
    if (DH.store.get("listV2", false)) return;
    let keys = [];
    try { keys = Object.keys(localStorage); } catch (e) { /* storage blocked */ }
    const used = keys.some((k) => /^(dh\.(?!listV2)|dynasty-helper\.|assoc-waivers\.)/.test(k));
    if (used) {
      const renamed = DH.store.get("renamed", {});
      const home = (window.HOME_LEAGUES || []).map((l) => (renamed[l.id] ? { ...l, ...renamed[l.id] } : { ...l }));
      const ids = new Set(home.map((l) => l.id));
      DH.store.set("leagues", home.concat(DH.store.get("leagues", []).filter((l) => !ids.has(l.id))));
      DH.store.del("renamed");
    }
    DH.store.set("listV2", true);
  })();
  DH.migrateOldSettings();

  function leagueList() {
    return DH.store.get("leagues", []).filter((l) => DH.sports[l.sport]).map((l) => ({ ...l, snapshot: SNAPSHOT_IDS.has(l.id) }));
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
        // If the renewed league is already in the list, just drop the old one.
        const known = leagueList().some((l) => l.id === next.league_id);
        DH.store.set("leagues", DH.store.get("leagues", []).flatMap((l) => (l.id !== entry.id ? [l] : known ? [] : [{ ...l, ...fresh }])));
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
    if (h === "how") return { page: "how" };
    const sync = h.match(/^sync\/([A-Za-z0-9_-]+)$/);
    if (sync) return { page: "sync", key: sync[1] };
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
    for (const [id, page] of [["#manage-link", "leagues"], ["#how-link", "how"]]) {
      if (activeId === page) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
    }
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
    // Tabs that were renamed or merged: Players is now part of Team.
    const RENAMED = { players: "team" };
    const pick = (t) => (t && sport.tabs.some((x) => x.id === (RENAMED[t] || t)) ? RENAMED[t] || t : null);
    const tabId = pick(tab) || pick(DH.store.league(entry.id).get("tab", null)) || sport.tabs[0].id;
    if (tab && tab !== tabId) history.replaceState(null, "", `#/${entry.id}/${tabId}`);
    DH.store.set("last", entry.id);
    DH.store.league(entry.id).set("tab", tabId);
    document.title = `${entry.name} · Front Office`;
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
    live.catch(() => { /* handled below; this page may also be left before it settles */ });
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
    document.title = "Leagues · Front Office";
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

    const welcome = !list.length ? `<section class="card section welcome">
        <h2>Welcome to Front Office</h2>
        <p>Waiver, trade, lineup and rookie-draft advice for your <strong>Sleeper dynasty</strong> football and basketball leagues, using KeepTradeCut, Dynasty Daddy, Hashtag Basketball and Sleeper's projections, scored with your league's own settings.</p>
        <p class="small"><a href="#/how">How it works</a> explains where the numbers come from.</p>
        <ol class="steps"><li>Enter your Sleeper username below.</li><li>Add your dynasty leagues with one click.</li><li>Open a league. It starts on your team.</li></ol>
        <p class="small muted">Already use it on another device? Open your <strong>sync link</strong> from that device's Leagues page here, and your leagues and settings come with it.</p>
      </section>` : "";

    $("#main").innerHTML = `${noticeHtml()}<div class="stack leagues-page">
      <header class="top"><div class="brand"><span class="eyebrow">Front Office</span><h1>Leagues</h1></div></header>
      ${welcome}
      <section class="card section">
        <div class="section-head"><h2>Your Sleeper account</h2>
          <p>With your username, every league opens on your team, your leagues are listed below for one-click adding, and leagues are followed when Sleeper starts a new season. Only Sleeper's public API is asked; no password is needed.</p></div>
        <form class="inline-form" data-user-form>
          <label class="field"><span>Sleeper username</span><input type="text" name="username" autocomplete="username" spellcheck="false" value="${esc(u ? u.username : "")}" placeholder="Your Sleeper username"></label>
          <button type="submit" class="more primary">${u ? "Update" : "Find my leagues"}</button>
          ${u ? '<button type="button" class="more" data-forget>Forget</button>' : ""}
        </form>
        <p class="form-msg" data-user-msg role="status">${u ? `Using <strong>${esc(u.display_name)}</strong>.` : ""}</p>
        ${foundHtml}
      </section>

      ${list.length ? `<section class="card section">
        <div class="section-head"><h2>Your leagues</h2><p>Leagues load live from Sleeper each time you open them. Leagues with a daily snapshot open instantly, even when Sleeper can't be reached.</p></div>
        <ul class="lrows">${list.map((l) => row({ ...l, meta: `${DH.sports[l.sport].label} · ${l.season}${l.snapshot ? " · daily snapshot" : ""}` },
          `<a class="more" href="#/${esc(l.id)}">Open</a><button type="button" class="more" data-remove="${esc(l.id)}" aria-label="Remove ${esc(l.name)}">Remove</button>`)).join("")}</ul>
      </section>` : ""}

      <section class="card section">
        <div class="section-head"><h2>Add by league ID</h2>
          <p>Any Sleeper dynasty football or basketball league. The ID is the long number in the league's Sleeper web address. Redraft, keeper and guillotine leagues aren't supported.</p></div>
        <form class="inline-form" data-id-form>
          <label class="field"><span>League ID</span><input type="text" name="league" inputmode="numeric" pattern="[0-9]*" spellcheck="false" placeholder="e.g. 1312071895943745536"></label>
          <button type="submit" class="more primary">Add league</button>
        </form>
        <p class="form-msg" data-id-msg role="status"></p>
      </section>

      <section class="card section" data-sync-section>${syncHtml()}</section>

      <section class="section about">
        <div class="section-head"><h2>About your data</h2></div>
        <p class="small muted">League data comes straight from Sleeper's public API to your browser. What the app saves: your Sleeper username and user ID, the leagues you added, your team in each, locked players and Settings choices. It's kept in this browser and, with sync on, in one copy on Cloudflare filed under a random sync key that only your devices know. No email, password or name is collected, and nothing is shared with other people. Turn sync off or delete the synced copy above at any time.</p>
        <p class="small muted">App version ${esc(DH.version)}. A new version can take up to 10 minutes to show up after it's released; a hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac) loads it right away.</p>
      </section>
    </div>`;
  }

  // ---------- Sync ----------
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : new Date(t).toLocaleDateString();
  };
  function syncStatusText() {
    const st = DH.sync.status();
    if (st.state === "saving") return "Syncing…";
    if (st.state === "error") return `Couldn't reach the sync service (${esc(st.error)}). Your changes are kept in this browser and will sync when it's back.`;
    return st.at ? `Synced ${ago(st.at)}.` : "On. Your settings will sync after your next change.";
  }
  function syncHtml() {
    const off = (() => { try { return !!localStorage.getItem("dhx.syncOff"); } catch (e) { return false; } })();
    const head = `<div class="section-head"><h2>Sync across devices</h2>
      <p>Your leagues, team picks, locked players and Settings follow you to your phone, tablet or another browser. Open your sync link on the other device once; after that, changes on either one show up on the other.</p></div>`;
    const joinForm = `<form class="inline-form" data-join-form>
        <label class="field"><span>Have a sync link from another device?</span><input type="text" name="link" spellcheck="false" autocomplete="off" placeholder="Paste the sync link"></label>
        <button type="submit" class="more">Use it here</button></form><p class="form-msg" data-join-msg role="status"></p>`;
    if (!DH.sync.enabled()) {
      return `${head}<p class="sync-status" data-sync-status>${off ? "Sync is off in this browser." : "Sync turns on by itself once you add a league or change a setting."}</p>
        ${off ? '<div class="toolbar"><button type="button" class="more primary" data-sync-on>Turn sync on</button></div>' : ""}${joinForm}`;
    }
    return `${head}<p class="sync-status" data-sync-status>${syncStatusText()}</p>
      <div class="toolbar">
        <button type="button" class="more primary" data-sync-copy>Copy sync link</button>
        ${navigator.share ? '<button type="button" class="more" data-sync-share>Send to my other device</button>' : ""}
        <span class="form-msg small" data-sync-msg role="status"></span>
      </div>
      <p class="small muted">The link works like a password for your settings: anyone who opens it can see and change them. Send it only to yourself.</p>
      ${joinForm}
      <details class="srcs"><summary>Stop syncing</summary>
        <div class="toolbar"><button type="button" class="more" data-sync-stop>Stop syncing in this browser</button>
        <button type="button" class="more danger" data-sync-erase>Delete the synced copy everywhere</button></div>
        <p class="small muted">Stopping keeps everything in this browser and leaves the synced copy for your other devices. Deleting removes the synced copy; each browser keeps what it has.</p>
      </details>`;
  }
  DH.sync.subscribe(() => {
    const el = document.querySelector("[data-sync-status]");
    if (el && DH.sync.enabled()) el.innerHTML = syncStatusText();
  });
  const redrawSync = () => { const el = document.querySelector("[data-sync-section]"); if (el) el.innerHTML = syncHtml(); };

  // Opening a sync link: confirm, then bring that device's settings here.
  function syncPage(k) {
    ++current;
    document.title = "Sync · Front Office";
    drawNav(null);
    const have = leagueList().length;
    const same = DH.sync.enabled() && DH.sync.link() && DH.sync.link().endsWith(`/sync/${k}`);
    $("#main").innerHTML = `<div class="stack leagues-page">
      <header class="top"><div class="brand"><span class="eyebrow">Front Office</span><h1>Sync this device</h1></div></header>
      <section class="card section">
        ${!DH.sync.validKey(k) ? `<p>That sync link isn't complete. Copy it again from the other device's Leagues page.</p><p><a href="#/leagues">Go to Leagues</a></p>`
        : same ? `<p>This browser already uses this sync link.</p><p><a href="#/">Open the app</a></p>`
        : `<p>Bring the leagues and settings from your other device to this browser, and keep the two in sync from now on.</p>
          ${have ? `<p><strong>This browser's own leagues and settings (${have} league${have > 1 ? "s" : ""}) will be replaced.</strong></p>` : ""}
          <div class="toolbar"><button type="button" class="more primary" data-join="${esc(k)}">Sync this device</button><a class="more" href="#/leagues">Cancel</a></div>
          <p class="form-msg" data-join-msg role="status"></p>`}
      </section></div>`;
  }
  async function joinWith(k, msg) {
    msg.textContent = "Fetching your settings…";
    try { await DH.sync.join(k); } catch (err) { msg.textContent = /Failed to fetch|NetworkError/.test(err.message) ? "Couldn't reach the sync service. Check your connection and try again." : err.message; return false; }
    DH.store.set("listV2", true);
    found = null;
    location.replace("#/");
    render();
    return true;
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
    if (form.matches("[data-join-form]")) {
      e.preventDefault();
      const msg = $("[data-join-msg]");
      const m = form.link.value.trim().match(/(?:#\/sync\/)?([A-Za-z0-9_-]{32,64})\s*$/);
      if (!m) { msg.textContent = "That doesn't look like a sync link. Copy it from the other device's Leagues page."; return; }
      if (leagueList().length && !confirm("Replace this browser's leagues and settings with the ones from your other device?")) return;
      await joinWith(m[1], msg);
      return;
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
    if (b.dataset.join) { b.disabled = true; if (!(await joinWith(b.dataset.join, $("[data-join-msg]")))) b.disabled = false; }
    const syncMsg = (t) => { const m = $("[data-sync-msg]"); if (m) m.textContent = t; };
    if (b.hasAttribute("data-sync-copy")) {
      try { await navigator.clipboard.writeText(DH.sync.link()); syncMsg("Copied. Open it on your other device."); }
      catch (err) { prompt("Copy your sync link:", DH.sync.link()); }
    }
    if (b.hasAttribute("data-sync-share")) {
      try { await navigator.share({ title: "Front Office sync link", url: DH.sync.link() }); } catch (err) { /* cancelled */ }
    }
    if (b.hasAttribute("data-sync-on")) { DH.sync.resume(); redrawSync(); }
    if (b.hasAttribute("data-sync-stop")) { DH.sync.stop(); redrawSync(); }
    if (b.hasAttribute("data-sync-erase")) {
      if (!confirm("Delete the synced copy of your settings? Each device keeps what it has now, but they stop syncing.")) return;
      try { await DH.sync.erase(); redrawSync(); } catch (err) { syncMsg(`Couldn't delete it (${err.message}). Try again.`); }
    }
  }

  // ---------- Router ----------
  function render() {
    const r = route();
    if (r.page === "sync") return syncPage(r.key);
    if (r.page === "how") {
      ++current;
      document.title = "How it works · Front Office";
      drawNav("how");
      $("#main").innerHTML = DH.howHtml();
      window.scrollTo(0, 0);
      return;
    }
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

  // Settings that arrive from another device: redraw with them (a league page reloads its league).
  DH.sync.onRemoteChange = () => { if (route().page !== "sync") render(); };
  DH.sync.start();

  document.addEventListener("submit", onSubmit);
  document.addEventListener("click", onClick);
  window.addEventListener("hashchange", render);
  render();
  followRenewals().then((m) => { if (m.length) { notices = m; render(); } }).catch(() => { /* offline */ });
})();
