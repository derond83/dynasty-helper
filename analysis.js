// Roster + waiver analysis for a Sleeper dynasty football league with IDP.
// Offense is valued by KeepTradeCut or Dynasty Daddy; IDP by a production model
// scored with the league's own settings and cross-checked against FantasyPros.
// Pure functions; no DOM.
(function (root) {
  "use strict";

  const OFFENSE = ["QB", "RB", "WR", "TE"];
  const IDP = ["DL", "LB", "DB"];
  const GROUPS = OFFENSE.concat(IDP);
  const SLOT_ELIGIBLE = {
    QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"],
    FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"],
    DL: ["DL"], LB: ["LB"], DB: ["DB"], IDP_FLEX: ["DL", "LB", "DB"],
  };

  // Defaults for everything the page lets you adjust.
  const DEFAULTS = {
    source: "ktc",      // offensive values: "ktc" or "dd"
    winNow: 0,          // 0 = pure dynasty, 1 = this season only
    idpFloor: 6,        // fewest IDP players to carry (starters + backups)
    bigPlayWeight: 0.35, // share of a player's own INT/FF/FR/TD/safety/block points that counts; the rest is position average
    fpWeight: 0.3,      // pull of FantasyPros dynasty rankings on IDP value
    multiBonus: 0.05,   // boost for DL/LB or LB/DB eligibility
    minGain: 0.12,      // a swap must add this share of value
  };

  // Fewest players to keep at each position: one cover beyond the dedicated slots.
  const MIN_DEPTH = { QB: 2, RB: 3, WR: 3, TE: 2, DL: 2, LB: 2, DB: 2 };
  // Smallest swap worth suggesting, in each value's own units.
  const MIN_ABS_GAIN = { off: 150, idp: 0.5 };
  // How much positional need lifts a candidate when ordering moves.
  const NEED_WEIGHT = 0.3;
  // IDP model: season weights (current, last, two ago), age horizon, shrinkage.
  const SEASON_WEIGHTS = [3, 1.5, 0.6];
  const PRIME_END = { DL: 33, LB: 32, DB: 32 };  // age production usually ends
  const HORIZON = 6;      // years of remaining production that count fully
  const SHRINK_GAMES = 6; // weighted games of replacement-level production mixed in

  // Injury designations that keep a free agent out of suggested moves (he still shows on the wire).
  const UNAVAILABLE = new Set(["IR", "PUP", "Sus", "NA", "DNR", "COV"]);

  const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
  function norm(s) {
    return (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z ]/g, "").split(/\s+/).filter((w) => w && !SUFFIXES.has(w)).join(" ");
  }

  function groupsOf(p) {
    const fp = (p && p.fantasy_positions) || [];
    return GROUPS.filter((g) => fp.includes(g));
  }
  const domainOf = (groups) => (groups.some((g) => OFFENSE.includes(g)) ? "off" : groups.length ? "idp" : null);

  // ---------- IDP model ----------

  function idpPoints(row, f, sc) {
    const v = (k) => row[f[k]] || 0;
    const stable = v("idp_tkl_solo") * (sc.idp_tkl_solo || 0) + v("idp_tkl_ast") * (sc.idp_tkl_ast || 0) +
      (v("idp_tkl_solo") + v("idp_tkl_ast")) * (sc.idp_tkl || 0) + v("idp_sack") * (sc.idp_sack || 0) +
      v("idp_tkl_loss") * (sc.idp_tkl_loss || 0) + v("idp_qb_hit") * (sc.idp_qb_hit || 0) +
      v("idp_pass_def") * (sc.idp_pass_def || 0);
    const big = v("idp_int") * (sc.idp_int || 0) + v("idp_ff") * (sc.idp_ff || 0) +
      v("idp_fum_rec") * (sc.idp_fum_rec || 0) + v("idp_def_td") * (sc.idp_def_td || 0) +
      v("idp_safe") * (sc.idp_safe || 0) + v("idp_blk_kick") * (sc.idp_blk_kick || 0);
    return { stable, big };
  }

  function ageFactor(age, group, winNow) {
    if (!age) return 1;
    const years = Math.max(0.5, (PRIME_END[group] || 32) - age);
    const f = Math.pow(Math.min(1, years / HORIZON), 0.5);
    return 1 - (1 - winNow) * (1 - f);
  }

  /**
   * IDP value for every defensive player, in "dynasty points per game":
   * production scored with league settings, big plays pulled toward position
   * average, blended with role (snaps), shrunk for small samples, adjusted
   * for age, then blended with FantasyPros.
   */
  function idpModel(idpData, players, scoring, season, cfg) {
    const f = Object.fromEntries((idpData.fields || []).map((k, i) => [k, i]));
    const years = [season, season - 1, season - 2].map(String);
    const seasons = years.map((y) => (idpData.seasons || {})[y] || {});
    const w = SEASON_WEIGHTS.slice();
    w[0] = SEASON_WEIGHTS[0] * (1 + cfg.winNow);

    const primary = (pid) => groupsOf(players[pid]).find((g) => IDP.includes(g)) || null;

    // Position-average big-play points per snap, per season.
    const bigRate = seasons.map((S) => {
      const tot = { DL: [0, 0], LB: [0, 0], DB: [0, 0] };
      for (const [pid, row] of Object.entries(S)) {
        const g = primary(pid), snaps = row[f.def_snp] || 0;
        if (!g || snaps < 100) continue;
        tot[g][0] += idpPoints(row, f, scoring).big; tot[g][1] += snaps;
      }
      return Object.fromEntries(IDP.map((g) => [g, tot[g][1] ? tot[g][0] / tot[g][1] : 0]));
    });

    const raw = {};
    const ids = new Set(seasons.flatMap((S) => Object.keys(S)));
    for (const pid of ids) {
      const g = primary(pid);
      if (!g) continue;
      let ptsW = 0, gamesW = 0, snapsW = 0, recent = null;
      const lines = [];
      seasons.forEach((S, i) => {
        const row = S[pid];
        if (!row) return;
        const gp = row[f.gp] || 0, snaps = row[f.def_snp] || 0;
        if (!gp) return;
        const { stable, big } = idpPoints(row, f, scoring);
        const adj = stable + cfg.bigPlayWeight * big + (1 - cfg.bigPlayWeight) * bigRate[i][g] * snaps;
        ptsW += w[i] * adj; gamesW += w[i] * gp; snapsW += w[i] * snaps;
        const line = {
          season: years[i], gp, snaps, snapShare: row[f.tm_def_snp] ? Math.min(1, snaps / row[f.tm_def_snp]) : null,
          ppg: (stable + big) / gp, adjPpg: adj / gp,
          tklPg: ((row[f.idp_tkl_solo] || 0) + (row[f.idp_tkl_ast] || 0)) / gp,
          sacks: row[f.idp_sack] || 0, ints: row[f.idp_int] || 0, bigShare: stable + big ? big / (stable + big) : 0,
        };
        lines.push(line);
        if (!recent && gp >= 2) recent = line;
      });
      if (!gamesW) continue;
      const ppg = ptsW / gamesW;
      // Role: production per snap at the snap count he's playing now.
      const perSnap = snapsW ? ptsW / snapsW : 0;
      const roleProj = recent ? perSnap * (recent.snaps / recent.gp) : ppg;
      raw[pid] = { g, ppg, prod: 0.5 * ppg + 0.5 * roleProj, gamesW, lines, recent };
    }

    // Replacement level: about the 2.5th-best player per team at each position.
    const repl = {};
    for (const g of IDP) {
      const vals = Object.values(raw).filter((r) => r.g === g && r.gamesW >= 10).map((r) => r.prod).sort((a, b) => b - a);
      repl[g] = vals[Math.min(vals.length - 1, 30)] || 0;
    }

    const model = {};
    for (const [pid, r] of Object.entries(raw)) {
      const p = players[pid] || {};
      const shrunk = (r.prod * r.gamesW + repl[r.g] * SHRINK_GAMES) / (r.gamesW + SHRINK_GAMES);
      const groups = groupsOf(p).filter((g) => IDP.includes(g));
      const multi = groups.length > 1 ? 1 + cfg.multiBonus : 1;
      const age = ageFactor(p.age, r.g, cfg.winNow);
      model[pid] = { ...r, shrunk, age, multi, model: shrunk * age * multi };
    }

    // FantasyPros: the k-th ranked player at a position is worth what the
    // model's k-th best player there is worth. Not being ranked caps value at
    // the first spot past the end of their list.
    const fp = idpData.fantasypros || {};
    const fpRank = {};
    for (const g of IDP) {
      const ranks = (fp[g] && fp[g].ranks) || [];
      if (!ranks.length) continue;
      const ladder = Object.entries(model).filter(([pid]) => groupsOf(players[pid]).includes(g))
        .map(([, m]) => m.model).sort((a, b) => b - a);
      const at = (k) => ladder[Math.min(ladder.length - 1, k - 1)] || 0;
      const seen = new Set();
      ranks.forEach(([pid], i) => {
        seen.add(pid);
        const implied = at(i + 1);
        if (!fpRank[pid] || implied > fpRank[pid].implied) fpRank[pid] = { group: g, rank: i + 1, implied };
      });
      fp[g].cap = at(ranks.length + 1);
    }

    const out = {};
    const all = new Set([...Object.keys(model), ...Object.keys(fpRank)]);
    for (const pid of all) {
      const m = model[pid], r = fpRank[pid];
      if (!players[pid]) continue;
      let value;
      if (m && r) value = (1 - cfg.fpWeight) * m.model + cfg.fpWeight * r.implied;
      else if (m) {
        const caps = groupsOf(players[pid]).filter((g) => fp[g] && fp[g].cap != null).map((g) => fp[g].cap);
        const cap = caps.length ? Math.max(...caps) : m.model;
        value = (1 - cfg.fpWeight) * m.model + cfg.fpWeight * Math.min(m.model, cap);
      } else {
        value = r.implied * 0.8; // ranked but no NFL snaps yet
      }
      out[pid] = { value, model: m || null, fp: r || null };
    }
    return { players: out, repl };
  }

  // ---------- Lineups ----------

  function slotFits(groups, slot) {
    const elig = SLOT_ELIGIBLE[slot];
    return !!elig && groups.some((g) => elig.includes(g));
  }

  // Exact best lineup by value: DP over filled-slot bitmasks.
  function bestLineup(ids, info, slots) {
    const S = slots.length, size = 1 << S;
    let dp = new Float64Array(size).fill(-1);
    dp[0] = 0;
    const parent = new Int8Array(ids.length * size).fill(-1);
    ids.forEach((id, i) => {
      const p = info[id];
      const val = p.norm + 1e-3; // filling a slot beats leaving it empty
      const next = dp.slice();
      for (let mask = 0; mask < size; mask++) {
        if (dp[mask] < 0) continue;
        for (let s = 0; s < S; s++) {
          if (mask & (1 << s) || !slotFits(p.groups, slots[s])) continue;
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
    for (let i = ids.length - 1; i >= 0; i--) {
      const s = parent[i * size + mask];
      if (s >= 0) { assign[ids[i]] = s; mask ^= 1 << s; }
    }
    let total = 0, filled = 0;
    for (const id in assign) { total += info[id].norm; filled++; }
    return { assign, total, filled, open: S - filled };
  }

  function lineupFor(ids, info, offSlots, idpSlots) {
    const off = bestLineup(ids.filter((id) => info[id].domain === "off"), info, offSlots);
    const idp = bestLineup(ids.filter((id) => info[id].domain === "idp"), info, idpSlots);
    const assign = {};
    for (const [id, s] of Object.entries(off.assign)) assign[id] = offSlots[s];
    for (const [id, s] of Object.entries(idp.assign)) assign[id] = idpSlots[s];
    return { assign, off, idp, open: off.open + idp.open };
  }

  // ---------- Analysis ----------

  function needLabel(need) {
    return need >= 0.4 ? "need" : need >= 0.15 ? "thin" : "solid";
  }

  /**
   * data:   Sleeper snapshot { league, users, rosters, players, trending, state }
   * values: DYNASTY_VALUES (KeepTradeCut / Dynasty Daddy)
   * idp:    IDP_DATA (Sleeper stats + FantasyPros)
   */
  function analyze(data, values, idpData, myRosterId, options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    // Players the user has locked are never suggested as drops.
    const locked = new Set((cfg.locked || []).map(String));
    const { league, rosters, players } = data;
    const scoring = league.scoring_settings || {};
    const season = Number((data.state && data.state.season) || league.season);
    const rp = league.roster_positions || [];
    const slots = rp.filter((s) => SLOT_ELIGIBLE[s]);
    const offSlots = slots.filter((s) => SLOT_ELIGIBLE[s].some((g) => OFFENSE.includes(g)));
    const idpSlots = slots.filter((s) => SLOT_ELIGIBLE[s].every((g) => IDP.includes(g)));
    const maxActive = rp.filter((s) => s !== "IR" && s !== "TAXI").length;

    const sources = values.sources || {};
    const src = sources[cfg.source] || sources.ktc || Object.values(sources)[0] || {};
    const other = Object.entries(sources).find(([k]) => k !== cfg.source);
    const offValue = (pid, s) => {
      const d = ((s.dynasty || {})[pid] || [0, 0]);
      const r = ((s.redraft || {})[pid] || [0, 0]);
      return { value: (1 - cfg.winNow) * d[0] + cfg.winNow * r[0], dynasty: d[0], redraft: r[0], trend: d[1] };
    };

    const idpVals = idpModel(idpData, players, scoring, season, cfg);
    const trending = new Map((data.trending || []).map((t) => [String(t.player_id), t.count]));

    const info = {};
    const describe = (id) => {
      if (info[id]) return info[id];
      const p = players[id] || {};
      const all = groupsOf(p);
      const domain = domainOf(all);
      // Two-way players (WR/DB) are valued, and slotted, on one side only.
      const groups = all.filter((g) => (domain === "off" ? OFFENSE : IDP).includes(g));
      const base = {
        id, name: p.full_name || `Player ${id}`, team: p.team || "FA", groups, domain,
        age: p.age || null, injury: p.injury_status || null, depth: p.depth_chart_position || null,
        trending: trending.get(id) || 0, searchRank: p.search_rank || 1e9, rookie: p.years_exp === 0,
        locked: locked.has(id), value: 0, norm: 0,
      };
      if (domain === "off") {
        const v = offValue(id, src);
        Object.assign(base, { value: v.value, dynasty: v.dynasty, redraft: v.redraft, trend: v.trend });
        if (other) base.compare = { label: other[1].label, ...offValue(id, other[1]) };
      } else if (domain === "idp") {
        const v = idpVals.players[id];
        if (v) {
          base.value = v.value;
          base.idp = v;
          const r = v.model && v.model.recent;
          base.ppg = r ? r.ppg : null;
          base.snapShare = r ? r.snapShare : null;
          base.tklPg = r ? r.tklPg : null;
        }
      }
      info[id] = base;
      return base;
    };

    const rostered = new Map();
    const teams = rosters.map((r) => {
      const all = (r.players || []).map(String);
      const taxi = new Set((r.taxi || []).map(String)), ir = new Set((r.reserve || []).map(String));
      all.forEach((id) => { describe(id); rostered.set(id, r.roster_id); });
      return {
        roster: r, all,
        active: all.filter((id) => !taxi.has(id) && !ir.has(id)),
        taxi: all.filter((id) => taxi.has(id)), ir: all.filter((id) => ir.has(id)),
      };
    });

    // Scale each domain by the value of a typical league starter, so offense and
    // IDP can be compared as "share of a starter".
    const scaleOf = (domain, dSlots) => {
      const vals = [];
      for (const t of teams) {
        const ids = t.active.filter((id) => info[id].domain === domain);
        for (const id of ids) info[id].norm = info[id].value; // provisional for the lineup pass
        const lu = bestLineup(ids, info, dSlots);
        for (const id in lu.assign) vals.push(info[id].value);
      }
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
    };
    const scale = { off: scaleOf("off", offSlots) || 1, idp: scaleOf("idp", idpSlots) || 1 };

    // Free agents worth a look: valued players on no roster.
    const pool = [];
    for (const id of Object.keys(players)) {
      if (rostered.has(id)) continue;
      const p = describe(id);
      if (p.domain && p.value > 0) pool.push(p);
    }
    for (const p of Object.values(info)) p.norm = p.domain ? p.value / scale[p.domain] : 0;

    // League view: lineups, how starters split across positions, positional strength.
    for (const t of teams) {
      t.lineup = lineupFor(t.active, info, offSlots, idpSlots);
      t.value = t.all.reduce((s, id) => s + (info[id].domain === "off" ? info[id].value : 0), 0);
      t.idpValue = t.lineup.idp.total * scale.idp;
    }
    const startersPer = Object.fromEntries(GROUPS.map((g) => [g, 0]));
    for (const t of teams) {
      for (const [id, slot] of Object.entries(t.lineup.assign)) {
        const g = info[id].groups.find((x) => SLOT_ELIGIBLE[slot].includes(x));
        if (g) startersPer[g] += 1 / teams.length;
      }
    }
    const strength = (ids, g) => {
      const k = startersPer[g];
      const vals = ids.filter((id) => info[id].groups.includes(g)).map((id) => info[id].value).sort((a, b) => b - a);
      let s = 0;
      for (let i = 0; i < Math.ceil(k); i++) s += (vals[i] || 0) * Math.min(1, k - i);
      return s;
    };
    const leagueG = {};
    for (const g of GROUPS) {
      const vals = teams.map((t) => strength(t.active, g)).sort((a, b) => b - a);
      const bestFa = pool.filter((p) => p.groups.includes(g)).reduce((m, p) => Math.max(m, p.value), 0);
      const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      const perStarter = startersPer[g] ? avg / startersPer[g] : 0;
      leagueG[g] = { avg, best: vals[0] || 0, sorted: vals, bestFa, perStarter,
        // Share of a typical starter's value the best free agent would lose.
        scarcity: perStarter ? Math.max(0, 1 - bestFa / perStarter) : 0 };
    }

    const me = teams.find((t) => String(t.roster.roster_id) === String(myRosterId)) || teams[0];
    const depthOf = (ids, g) => ids.filter((id) => info[id].groups.includes(g)).length;
    const idpCount = (ids) => ids.filter((id) => info[id].domain === "idp").length;
    // Depth to aim for: starters plus backups (two at RB/WR, where injuries and byes bite most).
    const target = (g) => Math.max(MIN_DEPTH[g], Math.round(startersPer[g] + (g === "RB" || g === "WR" ? 2 : 1)));

    const needsFor = (ids) => {
      const out = {};
      for (const g of GROUPS) {
        const L = leagueG[g];
        const strengthGap = L.avg ? Math.max(0, 1 - strength(ids, g) / L.avg) : 0;
        const tg = target(g);
        const depthGap = Math.max(0, (tg - depthOf(ids, g)) / tg);
        out[g] = Math.min(1, strengthGap * 1.5 + depthGap * (0.5 + L.scarcity));
      }
      return out;
    };

    // Hard roster rules. A move may not create or deepen a shortfall.
    const shortfalls = (ids) => {
      const s = {};
      for (const g of GROUPS) s[g] = Math.max(0, MIN_DEPTH[g] - depthOf(ids, g));
      s.IDP = Math.max(0, cfg.idpFloor - idpCount(ids));
      return s;
    };
    const shortTotal = (s) => Object.values(s).reduce((a, b) => a + b, 0);

    const valueRank = teams.map((t) => t.value).filter((v) => v > me.value + 1e-9).length + 1;
    const idpRank = teams.map((t) => t.idpValue).filter((v) => v > me.idpValue + 1e-9).length + 1;
    const lineupRank = teams.map((t) => t.lineup.off.total + t.lineup.idp.total)
      .filter((v) => v > me.lineup.off.total + me.lineup.idp.total + 1e-9).length + 1;

    const myNeeds = needsFor(me.active);
    const positions = GROUPS.map((g) => {
      const L = leagueG[g];
      const mine = me.active.filter((id) => info[id].groups.includes(g)).sort((a, b) => info[b].value - info[a].value);
      return {
        group: g, domain: OFFENSE.includes(g) ? "off" : "idp",
        starters: startersPer[g], target: target(g), min: MIN_DEPTH[g],
        depth: mine.length, strength: strength(me.active, g),
        leagueAvg: L.avg, leagueBest: L.best, leagueRank: L.sorted.filter((v) => v > strength(me.active, g) + 1e-9).length + 1,
        teams: teams.length, top: mine.slice(0, Math.max(1, Math.ceil(startersPer[g]))), bench: mine.slice(Math.ceil(startersPer[g])),
        bestFa: L.bestFa, perStarter: L.perStarter, scarcity: L.scarcity,
        need: myNeeds[g], label: needLabel(myNeeds[g]),
      };
    });

    // ---------- Moves ----------

    const ratioOk = (add, drop) => add.value >= drop.value * (1 + cfg.minGain) &&
      add.value - drop.value >= MIN_ABS_GAIN[add.domain];
    const needOf = (p, nd) => Math.max(0, ...p.groups.map((g) => nd[g] || 0));

    // Best way to make room for `add` on roster `ids`. Returns null if nothing works.
    function bestDrop(add, ids, protectedIds) {
      const before = shortfalls(ids);
      const room = ids.length < maxActive;
      const tries = room ? [null] : ids.filter((id) => !protectedIds.has(id));
      let best = null;
      for (const dropId of tries) {
        const after = (dropId ? ids.filter((x) => x !== dropId) : ids.slice()).concat(add.id);
        const s = shortfalls(after);
        if (Object.keys(s).some((k) => s[k] > before[k])) continue; // creates a shortfall
        const fixes = shortTotal(before) - shortTotal(s);
        const drop = dropId ? info[dropId] : null;
        // At or above the IDP floor, an IDP add takes an IDP spot; offensive value isn't spent on it.
        if (drop && add.domain === "idp" && drop.domain === "off" && idpCount(ids) >= cfg.idpFloor) continue;
        let kind;
        if (!drop) kind = "open";
        else if (fixes > 0) kind = "balance";
        else if (drop.domain === add.domain) { if (!ratioOk(add, drop)) continue; kind = "upgrade"; }
        else if (add.domain === "off" && idpCount(ids) > cfg.idpFloor) {
          // IDP beyond the floor competes for bench spots on equal terms.
          if (add.norm < drop.norm * (1 + cfg.minGain)) continue;
          kind = "surplus";
        } else continue;
        const gain = add.norm - (drop ? drop.norm : 0);
        const score = fixes * 10 + gain;
        if (!best || score > best.score) best = { drop, kind, fixes, gain, score };
      }
      return best;
    }

    const protectedIds = new Set(locked); // locked players, and players added earlier in the plan
    const moves = [];
    let roster = me.active.slice();
    const usedFa = new Set();
    const candidates = pool.filter((p) => !UNAVAILABLE.has(p.injury))
      .sort((a, b) => b.norm - a.norm).slice(0, 150);
    for (let step = 0; step < 6; step++) {
      const nd = needsFor(roster);
      let chosen = null;
      for (const p of candidates) {
        if (usedFa.has(p.id)) continue;
        const d = bestDrop(p, roster, protectedIds);
        if (!d) continue;
        const score = d.score * (1 + NEED_WEIGHT * needOf(p, nd));
        if (!chosen || score > chosen.score) chosen = { p, d, score };
      }
      if (!chosen) break;
      const before = lineupFor(roster, info, offSlots, idpSlots);
      const next = roster.filter((id) => !chosen.d.drop || id !== chosen.d.drop.id).concat(chosen.p.id);
      const after = lineupFor(next, info, offSlots, idpSlots);
      moves.push({
        add: chosen.p, drop: chosen.d.drop, kind: chosen.d.kind,
        fixes: Object.entries(shortfalls(roster)).filter(([k, v]) => v > shortfalls(next)[k]).map(([k]) => k),
        starts: chosen.p.id in after.assign,
        lineupGain: (after.off.total + after.idp.total) - (before.off.total + before.idp.total),
        gain: chosen.d.gain,
      });
      usedFa.add(chosen.p.id);
      protectedIds.add(chosen.p.id);
      roster = next;
    }

    // Waiver wire, each with the swap it would take on today's roster.
    const waivers = pool.map((p) => {
      const d = bestDrop(p, me.active, locked);
      return {
        ...p,
        fit: p.norm * (1 + NEED_WEIGHT * needOf(p, myNeeds)),
        needGroup: p.groups.slice().sort((a, b) => myNeeds[b] - myNeeds[a])[0] || null,
        drop: d ? (d.drop ? d.drop.id : "open") : null, dropKind: d ? d.kind : null,
      };
    }).sort((a, b) => b.fit - a.fit);

    const standings = teams.map((t) => ({
      rosterId: t.roster.roster_id, value: t.value, idpValue: t.idpValue,
      lineup: t.lineup.off.total + t.lineup.idp.total, players: t.all.length,
    })).sort((a, b) => b.value - a.value);

    return {
      cfg, season, slots, offSlots, idpSlots, maxActive, scale, startersPer,
      source: { key: cfg.source in sources ? cfg.source : Object.keys(sources)[0], label: src.label, via: src.via, updated: src.updated },
      compareLabel: other ? other[1].label : null,
      me: {
        rosterId: me.roster.roster_id,
        active: me.active.map((id) => info[id]), taxi: me.taxi.map((id) => info[id]), ir: me.ir.map((id) => info[id]),
        lineup: me.lineup.assign, rosterCount: me.active.length,
        value: me.value, valueRank, idpValue: me.idpValue, idpRank, lineupRank,
        idpCount: idpCount(me.active), shortfalls: shortfalls(me.active),
        locked: me.all.filter((id) => locked.has(id)).length,
        faab: ((league.settings && league.settings.waiver_budget) || 0) -
          ((me.roster.settings && me.roster.settings.waiver_budget_used) || 0),
      },
      positions, needs: myNeeds, moves, waivers, standings, info, repl: idpVals.repl,
    };
  }

  const api = { analyze, idpModel, bestLineup, ageFactor, norm, DEFAULTS, GROUPS, OFFENSE, IDP, MIN_DEPTH };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DynastyAnalysis = api;
})(typeof window !== "undefined" ? window : globalThis);
