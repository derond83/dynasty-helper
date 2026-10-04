// Trade suggestions, shared by both sports. Each sport's analysis supplies values, positions,
// starter strength and needs; this file only searches and judges trades. No DOM.
//
// A trade is suggested only when it works for both sides:
//   - fair on market value: neither side gives up more than `tolerance` of what it gets back, with a
//     premium for the best player in an uneven (2-for-1) deal, as trade calculators like KTC apply;
//   - it fills a need for the other team: their starters improve, at a position where they're thin;
//   - it gives you something concrete: your starters improve, or you gain market value.
// Suggestions are ranked by your gain, with a nudge toward deals the other side will like more.
(function (root) {
  "use strict";

  const DEFAULTS = {
    tolerance: 0.10, // the most market value either side may give up, as a share of what it gets back
    premium: 1.35,   // >1 makes one great player worth more than two good ones adding up to the same
    valueWeight: 0.5, // how much market value counts next to starter strength in each side's gain
    minValueGain: 0, // smallest market-value gain that counts as a benefit on its own (sport's units)
    appeal: 0.2,     // weight of the other side's gain when ranking
    perPartner: 2,   // suggestions per trade partner
    perPlayer: 2,    // suggestions that offer the same player of yours
    max: 10,
    pool: 14,        // players per side considered (by value)
  };

  /**
   * opts:
   *   me, partners       { id, active: [ids], limit }   active rosters (taxi/IR excluded) and how many
   *                      players that roster can hold
   *   value(id)          market value (the scale trades are judged on)
   *   strength(ids)      total starter strength of a roster, in the same units as value
   *   groupStrength(ids) { group: strength }      for explaining where a roster improves
   *   needs(ids)         { group: 0..1 }          positional need
   *   groupsOf(id)       positions a player counts at
   *   tradeable(id)      can this player be in a trade at all
   *   offerable(id)      can you offer this player (not locked)
   */
  function suggest(o) {
    const cfg = { ...DEFAULTS, ...(o.options || {}) };
    const top = Math.max(1, ...o.me.active.concat(...o.partners.map((p) => p.active)).map(o.value));
    const eff = (ids) => ids.reduce((s, id) => s + top * Math.pow(Math.max(0, o.value(id)) / top, cfg.premium), 0);
    const raw = (ids) => ids.reduce((s, id) => s + o.value(id), 0);
    const pool = (ids, ok) => ids.filter((id) => o.tradeable(id) && ok(id) && o.value(id) > 0)
      .sort((a, b) => o.value(b) - o.value(a)).slice(0, cfg.pool);

    // After a trade a side keeps its roster legal by releasing its least valuable player(s).
    function settle(ids, limit, protect, keepFor) {
      const out = ids.slice(), dropped = [];
      while (out.length > limit) {
        const cut = out.filter((id) => !protect.has(id) && keepFor(id))
          .sort((a, b) => o.value(a) - o.value(b))[0];
        if (!cut) return null;
        out.splice(out.indexOf(cut), 1);
        dropped.push(cut);
      }
      return { ids: out, dropped };
    }

    const myBase = o.strength(o.me.active), myGroups = o.groupStrength(o.me.active);
    const myGive = pool(o.me.active, o.offerable);
    const found = [];

    for (const partner of o.partners) {
      const theirBase = o.strength(partner.active), theirGroups = o.groupStrength(partner.active);
      const theirNeeds = o.needs(partner.active);
      const theirGive = pool(partner.active, () => true);
      const shapes = [];
      for (const g of myGive) for (const t of theirGive) shapes.push([[g], [t]]);
      for (let i = 0; i < myGive.length; i++) for (let j = i + 1; j < myGive.length; j++) for (const t of theirGive) shapes.push([[myGive[i], myGive[j]], [t]]);
      for (const g of myGive) for (let i = 0; i < theirGive.length; i++) for (let j = i + 1; j < theirGive.length; j++) shapes.push([[g], [theirGive[i], theirGive[j]]]);

      for (const [give, get] of shapes) {
        // Fair on market value, both ways (a quick check first, then counting any forced drops:
        // a player a side must release to make room is part of what that side pays).
        const eGive = eff(give), eGet = eff(get);
        if (eGive < eGet * (1 - cfg.tolerance) || eGet < eGive * (1 - cfg.tolerance)) continue;

        const mine = settle(o.me.active.filter((id) => !give.includes(id)).concat(get), o.me.limit, new Set(get), o.offerable);
        const theirs = settle(partner.active.filter((id) => !get.includes(id)).concat(give), partner.limit, new Set(give), () => true);
        if (!mine || !theirs) continue;
        const theyGet = eGive - eff(theirs.dropped), iGet = eGet - eff(mine.dropped);
        if (theyGet < eGet * (1 - cfg.tolerance) || iGet < eGive * (1 - cfg.tolerance)) continue;

        // Their starters must improve by something they'd notice.
        const theirGain = o.strength(theirs.ids) - theirBase;
        if (theirGain < 0.03 * raw(give)) continue;
        // ...at a position where they're thin.
        const fills = [...new Set(give.flatMap(o.groupsOf))].filter((g) => (theirNeeds[g] || 0) >= 0.15);
        if (!fills.length) continue;

        const myGain = o.strength(mine.ids) - myBase;
        const myValue = raw(get) - raw(give) - raw(mine.dropped);
        const theirValue = raw(give) - raw(get) - raw(theirs.dropped);
        const valueWin = myValue >= Math.max(cfg.minValueGain, 0.03 * raw(give));
        if (myGain <= 0 && !valueWin) continue;
        const myScore = myGain + cfg.valueWeight * myValue;
        if (myScore <= 0) continue;
        const theirScore = theirGain + cfg.valueWeight * theirValue;

        const afterMine = o.groupStrength(mine.ids), afterTheirs = o.groupStrength(theirs.ids);
        const diff = (a, b) => Object.keys(a).map((g) => [g, a[g] - (b[g] || 0)]).filter(([, d]) => Math.abs(d) > 1e-9);
        found.push({
          partner: partner.id, give, get,
          myGain, theirGain, myValue, theirValue, score: myScore + cfg.appeal * Math.max(0, theirScore),
          fairness: iGet / (eGive || 1), // > 1: you get more market value than you give (after any drop you'd make)
          fills,
          myChanges: diff(afterMine, myGroups), theirChanges: diff(afterTheirs, theirGroups),
          myDrop: mine.dropped, theirDrop: theirs.dropped,
        });
      }
    }

    // Best first, spread across partners and across the players you'd give.
    found.sort((a, b) => b.score - a.score);
    const perPartner = new Map(), perPlayer = new Map(), out = [];
    const seen = new Set(); // one version of a deal: same partner and same headline players
    for (const t of found) {
      if ((perPartner.get(t.partner) || 0) >= cfg.perPartner) continue;
      const keys = [...t.get.map((id) => `${t.partner}:get:${id}`), ...t.give.map((id) => `${t.partner}:give:${id}`)];
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      if (t.give.some((id) => (perPlayer.get(id) || 0) >= cfg.perPlayer)) continue;
      out.push(t);
      perPartner.set(t.partner, (perPartner.get(t.partner) || 0) + 1);
      for (const id of t.give) perPlayer.set(id, (perPlayer.get(id) || 0) + 1);
      if (out.length >= cfg.max) break;
    }
    return out;
  }

  const api = { suggest, DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TradeEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
