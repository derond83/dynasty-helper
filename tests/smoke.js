// Smoke tests: run both sports' analysis on the bundled league snapshots and check the
// rules the app promises. Run with `node tests/smoke.js`; exits non-zero on failure.
"use strict";
const path = require("path");
const assert = require("assert");
global.window = global;
const root = path.join(__dirname, "..");
const load = (f) => require(path.join(root, f));

load("data/home.js");
load("data/nfl/players.js"); load("data/nfl/values.js"); load("data/nfl/idp.js");
load("data/nba/players.js"); load("data/nba/rankings.js");
const NFL = load("nfl/analysis.js");
const NBA = load("nba/analysis.js");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("ok  ", name); } catch (e) { failures++; console.log("FAIL", name, "\n     ", e.message); }
}

for (const home of window.HOME_LEAGUES) {
  load(`data/leagues/${home.id}.js`);
  const snap = window.LEAGUE_SNAPSHOTS[home.id];
  const rosters = snap.rosters;

  if (home.sport === "nfl") {
    const data = { ...snap, players: window.SLEEPER_PLAYERS_NFL };
    for (const r of rosters) {
      test(`nfl ${home.name}: roster ${r.roster_id} analyzes and keeps its rules`, () => {
        const res = NFL.analyze(data, window.DYNASTY_VALUES, window.IDP_DATA, r.roster_id, {});
        const active = new Set(res.me.active.map((p) => p.id));
        for (const m of res.moves) {
          assert(!m.drop || active.has(m.drop.id), `drop ${m.drop && m.drop.name} isn't on the active roster`);
          assert(!m.drop || m.drop.domain, "never drops an unvalued (K/DEF) player");
          if (m.kind === "upgrade") assert.strictEqual(m.add.domain, m.drop.domain, "upgrades stay on one side of the ball");
        }
      });
    }
    test(`nfl ${home.name}: a locked player is never dropped`, () => {
      const r = rosters[0];
      const first = NFL.analyze(data, window.DYNASTY_VALUES, window.IDP_DATA, r.roster_id, {});
      const ids = first.me.active.map((p) => p.id);
      const res = NFL.analyze(data, window.DYNASTY_VALUES, window.IDP_DATA, r.roster_id, { locked: ids });
      assert.strictEqual(res.moves.filter((m) => m.drop).length, 0);
      assert(res.waivers.every((w) => !w.drop || w.drop === "open"));
    });
    test(`nfl ${home.name}: superflex and TE premium pick the right value tables`, () => {
      const rp = snap.league.roster_positions.map((s, i, a) => (s === "FLEX" && i === a.indexOf("FLEX") ? "SUPER_FLEX" : s));
      const sf = NFL.leagueFormat({ roster_positions: rp, scoring_settings: { bonus_rec_te: 0.5 } });
      assert.deepStrictEqual([sf.base, sf.tep, sf.key], ["sf", "tep", "sf_tep"]);
      const res = NFL.analyze({ ...data, league: { ...snap.league, roster_positions: rp } }, window.DYNASTY_VALUES, window.IDP_DATA, rosters[0].roster_id, {});
      const qb = Object.values(res.info).filter((p) => p.groups.includes("QB")).sort((a, b) => b.value - a.value)[0];
      assert(qb.value >= 9000, `top superflex QB should be ~9999, got ${qb.value}`);
    });
    test(`nfl ${home.name}: a league without IDP turns IDP off`, () => {
      const rp = snap.league.roster_positions.filter((s) => !["DL", "LB", "DB", "IDP_FLEX"].includes(s)).concat(["K", "DEF"]);
      const res = NFL.analyze({ ...data, league: { ...snap.league, roster_positions: rp } }, window.DYNASTY_VALUES, null, rosters[0].roster_id, {});
      assert.strictEqual(res.hasIdp, false);
      assert(res.positions.every((p) => p.domain === "off"));
      assert(res.waivers.every((w) => w.domain === "off"));
      assert.deepStrictEqual(res.unvalued, ["kickers", "team defenses"]);
    });
  }

  if (home.sport === "nba") {
    const data = { ...snap, players: window.SLEEPER_PLAYERS_NBA };
    for (const r of rosters) {
      test(`nba ${home.name}: roster ${r.roster_id} analyzes`, () => {
        const res = NBA.analyze(data, window.HB_RANKINGS.players, r.roster_id, {});
        assert(res.positions.length === 3);
        const active = new Set(res.me.active.map((p) => String(p.id)));
        for (const m of res.moves) assert(!m.drop || active.has(String(m.drop.id)));
      });
    }
    test(`nba ${home.name}: a locked player is never dropped`, () => {
      const r = rosters[0];
      const ids = NBA.analyze(data, window.HB_RANKINGS.players, r.roster_id, {}).me.active.map((p) => p.id);
      const res = NBA.analyze(data, window.HB_RANKINGS.players, r.roster_id, { locked: ids });
      assert.strictEqual(res.moves.filter((m) => m.drop).length, 0);
    });
  }
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
