#!/usr/bin/env python3
"""Refresh the data bundled with the dashboard.

  python3 refresh_data.py              # everything
  python3 refresh_data.py --league ID  # use a different Sleeper league
  python3 refresh_data.py --skip-values --skip-idp   # Sleeper snapshot only

Writes three files that index.html loads:

  values.js       offensive dynasty + redraft values from KeepTradeCut and Dynasty Daddy,
                  keyed by Sleeper player id
  idp.js          IDP stat lines from Sleeper (three seasons) and FantasyPros dynasty
                  DL / LB / DB rankings, keyed by Sleeper player id
  league-data.js  snapshot of the Sleeper league, used when live requests are blocked

Each source is fetched on its own. If one fails, its last good data is kept, the
problem is listed under "warnings" in the file, and the script exits with status 1
once everything else is written, so the scheduled workflow flags it.
"""
import argparse, html, json, re, sys, unicodedata, urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
SLEEPER = "https://api.sleeper.app/v1"
SLEEPER_STATS = "https://api.sleeper.app/stats/nfl"
KTC_URL = "https://keeptradecut.com/dynasty-rankings?page=0&filters=QB|WR|RB|TE&format=1"
DD_URL = "https://dynasty-daddy.com/api/v1/player/all/today?market={}"
# Dynasty Daddy market ids, from its site's FantasyMarket enum.
DD_MARKETS = {"ktc": 0, "ktc_redraft": 4, "dd": 14, "dd_redraft": 15}
FP_URL = "https://www.fantasypros.com/nfl/rankings/dynasty-{}.php"
DEFAULT_LEAGUE = "1312071895943745536"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

OFFENSE = {"QB", "RB", "WR", "TE"}
IDP = {"DL", "LB", "DB"}
PLAYER_FIELDS = ["full_name", "team", "position", "fantasy_positions", "injury_status", "age", "active",
                 "search_rank", "years_exp", "depth_chart_position", "depth_chart_order"]
# Stat columns kept for IDP players, in this order.
IDP_STATS = ["gp", "def_snp", "tm_def_snp", "idp_tkl_solo", "idp_tkl_ast", "idp_sack", "idp_tkl_loss",
             "idp_qb_hit", "idp_pass_def", "idp_int", "idp_ff", "idp_fum_rec", "idp_def_td", "idp_safe",
             "idp_blk_kick"]
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
# Names that differ beyond what last name + team can resolve (e.g. free agents).
ALIASES = {"gabriel davis": "gabe davis"}
# KeepTradeCut team codes that differ from Sleeper's.
KTC_TEAMS = {"TBB": "TB", "GBP": "GB", "KCC": "KC", "NEP": "NE", "NOS": "NO", "SFO": "SF", "LVR": "LV", "JAC": "JAX"}

warnings = []


def get(url, as_json=True):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read().decode("utf-8", "ignore")
    return json.loads(body) if as_json else body


def write_js(name, var, payload):
    path = HERE / name
    path.write_text(f"window.{var} = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    return path


def read_js(name):
    """The payload of a previously written data file, or {}."""
    try:
        text = (HERE / name).read_text()
        return json.loads(text[text.index("=") + 1:].strip().rstrip(";"))
    except (OSError, ValueError):
        return {}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z ]", "", s.replace("-", " "))
    return " ".join(w for w in s.split() if w not in SUFFIXES)


def warn(msg):
    warnings.append(msg)
    print("WARNING:", msg, file=sys.stderr)


# ---------- Sleeper ----------

def sleeper_players():
    players = get(f"{SLEEPER}/players/nfl")
    for p in players.values():
        if not p.get("full_name"):
            p["full_name"] = " ".join(x for x in (p.get("first_name"), p.get("last_name")) if x)
    return players


class Matcher:
    """Finds the Sleeper id for a player named by another site."""

    def __init__(self, players):
        self.players = players
        self.by_name, self.by_last = {}, {}
        for pid, p in players.items():
            n = norm(p.get("full_name"))
            if n:
                self.by_name.setdefault(n, []).append(pid)
                self.by_last.setdefault(n.split(" ")[-1], []).append(pid)

    def find(self, name, groups, team=None):
        """groups: Sleeper fantasy positions the player could have (any match counts)."""
        fits = lambda i: set(self.players[i].get("fantasy_positions") or []) & groups
        n = ALIASES.get(norm(name), norm(name))
        ids = [i for i in self.by_name.get(n, []) if fits(i)]
        if not ids and team:
            # Nicknames (Kenny / Kenneth, Bam / Zonovan): same last name, position and team.
            ids = [i for i in self.by_last.get(n.split(" ")[-1], [])
                   if fits(i) and self.players[i].get("team") == team]
            if len(ids) != 1:
                return None
        if not ids:
            return None
        if len(ids) > 1:
            live = [i for i in ids if self.players[i].get("active")]
            ids = live or ids
            on_team = [i for i in ids if team and self.players[i].get("team") == team]
            ids = on_team or ids
        return ids[0]


