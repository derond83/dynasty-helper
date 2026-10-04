// Football league page: Moves / Players / League tabs. Uses DynastyAnalysis (nfl/analysis.js).
(function () {
  "use strict";
  const DH = window.DH;
  const { esc, ordinal, int, pct } = DH.fmt;
  const PAGE = 30;
  const AUTO_MAX = 80; // rows shown before "Show more" when reaching for your last player
  const GROUP_NAMES = { QB: "Quarterbacks", RB: "Running backs", WR: "Receivers", TE: "Tight ends", DL: "Defensive line", LB: "Linebackers", DB: "Defensive backs" };
  // Sleeper depth chart spots that usually mean a box player (tackles and sacks).
  const BOX = new Set(["SS", "NB", "MLB", "ILB", "LILB", "RILB", "WLB", "SLB", "LB"]);
  const TABS = [{ id: "team", label: "Team" }, { id: "league", label: "League" }, { id: "moves", label: "Moves" },
    { id: "trades", label: "Trades" }, { id: "draft", label: "Draft" }, { id: "matchup", label: "Matchup" },
    { id: "settings", label: "Settings", icon: "gear" }];
  // Which Sleeper positions can fill each starting slot (for the Matchup tab).
  const SLOT_POS = {
    QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
    FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"],
    DL: ["DL"], LB: ["LB"], DB: ["DB"], IDP_FLEX: ["DL", "LB", "DB"],
  };
  const TRADE_KNOBS = {
    tradeMinValue: { label: "Value-only trades", min: 0.05, max: 0.4, step: 0.01, fmt: (v) => `+${Math.round(v * 100)}% or more`,
      help: "When a trade doesn't improve your starters, how much more value you must get back than you give. Surplus players (non-starters beyond your target at their position) count at half value." },
    tradeTolerance: { label: "Trade fairness", min: 0.03, max: 0.25, step: 0.01, fmt: (v) => `within ${Math.round(v * 100)}%`,
      help: "How far apart the two sides' market value may be. Lower is stricter (fewer, fairer ideas); higher allows bigger asks." },
  };

  // Per-league view state that doesn't need to survive a reload.
  const views = new Map();
  const viewOf = (id) => {
    if (!views.has(id)) views.set(id, { wirePos: "off", wireShow: "both", wireSort: "value", wireQuery: "", wireShown: null, showTaxi: false, open: new Set() });
    return views.get(id);
  };

  const hasIdpSlots = (league) => (league.roster_positions || []).some((s) => ["DL", "LB", "DB", "IDP_FLEX"].includes(s));

  function knobs(result) {
    const k = {
      winNow: { label: "Win now ↔ dynasty", min: 0, max: 1, step: 0.1, fmt: (v) => (v === 0 ? "Dynasty" : v === 1 ? "This season" : `${Math.round(v * 100)}% now`),
        help: `0 is pure dynasty value. Moving right blends in redraft values for offense${result.hasIdp ? " and leans IDP toward this season, with less age discount" : ""}.` },
    };
    if (result.hasIdp) Object.assign(k, {
      idpSpots: { label: "IDP roster spots", min: Math.max(0, result.idpSlots.length), max: Math.min(result.maxActive, result.idpSlots.length + 8), step: 1,
        fmt: (v) => `${v} of ${result.maxActive}`, help: `How many active roster spots go to IDP, starters included. The rest are offense. Default: your ${result.idpSlots.length} IDP starters plus 2.` },
      bigPlayWeight: { label: "Big-play weight", min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`,
        help: "How much a player's own interceptions, forced fumbles, recoveries, TDs and blocked kicks count. The rest is replaced by the position average for his snaps. Tackles and sacks always count fully." },
      fpWeight: { label: "FantasyPros weight", min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`,
        help: "How far IDP values move toward the FantasyPros dynasty rankings. 0 uses only production. 1 uses only the rankings." },
      multiBonus: { label: "Multi-position bonus", min: 0, max: 0.2, step: 0.01, fmt: (v) => `+${Math.round(v * 100)}%`, help: "Extra value for DL/LB or LB/DB eligibility." },
    });
    k.minGain = { label: "Minimum upgrade", min: 0, max: 0.5, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, help: "A swap has to add at least this much value before it's suggested." };
    return k;
  }

  function render(ctx, el) {
    const A = window.DynastyAnalysis;
    const values = window.DYNASTY_VALUES, idp = window.IDP_DATA || null;
    const view = viewOf(ctx.id);
    const locked = new Set((ctx.store.get("locked", []) || []).map(String));
    const opts = () => ({ ...A.DEFAULTS, ...(ctx.store.get("options", {}) || {}) });
    let result = null;
    const analyze = () => {
      // Trades take a moment to search; only when the Trades tab is open.
      result = A.analyze(ctx.data, values, idp, ctx.rosterId, { ...opts(), locked: [...locked], trades: ctx.tab === "trades" });
      return result;
    };
    analyze();

    // ---------- Cells ----------
    const posChips = (groups) => `<span class="chips">${groups.map((g) => `<span class="pos" data-g="${g}">${g}</span>`).join("")}</span>`;
    const injTag = (p) => (p.injury ? `<span class="tag inj">${esc(p.injury)}</span>` : "");
    const hotTag = (p) => (p.trending ? `<span class="tag hot" title="Sleeper adds in the last 48 hours">${p.trending.toLocaleString()} adds</span>` : "");
    const boxTag = (p) => (p.domain === "idp" && p.depth ? `<span class="tag${BOX.has(p.depth) ? " fit" : ""}" title="Sleeper depth chart spot${BOX.has(p.depth) ? ": usually a box player" : ""}">${esc(p.depth)}</span>` : "");
    const ageFmt = (v) => (v ? String(v) : "–");
    const valueCell = (p) => {
      if (!p.domain) return '<span class="muted">–</span>';
      if (p.domain === "off") return p.value ? `<span class="val">${int(p.value)}</span>` : '<span class="muted">Unvalued</span>';
      if (!p.value) return '<span class="muted">No data</span>';
      const par = p.par == null ? "" : ` <span class="par" title="Points per game above a waiver-level player at his position">${p.par >= 0 ? "+" : "−"}${Math.abs(p.par).toFixed(1)}</span>`;
      return `<span class="val">${p.value.toFixed(1)}<small>pts/g</small></span>${par}`;
    };
    const trendTag = (p) => {
      if (p.domain !== "off" || !p.trend) return "";
      return p.trend > 0 ? `<span class="mv-up" title="Change in the last month">▲${int(p.trend)}</span>` : `<span class="mv-down" title="Change in the last month">▼${int(-p.trend)}</span>`;
    };
    const detailCell = (p) => {
      if (p.domain === "off") {
        const c = p.compare;
        return `<span class="detail-cell">${c ? `${esc(c.label)} ${c.value ? int(c.value) : "–"}` : ""} ${trendTag(p)}</span>`;
      }
      if (p.domain === "idp" && p.idp) {
        const fp = p.idp.fp, bits = [];
        if (p.ppg != null) bits.push(`${p.ppg.toFixed(1)} FP/G`);
        if (p.tklPg != null) bits.push(`${p.tklPg.toFixed(1)} tkl/g`);
        if (p.snapShare != null) bits.push(`${pct(p.snapShare)} snaps`);
        bits.push(fp ? `FP ${fp.group}${fp.rank}` : "FP unranked");
        return `<span class="detail-cell" title="Most recent season with 2+ games">${bits.join(" · ")}</span>`;
      }
      return "";
    };
    const nameCell = (p) => `<div class="pname"><button type="button" data-open="${esc(p.id)}" aria-expanded="${view.open.has(p.id)}">${esc(p.name)}</button>
      <span class="team">${esc(p.team)}</span>${boxTag(p)}${injTag(p)}${hotTag(p)}</div>`;
    const detailRow = (p, cols) => {
      let body;
      if (p.domain === "off") {
        const line = (label, v) => `<tr><td>${esc(label)}</td><td class="num">${v.dynasty ? int(v.dynasty) : "–"}</td><td class="num">${v.redraft ? int(v.redraft) : "–"}</td><td class="num">${v.trend ? (v.trend > 0 ? "+" : "") + int(v.trend) : "–"}</td></tr>`;
        body = `<table><thead><tr><th>Source</th><th class="num">Dynasty</th><th class="num">Redraft</th><th class="num">30-day change</th></tr></thead><tbody>
          ${line(result.source.label, p)}${p.compare ? line(p.compare.label, p.compare) : ""}</tbody></table>`;
      } else if (p.domain === "idp" && p.idp) {
        const m = p.idp.model, fp = p.idp.fp;
        const lines = m ? m.lines.map((l) => `<tr><td>${l.season}</td><td class="num">${l.gp}</td><td class="num">${pct(l.snapShare)}</td><td class="num">${l.tklPg.toFixed(1)}</td><td class="num">${l.sacks}</td><td class="num">${l.ints}</td><td class="num">${l.ppg.toFixed(1)}</td><td class="num">${l.adjPpg.toFixed(1)}</td></tr>`).join("") : "";
        const parts = [];
        if (m) parts.push(`Production ${m.prod.toFixed(1)} pts/g, ${m.shrunk.toFixed(1)} after sample-size adjustment`, `age factor ${m.age.toFixed(2)}`);
        if (m && m.multi > 1) parts.push(`multi-position +${Math.round((m.multi - 1) * 100)}%`);
        parts.push(fp ? `FantasyPros dynasty ${fp.group} #${fp.rank} (worth ${fp.implied.toFixed(1)})` : "not in the FantasyPros dynasty rankings");
        if (p.par != null) parts.push(`${p.par >= 0 ? "+" : "−"}${Math.abs(p.par).toFixed(1)} pts/g over a waiver-level ${p.groups.join("/")}`);
        body = `${lines ? `<table><thead><tr><th>Season</th><th class="num">GP</th><th class="num">Snaps</th><th class="num">Tkl/G</th><th class="num">Sacks</th><th class="num">INT</th><th class="num">FP/G</th><th class="num" title="Big plays mostly replaced by the position average">Adj FP/G</th></tr></thead><tbody>${lines}</tbody></table>` : ""}
          <span>${parts.join(" · ")}.</span>`;
      } else body = "<span>No value data for this player.</span>";
      return `<tr class="detail"><td colspan="${cols}"><div>${body}</div></td></tr>`;
    };
    const lockBtn = (p) => DH.lockBtn(locked, p);

    // ---------- Regions ----------
    function headHtml() {
      const L = ctx.data.league, st = ctx.data.state || {};
      const meta = `Sleeper · ${L.season} dynasty · ${L.total_rosters} teams · ${result.format.label}${result.hasIdp ? " · IDP" : ""}${st.week && st.season_type === "regular" ? ` · week ${st.week}` : ""}`;
      const extra = Object.values(values.sources).map((s) => `${esc(s.label)}, ${esc(s.updated || "?")}`);
      if (result.format.tepMissing) extra.push(`${esc(result.source.label)} has no TE-premium values; its standard values are used`);
      if (result.hasIdp && idp) {
        const fp = idp.fantasypros || {}, fpAny = fp.LB || fp.DL || fp.DB;
        const seasons = Object.keys(idp.seasons || {}).sort();
        extra.push(`Sleeper IDP stats ${esc(seasons[0])}–${esc(seasons[seasons.length - 1])}, ${esc(idp.updated)}`);
        if (fpAny) extra.push(`FantasyPros dynasty IDP, ${esc(fpAny.updated)} (${fpAny.experts} experts)`);
      }
      const warns = [...(values.warnings || []), ...(result.hasIdp && idp ? idp.warnings || [] : [])];
      return DH.leagueHead(ctx, { meta }) + DH.sourceLine(ctx, extra) + DH.warnBanner(warns);
    }

    function summaryHtml() {
      const me = result.me, n = result.standings.length;
      const short = Object.entries(me.shortfalls).filter(([, v]) => v > 0).map(([k]) => k);
      const cells = [[`${ordinal(me.valueRank)}<small> of ${n}</small>`, `Offensive value · ${esc(result.source.label)} (${int(me.value)})`]];
      if (result.hasIdp) cells.push([`${ordinal(me.idpRank)}<small> of ${n}</small>`, "IDP starters, by IDP value"]);
      cells.push([short.length ? short.join(" · ") : "None", "Depth shortfalls"]);
      cells.push([`${me.rosterCount}<small> / ${result.maxActive}</small>`, `Active roster${me.taxi.length ? ` · ${me.taxi.length} taxi` : ""}${me.ir.length ? ` · ${me.ir.length} IR` : ""}${me.locked ? ` · ${me.locked} locked` : ""}`]);
      if (result.hasIdp) cells.push([`${me.idpCount}<small> / ${result.cfg.idpSpots}</small>`, "IDP players / spots"]);
      cells.push([`$${me.faab}`, "FAAB remaining"]);
      return DH.summary(cells);
    }

    // ---------- Settings ----------
    function knobValues() { return { ...opts(), idpSpots: result.cfg.idpSpots }; }
    function settingsSummary() {
      const saved = ctx.store.get("options", {}) || {};
      const keys = Object.keys(knobs(result)).concat(Object.keys(TRADE_KNOBS));
      const changed = keys.filter((k) => saved[k] != null && Number(saved[k]) !== (k === "idpSpots" ? result.idpSlots.length + 2 : A.DEFAULTS[k]));
      return changed.length ? `${changed.length} setting${changed.length > 1 ? "s" : ""} changed from defaults.` : "All settings are at their defaults.";
    }
    function settingsTab() {
      const source = `<div class="field"><label for="src-${esc(ctx.id)}">Offensive values</label><select id="src-${esc(ctx.id)}" class="source-select" data-source>${
        Object.entries(values.sources).map(([k, s]) => `<option value="${k}"${k === result.source.key ? " selected" : ""}>${esc(s.label)}</option>`).join("")}</select></div>`;
      const team = `<div class="field"><label for="team-${esc(ctx.id)}">Your team</label><select id="team-${esc(ctx.id)}" class="team-select" data-team>${DH.teamOptions(ctx.data, ctx.rosterId)}</select></div>`;
      const mine = result.me.active.concat(result.me.taxi, result.me.ir);
      return `<div class="stack settings-tab">${DH.settingsHtml([
        { title: "League", note: `Settings here apply to ${esc(ctx.data.league.name)} only and are saved in this browser. Values are read in this league's format: ${esc(result.format.label)}.`,
          body: `<div class="pickers">${team}${source}</div>` },
        { title: "Moves", note: "How waiver moves are judged.", body: DH.knobsHtml(ctx, knobs(result), knobValues()) },
        { title: "Trades", note: "How trade ideas are judged. Trades use offensive market value only; IDP has no trade market.", body: DH.knobsHtml(ctx, TRADE_KNOBS, knobValues()) },
        { title: "Locked players", note: "Never suggested as a drop, and never offered in a trade.", body: DH.lockedListHtml(locked, mine, posChips) },
      ])}
      <div class="toolbar"><button type="button" class="more reset" data-reset>Reset settings to defaults</button><span class="muted small" data-r="settings-sum">${esc(settingsSummary())}</span></div></div>`;
    }

    // ---------- Trades ----------
    function tradesTab() {
      const teams = result.standings.length;
      const fmt = {
        meta: (id) => { const p = result.info[id]; return `${posChips(p.groups)} ${esc(p.team)} · ${valueCell(p)} · ${ageFmt(p.age)} yrs ${injTag(p)}`; },
        value: (v) => int(v),
        partner: (rid) => { const t = DH.teamName(ctx.data, rid), o = DH.ownerName(ctx.data, rid); return o && o !== t ? `${t} · ${o}` : t; },
        group: (g) => g,
      };
      const cards = DH.tradeCards(ctx, result.trades, locked, result.info, fmt, teams);
      const tol = Math.round(Number(opts().tradeTolerance) * 100);
      return `<section class="section">
        <div class="section-head"><h2>Trade ideas</h2>
          <p>Each idea is fair on ${esc(result.source.label)} value (within ${tol}%, with a premium for the best player in a 2-for-1, as trade calculators apply), fills a position where the other team is thin, gives you something concrete (better starters and first backups, or clearly more value), and keeps your roster in shape: it won't thin a position where you're at or below your target or pile onto one you've already filled. Non-starters beyond your target count at half value to you. Offense only. Locked, taxi and injured players are left out. <a href="#/${esc(ctx.id)}/settings">Adjust in Settings</a>.</p></div>
        <div class="trades">${cards || `<div class="empty">No trade passes every test right now. Your starters may already beat what a fair deal returns, your spare players may be at positions no team needs, or every fair deal would thin a position you're short at. Loosen trade fairness in <a href="#/${esc(ctx.id)}/settings">Settings</a> to see more.</div>`}</div>
      </section>`;
    }

    function positionsHtml() {
      const info = result.info;
      const labels = { need: "Need", thin: "Thin", solid: "Solid" };
      const fmtV = (p, v) => (p.domain === "off" ? int(v) : v.toFixed(1));
      const card = (p) => {
        const scale = Math.max(p.leagueBest, p.strength) * 1.08 || 1;
        const w = (v) => Math.min(100, (v / scale) * 100).toFixed(1);
        const valOf = (id) => (info[id].domain === "off" ? int(info[id].value) : info[id].value.toFixed(1));
        const starters = p.top.map((id) => `${esc(info[id].name)} <span class="muted">${valOf(id)}</span>`).join("<br>") || "None";
        const wire = p.perStarter ? `${fmtV(p, p.bestFa)} <span class="muted">vs ${fmtV(p, p.perStarter)} per starter</span>` : "–";
        return `<article class="pos-card" data-g="${p.group}">
          <div class="row1"><div class="letter">${p.group}<small>${GROUP_NAMES[p.group]}</small></div><span class="pill ${p.label}">${labels[p.label]}</span></div>
          <div class="meter" role="img" aria-label="Your starters ${fmtV(p, p.strength)}, league average ${fmtV(p, p.leagueAvg)}, best ${fmtV(p, p.leagueBest)}">
            <div class="fill" style="width:${w(p.strength)}%"></div>
            <div class="tick" style="left:${w(p.leagueAvg)}%" title="League average"></div>
            <div class="tick best" style="left:calc(${w(p.leagueBest)}% - 2px)" title="Best in league"></div>
          </div>
          <div class="meter-legend"><span>You ${fmtV(p, p.strength)}</span><span>Avg ${fmtV(p, p.leagueAvg)} · best ${fmtV(p, p.leagueBest)}</span></div>
          <dl class="facts">
            <dt>Starters</dt><dd>${ordinal(p.leagueRank)} of ${p.teams} <span class="muted">(${p.starters.toFixed(1)} start per team)</span></dd>
            <dt>Depth</dt><dd>${p.depth} <span class="muted">(aim for ${p.target}, min ${p.min})</span></dd>
            <dt>Best on wire</dt><dd>${wire}</dd>
            <dt>Top</dt><dd>${starters}</dd>
          </dl>
        </article>`;
      };
      return `<section class="section">
        <div class="section-head"><h2>Positional balance</h2>
          <p>Starter strength is the value of your top players at each position compared with the other ${result.standings.length - 1} teams. Starters per position come from how the league's best lineups actually use the flex spots. The wire row shows whether the best free agent could stand in for a typical starter.</p></div>
        <div class="pos-row">${result.hasIdp ? "<h3>Offense</h3>" : ""}<div class="positions">${result.positions.filter((p) => p.domain === "off").map(card).join("")}</div></div>
        ${result.hasIdp ? `<div class="pos-row"><h3>IDP</h3><div class="positions">${result.positions.filter((p) => p.domain === "idp").map(card).join("")}</div></div>` : ""}
      </section>`;
    }

    function movesHtml() {
      const cfg = result.cfg, moves = result.moves;
      const note = `Planned in order, so later moves account for earlier ones. Fixing a depth shortfall comes first. ${result.hasIdp
        ? `Offense and IDP are managed separately: ${cfg.idpSpots} of your ${result.maxActive} active spots are IDP, and a move only crosses sides to get back to that split. Otherwise a swap must add ${Math.round(cfg.minGain * 100)}% or more value on the same side of the ball.`
        : `Otherwise a swap must add ${Math.round(cfg.minGain * 100)}% or more value.`}${result.me.locked ? ` ${result.me.locked} locked player${result.me.locked > 1 ? "s are" : " is"} never dropped.` : ""}${
        result.unvalued.length ? ` ${result.unvalued.join(" and ").replace(/^./, (c) => c.toUpperCase())} aren't valued here, so they're left out of lineups and never suggested.` : ""}`;
      let body;
      if (!moves.length) {
        const best = result.waivers[0];
        body = `<div class="empty">No clear upgrades on the wire right now. Your weakest active players are close to or better than the best available${best ? `, ${esc(best.name)}` : ""}. Values refresh daily.</div>`;
      } else {
        const kinds = { balance: "Fixes", upgrade: "Upgrade", open: "Open roster spot" };
        body = moves.map((m, i) => {
          const add = m.add, drop = m.drop;
          const why = [`<span class="tag ${m.kind === "balance" ? "warn" : "fit"}">${kinds[m.kind]}${m.fixes.length ? `: ${m.fixes.join(", ")}` : ""}</span>`];
          why.push(m.starts ? `<span class="tag fit">Would start</span>` : `<span class="tag">Bench depth</span>`);
          if (drop && drop.domain === add.domain) {
            const d = add.value - drop.value;
            why.push(`<span>${add.domain === "off" ? `${d >= 0 ? "+" : ""}${int(d)} value` : `${d >= 0 ? "+" : ""}${d.toFixed(1)} pts/g value`}${drop.value ? ` (${d >= 0 ? "+" : ""}${Math.round((d / drop.value) * 100)}%)` : ""}</span>`);
          }
          const side = (p) => `${posChips(p.groups)} ${esc(p.team)} · ${valueCell(p)} · ${ageFmt(p.age)} yrs ${boxTag(p)} ${injTag(p)} ${hotTag(p)}`;
          return `<article class="move">
            <div class="step">${i + 1}</div>
            <div class="side"><span class="verb add">Add</span><span class="nm">${esc(add.name)}</span>
              <span class="meta">${side(add)}</span><span class="meta">${detailCell(add)}</span></div>
            <div class="arrow" aria-hidden="true">⇄</div>
            <div class="side drop"><span class="verb drop">${drop ? "Drop" : "Roster spot"}</span><span class="nm">${drop ? esc(drop.name) : "Open"}</span>
              <span class="meta">${drop ? side(drop) : "No drop needed"}</span>
              ${drop ? `<span class="meta">${detailCell(drop)}</span>${lockBtn(drop)}` : ""}</div>
            <div class="why">${why.join("")}</div>
          </article>`;
        }).join("");
      }
      return `<section class="section"><div class="section-head"><h2>Recommended moves</h2><p>${esc(note)} <a href="#/${esc(ctx.id)}/settings">Adjust in Settings</a>.</p></div><div class="moves">${body}</div></section>`;
    }

    // ---------- Players ----------
    function playerRows() {
      const me = result.me;
      const mine = [
        ...me.active.map((p) => ({ p, mine: true, slot: me.lineup[p.id] || "BN" })),
        ...(view.showTaxi ? me.taxi.map((p) => ({ p, mine: true, slot: "TX" })) : []),
        ...me.ir.map((p) => ({ p, mine: true, slot: "IR" })),
      ];
      const wire = result.waivers.map((p) => ({ p, mine: false, slot: "FA" }));
      const q = view.wireQuery.trim().toLowerCase();
      const f = result.hasIdp ? view.wirePos : (["idp", "DL", "LB", "DB"].includes(view.wirePos) ? "off" : view.wirePos);
      const rows = mine.concat(wire).filter(({ p }) =>
        (p.domain === f || p.groups.includes(f)) &&
        (!q || p.name.toLowerCase().includes(q) || (p.team || "").toLowerCase().includes(q)));
      // Offense and IDP are never listed together, so values always share a scale.
      const val = (a, b) => b.value - a.value;
      const by = {
        value: val,
        fit: (a, b) => b.fit - a.fit,
        trend: (a, b) => (b.trend || 0) - (a.trend || 0) || val(a, b),
        age: (a, b) => (a.age ?? 99) - (b.age ?? 99) || val(a, b),
        hot: (a, b) => b.trending - a.trending || val(a, b),
      }[view.wireSort];
      rows.sort((x, y) => by(x.p, y.p));
      rows.forEach((r, i) => { r.rank = i + 1; }); // rank among yours and the wire, whatever is shown
      return rows.filter((r) => view.wireShow === "both" || (view.wireShow === "mine") === r.mine);
    }

    function playersTable() {
      const rows = playerRows();
      const maxFit = Math.max(...result.waivers.map((p) => p.fit), ...result.me.active.map((p) => p.fit || 0), 0.01);
      let count = view.wireShown;
      if (count == null) {
        let last = -1;
        rows.forEach((r, i) => { if (r.mine) last = i; });
        count = Math.min(AUTO_MAX, Math.max(PAGE, last + 6));
      }
      const shown = rows.slice(0, count);
      const body = shown.map(({ p, mine, slot, rank }) => {
        let action;
        if (mine) action = slot === "TX" || slot === "IR" ? '<span class="muted small">Never dropped</span>' : lockBtn(p);
        else {
          const d = p.drop && p.drop !== "open" ? result.info[p.drop] : null;
          action = p.drop === "open" ? '<span class="muted">Open spot</span>'
            : d ? `${esc(d.name)} <span class="muted">${d.domain === "off" ? int(d.value) : d.value.toFixed(1)}</span>${p.dropKind === "balance" ? ' <span class="tag warn">depth</span>' : ""}`
            : '<span class="muted">Not an upgrade</span>';
        }
        const boost = !mine && p.needGroup && result.needs[p.needGroup] >= 0.15 ? ` <span class="tag fit">${p.needGroup} need</span>` : "";
        const fit = p.fit || 0;
        return `<tr class="${mine ? "mine" : ""}">
          <td class="num muted">${rank}</td>
          <td class="slot">${mine ? esc(DH.fmt.slot(slot)) : '<span class="muted">FA</span>'}</td>
          <td>${nameCell(p)}</td><td>${posChips(p.groups)}</td>
          <td class="num">${ageFmt(p.age)}</td><td class="num">${valueCell(p)}</td>
          <td style="white-space:nowrap"><span class="fitbar"><i style="width:${(fit / maxFit * 100).toFixed(0)}%"></i></span>${fit.toFixed(2)}${boost}</td>
          <td>${action}</td>
        </tr>${view.open.has(p.id) ? detailRow(p, 8) : ""}`;
      }).join("") || `<tr><td colspan="8" class="muted">No players match.</td></tr>`;
      const rest = rows.length - shown.length;
      return `<div class="table-wrap"><table>
          <thead><tr><th class="num">#</th><th>Slot</th><th>Player</th><th>Pos</th><th class="num">Age</th><th class="num">Value</th><th>Fit</th><th>Drop for / keep</th></tr></thead>
          <tbody>${body}</tbody></table></div>
        ${rest > 0 ? `<button type="button" class="more" data-more="${shown.length}">Show ${Math.min(PAGE, rest)} more of ${rest}</button>` : ""}`;
    }

    function playersTab() {
      const seg = (vals) => vals.map(([v, l]) => `<button type="button" data-pos="${v}" aria-pressed="${view.wirePos === v}">${l}</button>`).join("");
      const sort = [["value", "Value"], ["fit", "Best fit for my roster"], ["trend", "Rising (30 days)"], ["age", "Youngest first"], ["hot", "Most added on Sleeper"]];
      return `<section class="section">
        <div class="section-head"><h2>Players</h2>
          <p>Your roster and the waiver wire in one list, so you can see where each free agent would slot in.${result.hasIdp ? " Offense and IDP are listed separately, since their values aren't on the same scale." : ""} <span class="mine-key">Your players</span> are highlighted; taxi players are hidden unless you show them. Fit is value boosted at positions where you're thin. Lock one of your players to keep him out of drop suggestions.</p></div>
        <div class="toolbar">
          <div class="seg" role="group" aria-label="Offense position filter">${seg([["off", "Offense"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"]])}</div>
          ${result.hasIdp ? `<div class="seg" role="group" aria-label="IDP position filter">${seg([["idp", "IDP"], ["DL", "DL"], ["LB", "LB"], ["DB", "DB"]])}</div>` : ""}
          <div class="seg" role="group" aria-label="Whose players">${[["both", "Both"], ["wire", "Wire"], ["mine", "Mine"]].map(([v, l]) => `<button type="button" data-show="${v}" aria-pressed="${view.wireShow === v}">${l}</button>`).join("")}</div>
          <div class="seg"><button type="button" data-taxi aria-pressed="${view.showTaxi}" title="Taxi players can't move in season; show them where their value ranks">Show taxi</button></div>
          <label class="small muted" for="sort-${esc(ctx.id)}">Sort</label>
          <select id="sort-${esc(ctx.id)}" data-sort>${sort.map(([v, l]) => `<option value="${v}"${view.wireSort === v ? " selected" : ""}>${l}</option>`).join("")}</select>
          <input type="search" data-search placeholder="Search players" aria-label="Search players" value="${esc(view.wireQuery)}">
        </div>
        <div data-r="players" class="section">${playersTable()}</div>
      </section>`;
    }

    // ---------- League ----------
    function leagueTab() {
      const s = result.standings;
      const byIdp = s.slice().sort((a, b) => b.idpValue - a.idpValue).map((x) => x.rosterId);
      const byOff = s.slice().sort((a, b) => b.offStarters - a.offStarters).map((x) => x.rosterId);
      const rows = s.map((t, i) => `<tr class="${String(t.rosterId) === String(result.me.rosterId) ? "me" : ""}">
          <td class="num">${i + 1}</td><td>${esc(DH.teamName(ctx.data, t.rosterId))}</td>
          <td class="num">${int(t.value)}</td>
          <td class="num">${int(t.offStarters)} <span class="muted small">(${ordinal(byOff.indexOf(t.rosterId) + 1)})</span></td>
          ${result.hasIdp ? `<td class="num">${t.idpValue.toFixed(1)} <span class="muted small">(${ordinal(byIdp.indexOf(t.rosterId) + 1)})</span></td>` : ""}
        </tr>`).join("");
      const um = Object.values(values.sources).flatMap((x) => (x.unmatched || []).map((n) => `${n} (${x.label})`))
        .concat(result.hasIdp && idp ? Object.entries(idp.fantasypros || {}).flatMap(([g, v]) => (v.unmatched || []).map((n) => `${n} (FantasyPros ${g})`)) : []);
      return `<section class="section">
        <div class="section-head"><h2>League value</h2>
          <p>${esc(result.source.label)} value (${esc(result.format.label)}) of every offensive player on each roster, taxi and IR included (draft picks aren't counted yet). Offensive starters is the value of each team's best offensive lineup.${result.hasIdp ? " IDP starters is the IDP value (points per game) of each team's best defenders." : ""}</p></div>
        <div class="table-wrap"><table>
          <thead><tr><th class="num">#</th><th>Team</th><th class="num">${esc(result.source.label)} value</th><th class="num">Offensive starters</th>${result.hasIdp ? '<th class="num">IDP starters</th>' : ""}</tr></thead>
          <tbody>${rows}</tbody></table></div>
      </section>
      <footer>
        <p><strong>Offense.</strong> Values come from <a href="https://keeptradecut.com/dynasty-rankings" target="_blank" rel="noopener">KeepTradeCut</a> or <a href="https://dynasty-daddy.com/" target="_blank" rel="noopener">Dynasty Daddy</a>, picked in the menu at the top, in this league's format: ${esc(result.format.label)}. Superflex is used when the league has a superflex slot or two QB slots; the TE-premium level follows KeepTradeCut's own guidance (TE slots and the TE reception bonus). The other source is shown alongside for comparison. With the win-now setting above 0, each source's redraft values are blended in.</p>
        ${result.hasIdp ? `<p><strong>IDP.</strong> Neither source values defenders, so IDP value is built from Sleeper stats for the last three seasons, scored with this league's settings. This season counts most. A player's own big plays are mostly replaced by the position average for his snaps, so tackles and sacks drive value. His per-snap production is projected at the snaps he's playing now, short samples are pulled toward a replacement-level player, and value is discounted with age. It's then blended with the free <a href="https://www.fantasypros.com/nfl/rankings/dynasty-lb.php" target="_blank" rel="noopener">FantasyPros dynasty DL / LB / DB rankings</a>: the #k player there is worth what the model's #k player is worth. The unit is roughly points per game; the small number after it is points per game above a waiver-level player at his position.</p>` : ""}
        <p><strong>Moves.</strong> A roster keeps enough players at each position to fill its dedicated starting slots plus one (${Object.entries(result.minDepth).filter(([, v]) => v).map(([g, v]) => `${v} ${g}`).join(", ")}; dual-eligible players count for both).${result.hasIdp ? " Offense and IDP are managed separately: the Settings tab sets how many active roster spots are IDP, and a move only swaps an offensive player for a defender (or back) to restore that split. Every other move stays on one side of the ball and is judged by that side's own values." : ""} Moves that fix a shortfall come first. Taxi and IR players are never dropped, and neither is anyone you lock.</p>
        <p><strong>Refreshing data.</strong> Your league loads live from Sleeper every time you open it. Values${result.hasIdp ? ", IDP stats" : ""} and rankings are refreshed once a day by a scheduled GitHub Action ("Refresh data and deploy" on the repository's Actions tab).</p>
        <p>${um.length ? `Not matched to a Sleeper player: ${esc(um.join(", "))}.` : "Every ranked player was matched to a Sleeper player."}</p>
      </footer>`;
    }

    // ---------- Assemble ----------
    function tabBody() {
      if (ctx.tab === "team") return `${positionsHtml()}${playersTab()}`;
      if (ctx.tab === "league") return leagueTab();
      if (ctx.tab === "trades") return tradesTab();
      if (ctx.tab === "settings") return settingsTab();
      if (ctx.tab === "matchup") {
        const pos = (id) => (ctx.data.players[id] && ctx.data.players[id].fantasy_positions) || (/^[A-Z]{2,3}$/.test(id) ? ["DEF"] : []);
        return DH.matchupHtml(ctx, {
          sport: "nfl", chips: posChips, groupsOf: pos,
          fits: (id, slot) => pos(id).some((g) => (SLOT_POS[slot] || []).includes(g)),
          spread: (pts) => (pts > 0 ? 0.45 * pts + 2 : 0),
        });
      }
      if (ctx.tab === "draft") return DH.draftHtml(ctx, result.rookieDraft, result.me.rosterId, {
        basis: `${result.source.label} value`, rank: (p) => int(p.value),
        sub: (p) => `${posChips(p.groups)} ${esc(p.team)} · ${ageFmt(p.age)} yrs`,
      });
      return movesHtml();
    }
    function draw() {
      const tabs = DH.visibleTabs(TABS, result.rookieDraft, ctx.data.league);
      DH.settleTab(ctx, tabs);
      el.innerHTML = `${headHtml()}<div data-r="summary">${summaryHtml()}</div>${DH.subtabs(ctx, tabs)}<div class="stack">${tabBody()}</div>`;
    }
    // A slider moved: recompute, refresh the summary and readouts, leave the sliders alone.
    function redrawAfterTuning() {
      analyze();
      el.querySelector('[data-r="summary"]').innerHTML = summaryHtml();
      const K = { ...knobs(result), ...TRADE_KNOBS }, v = knobValues();
      for (const out of el.querySelectorAll("[data-out]")) out.textContent = K[out.dataset.out].fmt(Number(v[out.dataset.out]));
      el.querySelector('[data-r="settings-sum"]').textContent = settingsSummary();
    }
    const redrawPlayers = () => { const r = el.querySelector('[data-r="players"]'); if (r) r.innerHTML = playersTable(); };
    draw();

    // ---------- Events (assigned, not added, so redraws don't stack handlers) ----------
    el.onchange = (e) => {
      const t = e.target;
      if (t.matches("[data-team]")) return ctx.setTeam(t.value);
      if (t.matches("[data-source]")) { ctx.store.set("options", { ...(ctx.store.get("options", {}) || {}), source: t.value }); return ctx.rerender(); }
      if (t.matches("[data-sort]")) { view.wireSort = t.value; view.wireShown = null; return redrawPlayers(); }
    };
    el.oninput = (e) => {
      const t = e.target;
      if (t.matches("[data-knob]")) {
        ctx.store.set("options", { ...(ctx.store.get("options", {}) || {}), [t.dataset.knob]: Number(t.value) });
        return redrawAfterTuning();
      }
      if (t.matches("[data-search]")) { view.wireQuery = t.value; view.wireShown = null; return redrawPlayers(); }
    };
    el.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b || !el.contains(b)) return;
      if (b.dataset.lock) {
        const id = b.dataset.lock;
        locked.has(id) ? locked.delete(id) : locked.add(id);
        ctx.store.set("locked", [...locked]);
        ctx.rerender();
        return DH.refocus(`button[data-lock="${CSS.escape(id)}"]`);
      }
      if (b.hasAttribute("data-reset")) {
        const keep = (ctx.store.get("options", {}) || {}).source;
        ctx.store.set("options", keep ? { source: keep } : {});
        return ctx.rerender();
      }
      if (b.dataset.open) {
        view.open.has(b.dataset.open) ? view.open.delete(b.dataset.open) : view.open.add(b.dataset.open);
        redrawPlayers();
        return DH.refocus(`button[data-open="${CSS.escape(b.dataset.open)}"]`);
      }
      if (b.dataset.pos) {
        view.wirePos = b.dataset.pos; view.wireShown = null;
        for (const x of el.querySelectorAll("button[data-pos]")) x.setAttribute("aria-pressed", String(x === b));
        return redrawPlayers();
      }
      if (b.dataset.show) {
        view.wireShow = b.dataset.show; view.wireShown = null;
        for (const x of el.querySelectorAll("button[data-show]")) x.setAttribute("aria-pressed", String(x === b));
        return redrawPlayers();
      }
      if (b.hasAttribute("data-taxi")) {
        view.showTaxi = !view.showTaxi; view.wireShown = null;
        b.setAttribute("aria-pressed", String(view.showTaxi));
        return redrawPlayers();
      }
      if (b.dataset.more) { view.wireShown = Number(b.dataset.more) + PAGE; return redrawPlayers(); }
    };
  }

  DH.sports.nfl = {
    id: "nfl", label: "Football", short: "NFL",
    playersGlobal: "SLEEPER_PLAYERS_NFL",
    files: (league) => ["data/nfl/players.js", "data/nfl/values.js", "nfl/analysis.js"].concat(hasIdpSlots(league) ? ["data/nfl/idp.js"] : []),
    tabs: TABS,
    render,
  };
})();
