# Dynasty Helper

Dashboard for the Sleeper dynasty football league "The League IX" (league `1312071895943745536`):
12 teams, 1QB, half-PPR, IDP (DL / LB / DB / IDP_FLEX).
It compares your roster with the waiver wire and suggests add/drop moves that raise your roster's value
and keep positions balanced.

- **Offense** is valued by [KeepTradeCut](https://keeptradecut.com/dynasty-rankings) (1QB) or
  [Dynasty Daddy](https://dynasty-daddy.com/), picked from the menu at the top. The other source is shown for comparison.
- **IDP** is valued by a production model built from Sleeper stats and scored with this league's
  settings, cross-checked against the free FantasyPros dynasty DL / LB / DB rankings. Neither KTC nor Dynasty Daddy values IDP.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The dashboard. Your roster and the waiver wire share one Players table (offense or IDP at a time), with your players highlighted. |
| `analysis.js` | Value lookup, IDP model, lineup optimizer, positional scarcity and the move planner (no DOM). |
| `values.js` | Offensive dynasty and redraft values from KeepTradeCut and Dynasty Daddy, keyed by Sleeper id. |
| `idp.js` | Sleeper IDP stat lines for the last three seasons, plus FantasyPros dynasty IDP rankings. |
| `league-data.js` | Saved copy of the Sleeper league, used when live requests are blocked. |
| `refresh_data.py` | Rebuilds the three data files. Python 3, standard library only. |
| `.github/workflows/refresh.yml` | Daily refresh + GitHub Pages deploy. |

## Hosting (GitHub Pages)

The site is published by `.github/workflows/refresh.yml`, which:

- runs daily at 10:17 UTC (and on demand from **Actions → Refresh data and deploy → Run workflow**),
- runs `refresh_data.py` and commits the new data if it changed,
- deploys the site to GitHub Pages. Every push to `main` deploys too.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The site is then at `https://derond83.github.io/dynasty-helper/`.

Each source is fetched on its own. If one breaks (say KeepTradeCut changes its page), the others still refresh,
the broken one keeps its last good data, the page shows a warning, and the workflow run is marked failed so GitHub
emails you. If KeepTradeCut itself can't be read, its values come from Dynasty Daddy's copy of KTC instead.

## Run locally

```sh
python3 refresh_data.py   # everything
open index.html           # or double-click it
```

The page opens on Aubergines. Pick another team from the menu (the choice is remembered), or link to one with
`#team-<roster number>`, e.g. `https://derond83.github.io/dynasty-helper/#team-2`.

## How suggestions are made

**Offensive value** is the source's 1QB dynasty value. The *win now* setting blends in that source's redraft value.

**IDP value**, in roughly points per game:

1. Score each season with the league's IDP settings (tackles 1.4 solo / 0.7 assist, sack 4.5, TFL 2 …).
2. Count only part of a player's own big plays (INT, forced fumble, recovery, TD, safety, blocked kick; 35% by default).
   The rest is replaced by the position average for his snaps, so tackles and sacks drive value.
3. Weight seasons 3 : 1.5 : 0.6 (this season, last season, two seasons ago), per game played.
4. Average that with per-snap production projected at the snaps he's playing now, which catches role changes.
5. Shrink small samples toward a replacement-level player at his position.
6. Discount for age. Production is assumed to end around 33 for DL and 32 for LB and DB, and six or more years left counts fully.
7. Add 5% for DL/LB or LB/DB eligibility.
8. Blend 30% with FantasyPros: their #k player at a position is worth what the model's #k player is worth.
   Players they don't rank are capped at the first spot past the end of their list.

The page tags each defender with his Sleeper depth chart spot (SS, NB, MLB …). Box spots are highlighted.

**Positional balance.** Starters per position come from the league's actual best lineups, which shows how FLEX
and IDP_FLEX get used. Strength is your top starters' value against the other teams. Scarcity compares the
best free agent with a typical starter.

**Moves**, planned one at a time:

- Offense and IDP are managed separately, because their values aren't on the same scale (and IDP trade value is low).
  A set number of active roster spots are IDP (6 by default, changeable in Tuning); the rest are offense.
  A move only swaps an offensive player for a defender, or back, to restore that split.
- A roster keeps at least 2 QB, 3 RB, 3 WR, 2 TE, 2 DL, 2 LB and 2 DB. DL/LB and LB/DB players count for both.
  Moves that fix a shortfall come first.
- Otherwise a swap stays on one side of the ball and must add 12% or more value, and at least 150 offensive value
  or 0.5 IDP points per game.
- Taxi (locked in season) and IR players are never dropped, and neither is any player you **lock** in the Players table
  or on a move card. Locks are saved in your browser. Injured free agents (IR, PUP, suspended) stay on the wire but aren't suggested.

Every weight above can be changed in the page's **Tuning** panel (saved in your browser). The constants are at the top of `analysis.js`.

## Ideas for later

- Trade suggestions (other rosters' players, using the same values).
- Draft pick values in the league value table.
- Rookie and taxi planning for the offseason.
