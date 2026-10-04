// Rookie draft board, shared by both sports. No DOM.
(function (root) {
  "use strict";

  /** A rookies-only draft that hasn't finished. */
  function pending(draft) {
    return !!draft && draft.player_type === 1 && ["pre_draft", "drafting", "paused"].includes(draft.status);
  }

  /** Picks a roster currently owns in a draft, in pick order (traded picks included). */
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
        if (String(owner) === String(rosterId)) picks.push({ round, pick, overall: (round - 1) * teamsN + pick, fromRoster: orig });
      }
    }
    return picks.sort((a, b) => a.overall - b.overall);
  }

  /**
   * Which rookies should still be there at each of your picks, assuming the room drafts close to
   * the rankings with a one-pick cushion; targets sorted by fit for your roster.
   * rookies: best first. fit(p): a number, higher is better for you.
   */
  function board(draft, picks, rookies, fit) {
    const ranked = rookies.map((p, i) => ({ ...p, boardRank: i + 1, fit: fit(p) }));
    const taken = new Set();
    const out = picks.map((p) => ({ ...p }));
    for (const pk of out) {
      const likely = ranked.filter((p) => p.boardRank >= pk.overall - 1 && !taken.has(p.id)).slice(0, 6);
      pk.targets = likely.slice().sort((a, b) => b.fit - a.fit).slice(0, 3);
      pk.expected = ranked[pk.overall - 1] || null;
      if (pk.targets[0]) taken.add(pk.targets[0].id);
    }
    return { status: draft.status, start: draft.start_time, rounds: draft.rounds, type: draft.type, picks: out, board: ranked };
  }

  const api = { pending, ownedPicks, board };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DraftBoard = api;
})(typeof window !== "undefined" ? window : globalThis);
