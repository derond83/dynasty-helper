// Sleeper's public API, as the app uses it. Sleeper allows browser requests.
(function (root) {
  "use strict";
  const DH = (root.DH = root.DH || {});
  const BASE = "https://api.sleeper.app/v1";

  async function get(path, { timeout = 20000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(BASE + path, { signal: ctl.signal });
      if (!r.ok) throw new Error(`Sleeper ${path}: HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  const stateCache = {};
  const state = (sport) => (stateCache[sport] = stateCache[sport] || get(`/state/${sport}`).catch((e) => { delete stateCache[sport]; throw e; }));

  /** Everything a league page needs that changes during the season. */
  async function leagueData(id, sport, fallback) {
    const [league, users, rosters, st, trending] = await Promise.all([
      get(`/league/${id}`), get(`/league/${id}/users`), get(`/league/${id}/rosters`),
      state(sport).catch(() => fallback && fallback.state),
      get(`/players/${sport}/trending/add?lookback_hours=48&limit=100`).catch(() => (fallback && fallback.trending) || []),
    ]);
    // The league's current draft: a pending rookies-only draft gets its own Draft tab.
    let draft = null;
    if (league.draft_id) {
      try {
        const [d, traded] = await Promise.all([get(`/draft/${league.draft_id}`), get(`/draft/${league.draft_id}/traded_picks`)]);
        draft = { ...d, rounds: d.settings && d.settings.rounds, player_type: d.settings && d.settings.player_type, traded_picks: traded };
      } catch (e) { draft = fallback ? fallback.draft : null; }
    }
    return {
      league, rosters, state: st, trending, draft,
      users: users.map((u) => ({ user_id: u.user_id, display_name: u.display_name, team_name: (u.metadata || {}).team_name })),
      fetched: new Date().toISOString(),
    };
  }

  /** Sleeper player records for ids the bundled player list doesn't have (~5 MB for NFL, so only when needed). */
  async function missingPlayers(sport, ids) {
    if (!ids.length) return {};
    const all = await get(`/players/${sport}`, { timeout: 60000 });
    const out = {};
    for (const id of ids) {
      const p = all[id];
      if (p) out[id] = { ...p, full_name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") };
    }
    return out;
  }

  const user = (name) => get(`/user/${encodeURIComponent(name)}`);
  const league = (id) => get(`/league/${encodeURIComponent(id)}`);

  /** A user's leagues for a sport's current Sleeper season (the season the app's "now" is). */
  async function userLeagues(userId, sport) {
    const st = await state(sport);
    const season = st.league_season || st.season;
    return { season, leagues: (await get(`/user/${userId}/leagues/${sport}/${season}`)) || [] };
  }

  DH.sleeper = { get, state, leagueData, missingPlayers, user, league, userLeagues };
})(typeof window !== "undefined" ? window : globalThis);