def refresh_league(league_id, players):
    league = get(f"{SLEEPER}/league/{league_id}")
    users = get(f"{SLEEPER}/league/{league_id}/users")
    rosters = get(f"{SLEEPER}/league/{league_id}/rosters")
    state = get(f"{SLEEPER}/state/nfl")
    trending = get(f"{SLEEPER}/players/nfl/trending/add?lookback_hours=48&limit=100")

    rostered = {pid for r in rosters for pid in (r.get("players") or [])}
    keep = {}
    for pid, p in players.items():
        fp = set(p.get("fantasy_positions") or [])
        if pid in rostered or (p.get("active") and p.get("team") and fp & (OFFENSE | IDP)):
            keep[pid] = {k: p.get(k) for k in PLAYER_FIELDS}

    payload = {
        "league": {k: league.get(k) for k in ("league_id", "name", "season", "status", "roster_positions",
                                              "scoring_settings", "settings", "total_rosters")},
        "users": [{"user_id": u["user_id"], "display_name": u.get("display_name"),
                   "team_name": (u.get("metadata") or {}).get("team_name")} for u in users],
        "rosters": [{k: r.get(k) for k in ("roster_id", "owner_id", "players", "reserve", "taxi", "starters", "settings")}
                    for r in rosters],
        "state": {k: state.get(k) for k in ("season", "week", "season_type", "display_week")},
        "trending": trending,
        "players": keep,
        "fetched": datetime.now(timezone.utc).isoformat(timespec="minutes"),
    }
    path = write_js("league-data.js", "SLEEPER_SNAPSHOT", payload)
    print(f"Sleeper: {league.get('name')} ({len(rosters)} teams, {len(keep)} players) -> {path.name}")
    return payload


# ---------- Offensive values: KeepTradeCut + Dynasty Daddy ----------

def parse_ktc(page):
    m = re.search(r'<script[^>]*id="ktc-players"[^>]*>(.*?)</script>', page, re.S)
    if not m:
        raise ValueError("KeepTradeCut page has no ktc-players data block; the layout may have changed")
    rows = json.loads(html.unescape(m.group(1)))
    return [r for r in rows if r.get("position") in OFFENSE]


def dd_market(market):
    rows = get(DD_URL.format(market))
    if len(rows) < 200:
        raise ValueError(f"Dynasty Daddy market {market} returned only {len(rows)} players")
    return rows


def dd_table(rows):
    """{sleeper_id: [value, change over the last month]} for offensive players."""
    out = {}
    for r in rows:
        sid, v = r.get("sleeper_id"), r.get("trade_value")
        if sid and v and r.get("position") in OFFENSE:
            last = r.get("last_month_value")
            out[str(sid)] = [int(v), int(v - last) if last else 0]
    return out


def refresh_values(players):
    old = read_js("values.js").get("sources", {})
    sources = {}
    matcher = Matcher(players)

    dd_rows = {}
    for key, market in DD_MARKETS.items():
        try:
            dd_rows[key] = dd_market(market)
        except Exception as e:  # noqa: BLE001 - any failure keeps the last good copy
            warn(f"Dynasty Daddy market {market} ({key}): {e}")

    # KeepTradeCut, straight from its rankings page. Dynasty Daddy's KTC market is the fallback.
    ktc = None
    try:
        rows = parse_ktc(get(KTC_URL, as_json=False))
        if len(rows) < 300:
            raise ValueError(f"only {len(rows)} offensive players parsed")
        # Dynasty Daddy knows each KTC player's Sleeper id; use it before matching by name.
        dd_ids = {}
        for r in dd_rows.get("ktc", []):
            if r.get("sleeper_id"):
                dd_ids[(norm(r.get("full_name")), r.get("position"))] = str(r["sleeper_id"])
        dynasty, unmatched = {}, []
        trend = dd_table(dd_rows.get("ktc", []))
        for r in rows:
            v = (r.get("oneQBValues") or {}).get("value")
            if not v:
                continue
            sid = dd_ids.get((norm(r["playerName"]), r["position"])) or \
                matcher.find(r["playerName"], {r["position"]}, KTC_TEAMS.get(r.get("team"), r.get("team")))
            if not sid:
                unmatched.append(r["playerName"])
                continue
            dynasty[sid] = [int(v), trend.get(sid, [0, 0])[1]]
        ktc = {"dynasty": dynasty, "unmatched": unmatched, "via": KTC_URL.split("?")[0]}
    except Exception as e:  # noqa: BLE001
        warn(f"KeepTradeCut: {e}")
        if "ktc" in dd_rows:
            ktc = {"dynasty": dd_table(dd_rows["ktc"]), "unmatched": [],
                   "via": "Dynasty Daddy's copy of KeepTradeCut (KTC itself could not be read)"}

    def assemble(name, label, url, dynasty, redraft_key, prev):
        if dynasty is None and not prev:
            return
        src = dict(prev or {})
        src.update({"label": label, "url": url})
        if dynasty is not None:
            src.update(dynasty)
            src["updated"] = date.today().isoformat()
        if redraft_key in dd_rows:
            src["redraft"] = dd_table(dd_rows[redraft_key])
        sources[name] = src

    assemble("ktc", "KeepTradeCut", "https://keeptradecut.com/dynasty-rankings",
             ktc, "ktc_redraft", old.get("ktc"))
    dd = {"dynasty": dd_table(dd_rows["dd"]), "unmatched": [], "via": DD_URL.format(14)} if "dd" in dd_rows else None
    assemble("dd", "Dynasty Daddy", "https://dynasty-daddy.com/", dd, "dd_redraft", old.get("dd"))

    if not sources:
        raise SystemExit("No value source could be read and there is no saved copy.")
    payload = {"updated": date.today().isoformat(), "sources": sources,
               "warnings": [w for w in warnings if not w.startswith("IDP")]}
    path = write_js("values.js", "DYNASTY_VALUES", payload)
    for k, s in sources.items():
        print(f"Values: {s['label']} {len(s.get('dynasty', {}))} dynasty / {len(s.get('redraft', {}))} redraft "
              f"({len(s.get('unmatched', []))} unmatched) -> {path.name}")


