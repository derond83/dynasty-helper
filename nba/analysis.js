// Roster + waiver analysis for a Sleeper NBA league, driven by
// Hashtag Basketball dynasty rankings. Pure functions; no DOM.
(function (root) {
  "use strict";

  const GROUPS = ["G", "F", "C"];
  const POS_GROUP = { PG: "G", SG: "G", G: "G", SF: "F", PF: "F", F: "F", C: "C" };
  // Hashtag Basketball team codes that differ from Sleeper's.
  const HB_TEAM = { GS: "GSW", NO: "NOP", NY: "NYK", PHO: "PHX", SA: "SAS" };
  // Names that differ beyond a first-name prefix (Alex/Alexandre, Nic/Nicolas).
  const ALIASES = { "carlton carrington": "bub carrington" };
  const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

  // How strongly positional need lifts a player above their raw dynasty value.
  const NEED_WEIGHT = 0.6;
  // A swap must add at least this much dynasty value to be worth the churn
  // (about 12 ranking spots in the 100–250 range).
  const MIN_SWAP_GAIN = 1.12;

  function norm(s) {
    return (s || "")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z ]/g, "")
      .split(/\s+/).filter((w) => w && !SUFFIXES.has(w)).join(" ");
  }

  // Dynasty value on a 0–100 scale. Steep at the top, as dynasty value is.
  function rankValue(rank) {
    return rank ? 100 * Math.exp(-(rank - 1) / 110) : 0;
  }

  function fantasyPoints(stats, scoring) {
    if (!stats || stats.PTS == null) return null;
    const s = scoring || {};
    return (stats.PTS || 0) * (s.pts || 0) + (stats.REB || 0) * (s.reb || 0) +
      (stats.AST || 0) * (s.ast || 0) + (stats.STL || 0) * (s.stl || 0) +
      (stats.BLK || 0) * (s.blk || 0) + (stats.TO || 0) * (s.to || 0) +
      (stats["3PM"] || 0) * (s.tpm || 0);
  }

  function matchRankings(rankings, players) {
    const byName = new Map(), byLast = new Map();
    const add = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
    for (const [id, p] of Object.entries(players)) {
      const n = norm(p.full_name);
      if (!n || /duplicate/.test(n)) continue;
      add(byName, n, id);
      add(byLast, n.split(" ").slice(1).join(" "), id);
    }
    const pick = (ids, team) => {
      const live = ids.filter((id) => players[id].active !== false);
      const pool = live.length ? live : ids;
      return pool.find((id) => players[id].team === team) ||
        (pool.length === 1 ? pool[0] : pool.find((id) => players[id].team) || pool[0]);
    };

    const byId = new Map(), unmatched = [];
    for (const r of rankings) {
      if (r.team === "DRA") continue; // draft-pick placeholders
      const team = HB_TEAM[r.team] || r.team;
      let n = norm(r.name);
      n = ALIASES[n] || n;
      let id = byName.has(n) ? pick(byName.get(n), team) : null;
      if (!id) {
        const parts = n.split(" "), first = parts[0], last = parts.slice(1).join(" ");
        const cands = (byLast.get(last) || []).filter((i) => {
          const f = norm(players[i].full_name).split(" ")[0];
          return players[i].active !== false && (f.startsWith(first) || first.startsWith(f));
        });
        if (cands.length) id = pick(cands, team);
      }
      if (id && !byId.has(id)) byId.set(id, r);
      else unmatched.push(r);
    }
    return { byId, unmatched };
  }

  function groupsFor(sleeperPlayer, hb) {
    const src = (sleeperPlayer && sleeperPlayer.fantasy_positions && sleeperPlayer.fantasy_positions.length)
      ? sleeperPlayer.fantasy_positions : (hb ? hb.pos : []);
    return GROUPS.filter((g) => src.some((p) => POS_GROUP[p] === g));
  }

  function slotEligible(info, slot) {
    if (slot === "UTIL") return true;
    const g = POS_GROUP[slot];
    if (!g) return false;
    if (slot === g) return info.groups.includes(g);
    return (info.positions || []).includes(slot); // PG/SG/SF/PF-specific slots
  }

  // Exact best lineup by dynasty value: DP over filled-slot bitmasks.
  function bestLineup(ids, info, slots) {
    const S = slots.length, size = 1 << S, n = ids.length;
    let dp = new Float64Array(size).fill(-1);
    dp[0] = 0;
    const parent = new Int8Array(n * size).fill(-1);
    ids.forEach((id, i) => {
      const p = info[id];
      const val = p.value + 0.01; // filling a slot beats leaving it empty
      const next = dp.slice();
      for (let mask = 0; mask < size; mask++) {
        if (dp[mask] < 0) continue;
        for (let s = 0; s < S; s++) {
          if (mask & (1 << s) || !slotEligible(p, slots[s])) continue;
          const nm = mask | (1 << s), v = dp[mask] + val;
          if (v > next[nm]) { next[nm] = v; parent[i * size + nm] = s; }
        }
      }
      dp = next;
    });
    let best = 0;
    for (let m = 0; m < size; m++) if (dp[m] > dp[best]) best = m;
    const assign = {};
    let mask = best;
    for (let i = n - 1; i >= 0; i--) {
      const s = parent[i * size + mask];
      if (s >= 0) { assign[ids[i]] = s; mask ^= 1 << s; }
    }
    let total = 0;
    for (const id in assign) total += info[id].value;
    return { assign, total };
  }

  function groupProfile(ids, info, starters) {
    const out = {};
    for (const g of GROUPS) {
      const elig = ids.filter((id) => info[id].groups.includes(g))
        .sort((a, b) => info[b].value - info[a].value);
      const top = elig.slice(0, starters[g]);
      out[g] = {
        depth: elig.length,
        strength: top.reduce((t, id) => t + info[id].value, 0),
        top,
      };
    }
    return out;
  }

  function needFor(profile, league, starters) {
    const needs = {};
    for (const g of GROUPS) {
      const avg = league[g].avg || 1;
      const target = starters[g] * 2;
      const strengthGap = Math.max(0, 1 - profile[g].strength / avg);
      const depthGap = Math.max(0, (target - profile[g].depth) / target);
      needs[g] = Math.min(1, strengthGap * 1.5 + depthGap);
    }
    return needs;
  }

  // Picks the given roster currently owns in a pending draft, in pick order.
  function ownedPicks(draft, teamsN, rosterId) {
    const slotToRoster = draft.slot_to_roster_id || {};
    const traded = (draft.traded_picks || []).filter((t) => String(t.season) === String(draft.season));
    const picks = [];
    for (let round = 1; round <= (draft.rounds || 0); round++) {
      for (let slot = 1; slot <= teamsN; slot++) {
        const orig = slotToRoster[slot];
        if (orig == null) continue;
        const pick = draft.type === "snake" && round % 2 === 0 ? teamsN + 1 - slot : slot;
        const t = traded.find((x) => x.round === round && x.roster_id === orig);
        const owner = t ? t.owner_id : orig;
        if (String(owner) === String(rosterId)) {
          picks.push({ round, pick, overall: (round - 1) * teamsN + pick, fromRoster: orig });
        }
      }
    }
    return picks.sort((a, b) => a.overall - b.overall);
  }

  function needLabel(need) {
    return need >= 0.4 ? "need" : need >= 0.15 ? "thin" : "solid";
  }

  /**
   * data: { league, users, rosters, players, trending }  (Sleeper shapes)
   * rankings: Hashtag Basketball player list
   * myRosterId: roster_id of the user's team
   */
  function analyze(data, rankings, myRosterId, options) {
    // Players the user has locked are never suggested as drops.
    const locked = new Set(((options && options.locked) || []).map(String));
    const { league, rosters, players } = data;
    const scoring = league.scoring_settings || {};
    const rp = league.roster_positions || [];
    const slots = rp.filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI");
    const maxActive = rp.filter((s) => s !== "IR" && s !== "TAXI").length;
    const starters = { G: 0, F: 0, C: 0 };
    for (const s of slots) if (POS_GROUP[s]) starters[POS_GROUP[s]]++;

    const { byId: hbById, unmatched } = matchRankings(rankings, players);
    const trending = new Map((data.trending || []).map((t) => [t.player_id, t.count]));

    const info = {};
    const describe = (id) => {
      if (info[id]) return info[id];
      const p = players[id] || {};
      const hb = hbById.get(id) || null;
      info[id] = {
        id,
        name: p.full_name || (hb && hb.name) || `Player ${id}`,
        team: p.team || (hb && hb.team) || "FA",
        positions: (p.fantasy_positions || []).filter((x) => POS_GROUP[x]),
        groups: groupsFor(p, hb),
        rank: hb ? hb.rank : null,
        value: rankValue(hb && hb.rank),
        age: hb && hb.age ? hb.age : p.age || null,
        injury: p.injury_status || null,
        move: hb ? hb.move : 0,
        fpg: hb ? fantasyPoints(hb.stats, scoring) : null,
        gp: hb ? hb.gp : null,
        outlook: hb ? hb.outlook : "",
        hbid: hb ? hb.hbid : null,
        trending: trending.get(id) || 0,
        searchRank: p.search_rank || 1e9,
        rookie: p.years_exp === 0,
      };
      return info[id];
    };

    const rostered = new Map();
    const teams = rosters.map((r) => {
      const reserve = new Set([...(r.reserve || []), ...(r.taxi || [])]);
      const all = (r.players || []).map(String);
      all.forEach((id) => { describe(id); rostered.set(id, r.roster_id); });
      const active = all.filter((id) => !reserve.has(id));
      return { roster: r, all, active, reserve: all.filter((id) => reserve.has(id)) };
    });
    for (const id of hbById.keys()) describe(id);

    // League-wide positional strength
    for (const t of teams) t.profile = groupProfile(t.active, info, starters);
    const leagueGroups = {};
    for (const g of GROUPS) {
      const vals = teams.map((t) => t.profile[g].strength).sort((a, b) => b - a);
      leagueGroups[g] = { avg: vals.reduce((a, b) => a + b, 0) / (vals.length || 1), best: vals[0] || 0, sorted: vals };
    }
    const leagueRank = (g, v) => leagueGroups[g].sorted.filter((x) => x > v + 1e-9).length + 1;

    const me = teams.find((t) => String(t.roster.roster_id) === String(myRosterId)) || teams[0];
    const lineup = bestLineup(me.active, info, slots);
    const lineupTotals = teams.map((t) => (t === me ? lineup : bestLineup(t.active, info, slots)).total);
    const lineupRank = lineupTotals.filter((v) => v > lineup.total + 1e-9).length + 1;
    const needs = needFor(me.profile, leagueGroups, starters);
    const positions = GROUPS.map((g) => ({
      group: g,
      starters: starters[g],
      target: starters[g] * 2,
      depth: me.profile[g].depth,
      strength: me.profile[g].strength,
      leagueAvg: leagueGroups[g].avg,
      leagueBest: leagueGroups[g].best,
      leagueRank: leagueRank(g, me.profile[g].strength),
      teams: teams.length,
      top: me.profile[g].top,
      need: needs[g],
      label: needLabel(needs[g]),
    }));

    // While a rookie-only draft is pending, unrostered rookies belong to the
    // draft, not the waiver wire.
    const draft = data.draft || null;
    const draftPending = !!draft && draft.player_type === 1 &&
      ["pre_draft", "drafting", "paused"].includes(draft.status);
    const available = [...hbById.keys()].filter((id) => !rostered.has(id)).map((id) => info[id]);
    const pool = available.filter((p) => !(draftPending && p.rookie));
    const rookiePool = draftPending ? available.filter((p) => p.rookie).sort((a, b) => a.rank - b.rank) : [];
    const myPicks = draftPending ? ownedPicks(draft, rosters.length, me.roster.roster_id) : [];

    const fitScore = (p, nd) =>
      p.value * (1 + NEED_WEIGHT * Math.max(0, ...p.groups.map((g) => nd[g])));

    // Weakest player whose loss keeps every position at least at starter depth.
    const dropFor = (cand, active, exclude) => {
      // Roster spots already spoken for by upcoming rookie picks aren't open.
      if (active.length + myPicks.length < maxActive) return { open: true };
      const order = active.filter((id) => !exclude.has(id)).sort((a, b) =>
        info[a].value - info[b].value || info[b].searchRank - info[a].searchRank);
      for (const id of order) {
        if (info[id].value * MIN_SWAP_GAIN >= cand.value) break;
        const after = active.filter((x) => x !== id).concat(cand.id);
        const ok = GROUPS.every((g) => {
          const before = active.filter((x) => info[x].groups.includes(g)).length;
          const now = after.filter((x) => info[x].groups.includes(g)).length;
          return now >= Math.min(before, starters[g]);
        });
        if (ok) return { id };
      }
      return null;
    };

    const waivers = pool.map((p) => {
      const drop = dropFor(p, me.active, locked);
      return {
        ...p,
        fit: fitScore(p, needs),
        needGroup: p.groups.slice().sort((a, b) => needs[b] - needs[a])[0] || null,
        drop: drop ? (drop.open ? "open" : drop.id) : null,
      };
    }).sort((a, b) => b.fit - a.fit);
    // Same fit score for your own players, so roster and wire sort together in one list.
    for (const id of me.all) info[id].fit = fitScore(info[id], needs);

    // Sequential plan: each move updates roster and needs before the next.
    const moves = [];
    let roster = me.active.slice();
    const used = new Set(locked), dropped = new Set(); // locked players and earlier adds stay
    for (let step = 0; step < 5; step++) {
      const prof = groupProfile(roster, info, starters);
      const nd = needFor(prof, leagueGroups, starters);
      const ranked = pool.filter((p) => !used.has(p.id))
        .map((p) => ({ p, fit: fitScore(p, nd) }))
        .sort((a, b) => b.fit - a.fit);
      let chosen = null;
      for (const { p, fit } of ranked.slice(0, 40)) {
        const d = dropFor(p, roster, used);
        if (d) { chosen = { p, d, fit }; break; }
      }
      if (!chosen) break;
      const before = bestLineup(roster, info, slots);
      const next = roster.filter((id) => id !== chosen.d.id).concat(chosen.p.id);
      const after = bestLineup(next, info, slots);
      const helped = chosen.p.groups.filter((g) => nd[g] >= 0.15);
      moves.push({
        add: chosen.p,
        drop: chosen.d.open ? null : info[chosen.d.id],
        lineupGain: after.total - before.total,
        starts: chosen.p.id in after.assign,
        fills: helped,
        needs: nd,
      });
      used.add(chosen.p.id);
      if (!chosen.d.open) dropped.add(chosen.d.id);
      roster = next;
    }

    // Rookie draft board: which rookies should still be there at each of my picks.
    let rookieDraft = null;
    if (draftPending) {
      const picks = myPicks.map((p) => ({ ...p }));
      const board = rookiePool.map((p, i) => ({ ...p, boardRank: i + 1, fit: fitScore(p, needs) }));
      const taken = new Set();
      for (const pk of picks) {
        // Assume the room drafts roughly in ranking order, with a one-pick cushion.
        const likely = board.filter((p) => p.boardRank >= pk.overall - 1 && !taken.has(p.id)).slice(0, 6);
        pk.targets = likely.slice().sort((a, b) => b.fit - a.fit).slice(0, 3);
        pk.expected = board[pk.overall - 1] || null;
        if (pk.targets[0]) taken.add(pk.targets[0].id);
      }
      rookieDraft = { status: draft.status, start: draft.start_time, rounds: draft.rounds, type: draft.type, picks, board };
    }

    return {
      slots, starters, maxActive, scoring, rookieDraft,
      me: {
        rosterId: me.roster.roster_id,
        active: me.active.map((id) => info[id]),
        reserve: me.reserve.map((id) => info[id]),
        lineup: Object.fromEntries(Object.entries(lineup.assign).map(([id, s]) => [id, slots[s]])),
        lineupOrder: lineup.assign,
        lineupValue: lineup.total,
        lineupRank,
        rosterCount: me.active.length,
        locked: me.active.filter((id) => locked.has(String(id))).length,
        faab: (league.settings && league.settings.waiver_budget || 0) -
          ((me.roster.settings && me.roster.settings.waiver_budget_used) || 0),
      },
      positions, needs, waivers, moves,
      unmatched,
      info,
    };
  }

  const api = { analyze, matchRankings, bestLineup, rankValue, fantasyPoints, norm, GROUPS, POS_GROUP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WaiverAnalysis = api;
})(typeof window !== "undefined" ? window : globalThis);
