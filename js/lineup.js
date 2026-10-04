// Weekly matchup: best lineups from projections, scored with the league's settings, shared by both
// sports. No DOM.
(function (root) {
  "use strict";

  // How much of a player's projection to count by injury designation.
  const AVAILABLE = { Out: 0, IR: 0, Sus: 0, PUP: 0, NA: 0, DNR: 0, COV: 0, Doubtful: 0.25, Questionable: 0.85 };

  /** Projected fantasy points: projected stats scored with the league's settings. */
  function score(stats, scoring) {
    let pts = 0;
    for (const [k, v] of Object.entries(stats || {})) if (scoring[k]) pts += v * scoring[k];
    return pts;
  }

  /** Best assignment of players to starting slots by projected points (exact for up to 16 slots). */
  function optimize(slots, ids, fits, pts) {
    const S = slots.length;
    const cand = ids.filter((id) => slots.some((s) => fits(id, s)));
    if (S <= 16) {
      const size = 1 << S;
      let dp = new Float64Array(size).fill(-1);
      dp[0] = 0;
      const parent = new Int8Array(cand.length * size).fill(-1);
      cand.forEach((id, i) => {
        const v = pts(id) + 1e-4; // filling a slot beats leaving it empty
        const next = dp.slice();
        for (let mask = 0; mask < size; mask++) {
          if (dp[mask] < 0) continue;
          for (let s = 0; s < S; s++) {
            if (mask & (1 << s) || !fits(id, slots[s])) continue;
            const nm = mask | (1 << s), val = dp[mask] + v;
            if (val > next[nm]) { next[nm] = val; parent[i * size + nm] = s; }
          }
        }
        dp = next;
      });
      let best = 0;
      for (let m = 0; m < size; m++) if (dp[m] > dp[best]) best = m;
      const bySlot = new Array(S).fill(null);
      let mask = best;
      for (let i = cand.length - 1; i >= 0; i--) {
        const s = parent[i * size + mask];
        if (s >= 0) { bySlot[s] = cand[i]; mask ^= 1 << s; }
      }
      return bySlot;
    }
    // Many slots: fill the narrowest slots first with the best player who fits.
    const bySlot = new Array(S).fill(null), used = new Set();
    const order = slots.map((s, i) => i).sort((a, b) => cand.filter((id) => fits(id, slots[a])).length - cand.filter((id) => fits(id, slots[b])).length);
    for (const s of order) {
      const pick = cand.filter((id) => !used.has(id) && fits(id, slots[s])).sort((a, b) => pts(b) - pts(a))[0];
      if (pick) { bySlot[s] = pick; used.add(pick); }
    }
    return bySlot;
  }

  // Standard normal CDF (Abramowitz–Stegun).
  function phi(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  /**
   * o: { slots, fits(id, slot), pts(id), spread(points) -> standard deviation for one player,
   *      mine: { active, starters }, theirs: { active, starters } | null }
   * starters: Sleeper's current lineup, slot by slot ("0" or null = empty).
   */
  function matchup(o) {
    const total = (bySlot) => bySlot.reduce((s, id) => s + (id ? o.pts(id) : 0), 0);
    const sd = (bySlot) => bySlot.reduce((s, id) => s + (id ? o.spread(o.pts(id)) ** 2 : 0), 0);
    const side = (team) => {
      if (!team) return null;
      const best = optimize(o.slots, team.active, o.fits, o.pts);
      const current = o.slots.map((_, i) => {
        const id = (team.starters || [])[i];
        return id && id !== "0" ? String(id) : null;
      });
      return { best, current, bestTotal: total(best), currentTotal: total(current), variance: sd(best), currentVariance: sd(current) };
    };
    const me = side(o.mine), them = side(o.theirs);

    // Lineup changes: who to start that you aren't, and who they replace (biggest gains first).
    const inBest = new Set(me.best.filter(Boolean)), inCur = new Set(me.current.filter(Boolean));
    const start = [...inBest].filter((id) => !inCur.has(id)).sort((a, b) => o.pts(b) - o.pts(a));
    const sit = [...inCur].filter((id) => !inBest.has(id)).sort((a, b) => o.pts(a) - o.pts(b));
    const empty = me.current.filter((id) => !id).length;
    const changes = start.map((id, i) => ({ start: id, slot: o.slots[me.best.indexOf(id)], sit: sit[i] || null }));

    // Win chance if both start their best, and if both keep the lineups set now.
    let winProb = null, winProbCurrent = null;
    if (them) {
      winProb = phi((me.bestTotal - them.bestTotal) / Math.sqrt(me.variance + them.variance || 1));
      winProbCurrent = phi((me.currentTotal - them.currentTotal) / Math.sqrt(me.currentVariance + them.currentVariance || 1));
    }
    const rows = o.slots.map((slot, i) => ({ slot, mine: me.best[i], theirs: them ? them.best[i] : null }));
    return { me, them, changes, emptySlots: empty, winProb, winProbCurrent, rows };
  }

  const api = { score, optimize, matchup, AVAILABLE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LineupEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