# ---------- IDP: Sleeper stats + FantasyPros ----------

def idp_season(season):
    rows = get(f"{SLEEPER_STATS}/{season}?season_type=regular&position[]=DL&position[]=LB&position[]=DB")
    out = {}
    for r in rows:
        s = r.get("stats") or {}
        if s.get("def_snp", 0) <= 0 and s.get("gp", 0) <= 0:
            continue
        out[str(r["player_id"])] = [round(s.get(k, 0) or 0, 1) for k in IDP_STATS]
    return out


def parse_fp(page):
    m = re.search(r"var ecrData = (\{.*?\});\s*\n", page, re.S)
    if not m:
        raise ValueError("no ecrData block; the FantasyPros layout may have changed")
    return json.loads(m.group(1))


def refresh_idp(players, season):
    old = read_js("idp.js")
    matcher = Matcher(players)
    seasons = dict(old.get("seasons") or {})
    for y in (season - 2, season - 1, season):
        try:
            data = idp_season(y)
            if y < season and len(data) < 500:
                raise ValueError(f"only {len(data)} players")
            seasons[str(y)] = data
        except Exception as e:  # noqa: BLE001
            warn(f"IDP stats {y}: {e}")
    seasons = {k: v for k, v in seasons.items() if int(k) >= season - 2}

    fp = dict(old.get("fantasypros") or {})
    for page, group in (("dl", "DL"), ("lb", "LB"), ("db", "DB")):
        try:
            d = parse_fp(get(FP_URL.format(page), as_json=False))
            ranked, unmatched = [], []
            for p in d.get("players", []):
                # FantasyPros puts edge rushers on both its DL and LB pages; Sleeper eligibility decides.
                sid = matcher.find(p["player_name"], IDP, p.get("player_team_id"))
                if sid:
                    ranked.append([sid, int(p["rank_ecr"])])
                else:
                    unmatched.append(p["player_name"])
            if len(ranked) < 40:
                raise ValueError(f"only {len(ranked)} {group} players matched")
            fp[group] = {"ranks": ranked, "unmatched": unmatched, "updated": d.get("last_updated"),
                         "experts": d.get("total_experts")}
        except Exception as e:  # noqa: BLE001
            warn(f"IDP FantasyPros {group}: {e}")

    payload = {"updated": date.today().isoformat(), "fields": IDP_STATS, "seasons": seasons,
               "fantasypros": fp, "warnings": [w for w in warnings if w.startswith("IDP")]}
    path = write_js("idp.js", "IDP_DATA", payload)
    print(f"IDP: seasons {sorted(seasons)} ({', '.join(str(len(v)) for v in seasons.values())} players), "
          f"FantasyPros {', '.join(g + ' ' + str(len(v['ranks'])) for g, v in fp.items())} -> {path.name}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--league", default=DEFAULT_LEAGUE, help="Sleeper league ID")
    ap.add_argument("--skip-values", action="store_true")
    ap.add_argument("--skip-idp", action="store_true")
    ap.add_argument("--skip-sleeper", action="store_true")
    args = ap.parse_args()

    players = sleeper_players()
    season = int(get(f"{SLEEPER}/state/nfl").get("season") or date.today().year)
    if not args.skip_sleeper:
        refresh_league(args.league, players)
    if not args.skip_values:
        refresh_values(players)
    if not args.skip_idp:
        refresh_idp(players, season)
    if warnings:
        print(f"\n{len(warnings)} source(s) failed; their last good data was kept.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
