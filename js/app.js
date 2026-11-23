import { CONFIG } from './config.js';
import * as D from './data.js';
import * as E from './engine.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const S = { tab: localStorage.getItem('dhq-tab') || 'teams', ui: {}, mode: 'dyn' };
try { localStorage.removeItem('dhq-mode'); } catch { /* ignore */ }
const fmt = n => (n == null || isNaN(n) ? '–' : Math.round(n).toLocaleString());
const f1 = n => (n == null || isNaN(n) ? '–' : (Math.round(n * 10) / 10).toFixed(1));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- boot ----------------
const log = (msg, cls = '') => { const el = $('#bootlog'); if (el) el.innerHTML += `<span class="${cls}">${esc(msg)}</span>\n`; };

async function boot() {
  try {
    log('> connecting to sleeper…');
    const [state, league] = await Promise.all([D.sleeper.state(), D.resolveLeague(CONFIG.leagueId)]);
    S.state = state; S.league = league;
    const lid = league.league_id;
    log(`> ${league.name} · ${league.season} · ${league.status}`);
    const [users, rosters, traded, drafts] = await Promise.all([
      D.sleeper.users(lid), D.sleeper.rosters(lid), D.sleeper.traded(lid), D.sleeper.drafts(lid).catch(() => []),
    ]);
    S.users = Object.fromEntries(users.map(u => [u.user_id, u]));
    S.rosters = rosters.sort((a, b) => a.roster_id - b.roster_id);
    S.traded = traded; S.drafts = drafts;
    S.teams = Object.fromEntries(rosters.map(r => {
      const u = S.users[r.owner_id] || {};
      return [r.roster_id, { rid: r.roster_id, name: u.metadata?.team_name || u.display_name || `Team ${r.roster_id}`, user: u.display_name || '—', roster: r }];
    }));
    const me = rosters.find(r => (S.users[r.owner_id]?.display_name || '').toLowerCase() === CONFIG.myUsername.toLowerCase());
    S.myRid = me?.roster_id ?? rosters[0].roster_id;
    S.rostered = new Map();
    for (const r of rosters) for (const pid of r.players || []) S.rostered.set(pid, r.roster_id);

    log('> loading player universe…');
    const season = Number(league.season);
    const [players, cur, prev, market, rookies, trending, games] = await Promise.all([
      D.loadPlayers(new Set(S.rostered.keys())),
      D.loadSeasonPts(season, league.scoring_settings, lid, true),
      D.loadSeasonPts(season - 1, league.scoring_settings, lid, false),
      D.loadMarket().catch(e => { log('! market values unavailable: ' + e.message, 'err'); return { market: {}, capital: {}, pickRows: [], classRows: [] }; }),
      D.loadRookieBoard(),
      D.sleeper.trending().catch(() => []),
      D.loadGames(season).catch(() => []),
    ]);
    S.players = players; S.games = games; S.trending = Object.fromEntries(trending.map(t => [t.player_id, t.count]));
    S.mk = market;
    log(`> ${Object.keys(players).length} players · ${Object.keys(market.market).length} market values · ${games.length} games`);

    log('> computing league-specific dynasty values…');
    const prod = {};
    for (const pid in players) prod[pid] = { cur: cur[pid], prev: prev[pid] };
    const { values, repl } = E.computeValues({
      players, prod, market: market.market, capital: market.capital, league, teams: rosters.length, marketWeight: CONFIG.marketWeight, idpWeight: CONFIG.idpWeight, rostered: new Set(S.rostered.keys()),
    });
    S.values = values; S.repl = repl;
    trackValueDeltas(values);

    computePicksAndDraft(rookies);
    S.loaded = true;
    render();
    loadWeekly(); // async: projections + recent form
  } catch (e) {
    console.error(e);
    log('! ' + e.message, 'err');
    log('! check your connection and reload. If Sleeper is down, try again later.', 'err');
  }
}

function modeValues() { const o = {}; for (const k in S.values) o[k] = { value: S.values[k][S.mode] }; return o; }
function refreshDerived() { const t = E.teamNeeds(S.rosters, S.players, modeValues()); S.strength = t.strength; }
function trackValueDeltas(values) {
  try {
    const raw = JSON.parse(localStorage.getItem('dhq-vsnap') || 'null');
    const now = Date.now();
    const cur = Object.fromEntries(Object.entries(values).filter(([, v]) => v.dyn > 200).map(([k, v]) => [k, v.dyn]));
    if (!raw) { localStorage.setItem('dhq-vsnap', JSON.stringify({ t: now, prev: cur, cur })); S.prevVals = {}; return; }
    if (now - raw.t > 20 * 3600e3) { localStorage.setItem('dhq-vsnap', JSON.stringify({ t: now, prev: raw.cur, cur })); S.prevVals = raw.cur; }
    else S.prevVals = raw.prev || {};
  } catch { S.prevVals = {}; }
}

function computePicksAndDraft(rookieFile) {
  const L = S.league, teams = S.rosters.length;
  const pm = E.pickValueModel(S.mk.pickRows || [], teams);
  const preDraft = ['pre_draft', 'drafting'].includes(L.status);
  const draftSeason = preDraft ? Number(L.season) : Number(L.season) + 1;
  const seasons = [draftSeason, draftSeason + 1, draftSeason + 2];
  const rounds = L.settings?.draft_rounds || 5;
  const upcoming = (S.drafts || []).find(d => Number(d.season) === draftSeason && d.status !== 'complete');
  const order = E.projectedOrder(S.rosters, upcoming?.slot_to_roster_id);
  const official = !!(upcoming?.slot_to_roster_id && Object.keys(upcoming.slot_to_roster_id).length === teams);
  const wk = S.state.season_type === 'regular' ? (S.state.week || 0) : 18;
  const certainty = official || preDraft || S.state.season_type !== 'regular' ? 1 : Math.min(1, Math.max(0.15, wk / 18));
  const own = E.pickOwnership(S.rosters, S.traded, seasons, rounds);
  S.picks = E.valuePicks(own, { draftSeason, order, teams, certainty, pm });
  S.draft = { draftSeason, rounds, order, official, certainty, seasons };

  // Rookie board: live NFL-drafted class from DynastyProcess when it exists, else seeded pre-draft board.
  const cls = (S.mk.classRows || []).filter(r => r.dy === draftSeason);
  const offLive = cls.filter(r => r.market && ['QB', 'RB', 'WR', 'TE'].includes(r.pos)).sort((a, b) => b.market - a.market);
  let offense, idp, source;
  if (offLive.length >= 24) {
    offense = offLive.map((r, i) => ({ rank: i + 1, name: r.name, pos: r.pos, school: '', sid: r.sid }));
    idp = cls.filter(r => r.do && E.IDP.includes(E.groupOf(r.pos))).sort((a, b) => a.do - b.do).slice(0, 50)
      .map(r => ({ rank: Math.round(r.do / 2), name: r.name, pos: r.pos, school: r.school || '', sid: r.sid }));
    source = 'live: DynastyProcess rookie values + NFL draft capital';
  } else if (rookieFile && Number(rookieFile.draftSeason) === draftSeason) {
    offense = rookieFile.offense; idp = rookieFile.idp; source = `pre-draft board (updated ${rookieFile.updated})`;
  } else { offense = []; idp = []; source = 'no board yet for ' + draftSeason; }
  S.board = E.buildRookieBoard({ offense, idp, pm });
  S.boardSource = source;

  const { needs, strength } = E.teamNeeds(S.rosters, S.players, modeValues());
  S.needs = needs; S.strength = strength;
  const draftPicks = S.picks.filter(p => p.season === draftSeason).sort((a, b) => a.overall - b.overall);
  S.mock = E.mockDraft(draftPicks, S.board, needs);
}

async function loadWeekly() {
  const st = S.state, L = S.league, season = Number(L.season);
  const inSeason = st.season_type === 'regular' && Number(st.season) === season;
  const week = inSeason ? st.week : null;
  S.week = week;
  S.proj = {}; S.recent = {};
  if (!week) { S.weeklyReady = true; if (['lineup', 'waivers'].includes(S.tab)) render(); return; }
  const sc = L.scoring_settings, lid = L.league_id;
  const back = [week - 1, week - 2, week - 3].filter(w => w >= 1);
  const [proj, matchups, ...wks] = await Promise.all([
    D.loadProjections(season, week, sc, lid).catch(() => ({})),
    D.sleeper.matchups(lid, week).catch(() => []),
    ...back.map(w => D.loadWeekPts(season, w, sc, lid).catch(() => ({}))),
  ]);
  S.proj = proj; S.matchups = matchups;
  const acc = {};
  for (const wk of wks) for (const pid in wk) { (acc[pid] ||= []).push(wk[pid]); }
  for (const pid in acc) S.recent[pid] = acc[pid].reduce((a, b) => a + b, 0) / acc[pid].length;
  S.ctx = E.gameContext(S.games.filter(g => g.w === week));
  S.weeklyReady = true;
  if (['lineup', 'waivers'].includes(S.tab)) render();
}

// ---------------- helpers ----------------
const P = pid => S.players[pid] || { n: `#${pid}`, pos: '?', fp: [] };
const V = pid => S.values[pid]?.[S.mode] || 0;
const pos = pid => E.primaryPos(P(pid));
const posTag = p => `<span class="pos ${p}">${p}</span>`;
const teamName = rid => S.teams[rid]?.name || `Team ${rid}`;
const picksOf = rid => S.picks.filter(p => p.owner === rid).sort((a, b) => a.season - b.season || a.round - b.round || (a.overall || 0) - (b.overall || 0));
function tags(pid, roster) {
  let t = '';
  if (roster?.taxi?.includes(pid)) t += '<span class="tag taxi">TAXI</span>';
  if (roster?.reserve?.includes(pid)) t += '<span class="tag ir">IR</span>';
  const inj = P(pid).inj; if (inj && !roster?.reserve?.includes(pid)) t += `<span class="tag q">${esc(inj)}</span>`;
  return t;
}
function delta(pid) {
  const prev = S.prevVals?.[pid]; if (!prev || S.mode !== 'dyn') return '';
  const d = V(pid) - prev; if (Math.abs(d) < 25) return '';
  return `<span class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'}${fmt(Math.abs(d))}</span>`;
}
const age = pid => { const a = P(pid).age; return a ? a : '–'; };
function proj(pid) {
  const p = P(pid); if (!S.ctx) return { pts: 0, flags: [] };
  return E.projectPlayer({ p, pos: pos(pid), projPts: S.proj[pid], recent: S.recent[pid], ppg: S.values[pid]?.ppg || 0, ctx: S.ctx });
}
function teamSummary(rid) {
  const r = S.teams[rid].roster, pids = r.players || [];
  const pv = pids.reduce((a, pid) => a + V(pid), 0);
  const str = S.strength[rid]; const starters = Object.values(str).reduce((a, b) => a + b, 0);
  const pk = picksOf(rid).reduce((a, p) => a + p.value, 0);
  const top = pids.map(pid => ({ pid, v: V(pid) })).sort((a, b) => b.v - a.v).slice(0, 20);
  const ages = top.map(x => P(x.pid).age).filter(Boolean);
  return { rid, pv, starters, pk, total: pv + pk, age: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
    w: r.settings?.wins || 0, l: r.settings?.losses || 0, pf: (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100 };
}
function tradeLocked() {
  const st = S.state, dl = S.league.settings?.trade_deadline;
  return st.season_type === 'regular' && dl && dl < 99 && st.week > dl;
}

// ---------------- render ----------------
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  if (!S.loaded) return;
  const L = S.league, st = S.state;
  $('#meta').innerHTML = `${esc(L.name)}<br>${L.season} · ${st.season_type === 'regular' ? 'WK ' + st.week : st.season_type}`;
  $('#foot').innerHTML = `Live: Sleeper API (rosters, picks, stats, projections) · Market: <a href="https://github.com/dynastyprocess/data" target="_blank">DynastyProcess</a> superflex values blended ${Math.round(CONFIG.marketWeight * 100)}/${100 - Math.round(CONFIG.marketWeight * 100)} with a model built on your league's scoring (IDP = model only) · Schedule & Vegas lines: nflverse · Rookies: ${esc(S.boardSource)}<br><button class="btn ghost" id="refresh">↻ force refresh</button>`;
  ({ teams: renderTeams, trade: renderTrade, draft: renderDraft, lineup: renderLineup, waivers: renderWaivers })[S.tab]();
}

// ---- TEAMS ----
function renderTeams() {
  const sum = S.rosters.map(r => teamSummary(r.roster_id));
  const sortKey = S.ui.teamSort || 'total';
  sum.sort((a, b) => sortKey === 'age' ? (a.age || 99) - (b.age || 99) : b[sortKey] - a[sortKey]);
  const max = Math.max(...sum.map(s => s.total));
  const open = S.ui.openTeam;
  let h = `<h2>POWER RANKINGS <small>dynasty value = players + picks · tap a team</small></h2><div class="tw"><table><thead><tr>
    <th>#</th><th>TEAM</th><th class="num">W-L</th><th class="num sort" data-ts="starters">STARTERS</th><th class="num sort" data-ts="pv">ROSTER</th><th class="num sort" data-ts="pk">PICKS</th><th class="num sort" data-ts="total">TOTAL</th><th class="num sort" data-ts="age">AGE</th><th style="width:80px"></th></tr></thead><tbody>`;
  sum.forEach((s, i) => {
    h += `<tr class="click ${s.rid === S.myRid ? 'me' : ''}" data-team="${s.rid}"><td class="dim">${i + 1}</td><td class="hi">${esc(teamName(s.rid))}<div class="dim" style="font-size:10px">${esc(S.teams[s.rid].user)}</div></td>
      <td class="num">${s.w}-${s.l}</td><td class="num">${fmt(s.starters)}</td><td class="num">${fmt(s.pv)}</td><td class="num">${fmt(s.pk)}</td><td class="num hi">${fmt(s.total)}</td><td class="num">${s.age ? s.age.toFixed(1) : '–'}</td>
      <td><div class="bar"><i style="width:${(s.total / max) * 100}%"></i></div></td></tr>`;
    if (open === s.rid) h += `<tr class="sub"><td colspan="9">${rosterDetail(s.rid)}</td></tr>`;
  });
  h += '</tbody></table></div><p class="note">STARTERS = value of each team\'s best QB×2, RB×3, WR×4, TE, K, DL×3, LB×3, DB×3. ▲▼ = value change since yesterday.</p>';
  view.innerHTML = h;
}
function rosterDetail(rid) {
  const r = S.teams[rid].roster;
  const pids = (r.players || []).slice().sort((a, b) => E.GROUPS.indexOf(pos(a)) - E.GROUPS.indexOf(pos(b)) || V(b) - V(a));
  let h = '<div class="tw"><table><thead><tr><th>POS</th><th>PLAYER</th><th>NFL</th><th class="num">AGE</th><th class="num">PPG</th><th class="num">VALUE</th><th class="num">Δ</th></tr></thead><tbody>';
  for (const pid of pids) {
    const p = P(pid);
    h += `<tr><td>${posTag(pos(pid))}</td><td class="hi">${esc(p.n)}${tags(pid, r)}</td><td class="dim">${p.team || 'FA'}</td><td class="num">${age(pid)}</td><td class="num">${f1(S.values[pid]?.ppg)}</td><td class="num hi">${fmt(V(pid))}</td><td class="num">${delta(pid)}</td></tr>`;
  }
  h += '</tbody></table></div><h2>PICKS</h2><div class="chips">';
  for (const p of picksOf(rid)) h += `<span class="chip">${p.label}${p.orig !== rid ? ' <span class="dim">via ' + esc(teamName(p.orig)) + '</span>' : ''} · ${fmt(p.value)}</span>`;
  return h + '</div>';
}

// ---- TRADE ----
function assetsOf(rid) {
  const r = S.teams[rid].roster;
  const pl = (r.players || []).map(pid => ({ id: pid, type: 'p', label: P(pid).n, pos: pos(pid), value: V(pid), taxi: r.taxi?.includes(pid), rid }));
  const pk = picksOf(rid).map(p => ({ id: p.id, type: 'k', label: p.label, pos: 'PK', value: p.value, round: p.round, rid }));
  return [...pl.sort((a, b) => b.value - a.value), ...pk];
}
function renderTrade() {
  const sub = S.ui.tradeSub || 'find';
  const subnav = `<div class="chips" style="margin-bottom:10px"><button class="chip ${sub === 'find' ? 'on' : ''}" data-tsub="find">RECOMMENDED TRADES</button><button class="chip ${sub === 'calc' ? 'on' : ''}" data-tsub="calc">CALCULATOR</button></div>`;
  if (sub === 'find') { view.innerHTML = subnav + renderFinder(); return; }
  const T = (S.ui.trade ||= { a: S.myRid, b: S.rosters.find(r => r.roster_id !== S.myRid).roster_id, sa: [], sb: [], qa: '', qb: '' });
  const A = assetsOf(T.a), B = assetsOf(T.b);
  const pickA = A.filter(x => T.sa.includes(x.id)), pickB = B.filter(x => T.sb.includes(x.id));
  const sa = E.tradeSide(pickA.map(x => x.value)), sb = E.tradeSide(pickB.map(x => x.value));
  const v = E.tradeVerdict(sa, sb);
  const opts = sel => S.rosters.map(r => `<option value="${r.roster_id}" ${r.roster_id === sel ? 'selected' : ''}>${esc(teamName(r.roster_id))}</option>`).join('');
  const side = (key, rid, list, chosen, q) => `<div class="panel"><div class="row"><select data-side="${key}" class="grow">${opts(rid)}</select></div>
    <div class="note">${key === 'a' ? 'SENDS ↓' : 'SENDS ↓'}</div>
    <div class="sel">${chosen.map(x => `<span data-rm="${key}:${x.id}">${x.type === 'p' ? posTag(x.pos) : ''} ${esc(x.label)} · ${fmt(x.value)} ✕</span>`).join('') || '<span class="dim" style="border:0;background:none">nothing selected</span>'}</div>
    <input type="search" placeholder="filter…" data-q="${key}" value="${esc(q)}">
    <div class="list">${list.filter(x => !q || x.label.toLowerCase().includes(q.toLowerCase())).map(x => `<label><input type="checkbox" data-pick="${key}" value="${x.id}" ${(key === 'a' ? T.sa : T.sb).includes(x.id) ? 'checked' : ''}>
      ${x.type === 'p' ? posTag(x.pos) : '<span class="pos">PK</span>'} <span class="grow hi">${esc(x.label)}</span>${x.taxi ? '<span class="tag taxi">TAXI</span>' : ''}<span class="num">${fmt(x.value)}</span></label>`).join('')}</div></div>`;
  // warnings: taxi steal rule
  const warn = [];
  const minR = CONFIG.houseRules.taxiStealMinRound;
  const chk = (sent, other, who) => {
    const taxis = sent.filter(x => x.taxi);
    if (taxis.length && !other.some(x => x.type === 'k' && x.round <= minR))
      warn.push(`TAXI STEAL RULE: ${taxis.map(x => x.label).join(', ')} is on ${esc(teamName(who))}'s taxi — the offer must include at least a round-${minR} pick. If declined, the owner must promote him to the active roster.`);
  };
  chk(pickA, pickB, T.a); chk(pickB, pickA, T.b);
  // balance suggestion
  let sug = '';
  if (pickA.length && pickB.length && v.text !== 'FAIR') {
    const shortRid = sa.adj > sb.adj ? T.b : T.a; const already = sa.adj > sb.adj ? T.sb : T.sa;
    const gap = Math.abs(sa.adj - sb.adj);
    const cand = assetsOf(shortRid).filter(x => !already.includes(x.id) && x.value > 0).sort((x, y) => Math.abs(x.value - gap) - Math.abs(y.value - gap)).slice(0, 4);
    sug = `<div class="note">To balance, <b class="hi">${esc(teamName(shortRid))}</b> adds ~${fmt(gap)}: ${cand.map(x => `${esc(x.label)} (${fmt(x.value)})`).join(' · ')}</div>`;
  }
  const max = Math.max(sa.adj, sb.adj, 1);
  view.innerHTML = subnav + `${tradeLocked() ? `<div class="banner">TRADES LOCKED — deadline was week ${S.league.settings.trade_deadline}. Reopens for the rookie draft. Calculator still works for planning.</div>` : ''}
    <div class="panel"><div class="row"><div class="grow"><div class="dim">${esc(teamName(T.a))} sends</div><div class="big">${fmt(sa.adj)}</div><div class="bar"><i style="width:${(sa.adj / max) * 100}%"></i></div></div>
    <div class="grow" style="text-align:right"><div class="dim">${esc(teamName(T.b))} sends</div><div class="big">${fmt(sb.adj)}</div><div class="bar" style="direction:rtl"><i style="width:${(sb.adj / max) * 100}%"></i></div></div></div>
    <div style="text-align:center;margin-top:8px" class="verdict ${v.text === 'FAIR' ? 'up' : 'amb'}">${v.text === 'FAIR' ? 'FAIR TRADE' : (v.diff > 0 ? esc(teamName(T.b)) : esc(teamName(T.a))) + ' WINS BY ' + fmt(Math.abs(v.diff))} <span class="dim">(${(Math.abs(v.pct) * 100).toFixed(0)}%)</span></div>
    ${sug}<div class="note">Adjusted totals give a premium to the side getting the best single asset (2 nickels ≠ a quarter). Raw sums: ${fmt(sa.raw)} vs ${fmt(sb.raw)}.</div></div>
    ${warn.map(w => `<div class="banner red">${w}</div>`).join('')}
    <div class="cols">${side('a', T.a, A, pickA, T.qa)}${side('b', T.b, B, pickB, T.qb)}</div>`;
}


function renderFinder() {
  const rid = S.ui.finderRid ?? S.myRid;
  const key = `${rid}:${S.mode}`;
  if (!S.finderCache || S.finderCache.key !== key) {
    const val = {}; for (const k in S.values) val[k] = S.values[k][S.mode];
    const rank = {}; E.standings(S.rosters).forEach((s, i) => (rank[s.rid] = i + 1));
    S.finderCache = { key, list: E.findTrades({ me: rid, rosters: S.rosters, players: S.players, val, picks: S.picks, standingsRank: rank, taxiMinRound: CONFIG.houseRules.taxiStealMinRound }) };
  }
  const list = S.finderCache.list;
  const label = x => x.kind === 'p' ? `${posTag(pos(x.id))} ${esc(P(x.id).n)}` : `<span class="pos">PK</span> ${esc(x.label)}`;
  let h = `${tradeLocked() ? `<div class="banner">Trades are locked until the rookie draft. These are targets to line up for when the window reopens.</div>` : ''}
    <div class="row"><select id="finderTeam">${S.rosters.map(x => `<option value="${x.roster_id}" ${x.roster_id === rid ? 'selected' : ''}>${esc(teamName(x.roster_id))}</option>`).join('')}</select>
</div>
    <p class="note">Each deal upgrades your weakest starting spots, gives the other team help where they're thin (or picks if they're rebuilding), and is within about 5% on value (FAIR in the calculator). Taxi-steal rule enforced.</p>`;
  if (!list.length) return h + '<div class="banner">No clean deals found. Your lineup is already strong where other teams have surplus. Try the other mode.</div>';
  list.forEach((r, i) => {
    const w = r.why, other = teamName(r.partner);
    const theirNeed = w.theirNeeds.length ? `they're thin at ${w.theirNeeds.map(([g]) => g).join('/')}` : (r.rebuilding ? 'they\'re rebuilding and want picks/youth' : 'value-for-value consolidation');
    h += `<div class="panel"><div class="row"><span class="dim">#${i + 1}</span><b class="hi grow">${esc(other)}</b>${r.rebuilding ? '<span class="tag">REBUILDING</span>' : ''}${r.onTaxi ? '<span class="tag taxi">TAXI STEAL</span>' : ''}</div>
      <div class="cols" style="margin-top:6px"><div><div class="dim">YOU GET</div><div>${posTag(pos(r.get))} <b class="hi">${esc(P(r.get).n)}</b> <span class="dim">${P(r.get).team || ''} · ${age(r.get)}</span> · ${fmt(V(r.get))}</div></div>
      <div><div class="dim">YOU GIVE</div><div>${r.give.map(label).join(' + ')} · ${fmt(r.giveAdj)}</div></div></div>
      <div class="note">Why: you're short at ${r.getGroup} (need ${w.myNeed.toFixed(2)}), they're deep there · ${theirNeed}. Starter value: you <span class="up">+${fmt(r.myGain)}</span> · them <span class="${r.theirGain >= 0 ? 'up' : 'dn'}">${r.theirGain >= 0 ? '+' : ''}${fmt(r.theirGain)}</span></div>
      <button class="btn" data-loadtrade="${i}" style="margin-top:6px">Open in calculator →</button></div>`;
  });
  return h;
}

// ---- DRAFT ----
function renderDraft() {
  const d = S.draft, ds = d.draftSeason;
  const rounds = d.rounds;
  let h = `<h2>${ds} ROOKIE DRAFT <small>${d.official ? 'official order' : 'order projected from current standings (worst → 1.01)'} · ${rounds} rounds</small></h2>`;
  // ownership grid
  h += `<div class="tw"><table><thead><tr><th>TEAM</th>${Array.from({ length: rounds }, (_, i) => `<th>R${i + 1}</th>`).join('')}<th>${ds + 1}</th><th>${ds + 2}</th><th class="num">PICK $</th></tr></thead><tbody>`;
  const rows = S.rosters.map(r => r.roster_id).sort((a, b) => d.order[a] - d.order[b]);
  for (const rid of rows) {
    const mine = picksOf(rid);
    const cell = rd => mine.filter(p => p.season === ds && p.round === rd).map(p => `<span class="${p.orig !== rid ? 'amb' : ''}" title="${p.orig !== rid ? 'via ' + esc(teamName(p.orig)) : ''}">${p.label.split(' ')[1]}</span>`).join(' ') || '<span class="dim">—</span>';
    const fut = y => { const ps = mine.filter(p => p.season === y); const c = {}; ps.forEach(p => c[p.round] = (c[p.round] || 0) + 1); return Object.entries(c).map(([r, n]) => `${n > 1 ? n + '×' : ''}${r}`).join(' ') || '<span class="dim">—</span>'; };
    const tot = mine.reduce((a, p) => a + p.value, 0);
    h += `<tr class="${rid === S.myRid ? 'me' : ''}"><td class="hi">${esc(teamName(rid))}</td>${Array.from({ length: rounds }, (_, i) => `<td>${cell(i + 1)}</td>`).join('')}<td>${fut(ds + 1)}</td><td>${fut(ds + 2)}</td><td class="num">${fmt(tot)}</td></tr>`;
  }
  h += `</tbody></table></div><p class="note"><span class="amb">amber</span> = acquired via trade. Future years show rounds owned (2× = two picks that round).</p>`;
  // mock
  const rf = S.ui.mockRound || 1;
  h += `<h2>MOCK DRAFT <small>best available on the board × each team's positional need</small></h2><div class="chips">${['ALL', ...Array.from({ length: rounds }, (_, i) => i + 1)].map(r => `<button class="chip ${String(rf) === String(r) ? 'on' : ''}" data-mr="${r}">${r === 'ALL' ? 'ALL' : 'RD ' + r}</button>`).join('')}</div>`;
  h += '<div class="tw"><table><thead><tr><th>PICK</th><th>TEAM</th><th>PLAYER</th><th>POS</th><th>SCHOOL</th><th class="num">BOARD</th><th class="num">VALUE</th></tr></thead><tbody>';
  for (const m of S.mock.filter(m => rf === 'ALL' || m.round === Number(rf))) {
    const pl = m.player;
    h += `<tr class="${m.owner === S.myRid ? 'me' : ''}"><td>${m.label.split(' ')[1]}</td><td class="hi">${esc(teamName(m.owner))}${m.owner !== m.orig ? ' <span class="dim">(via ' + esc(teamName(m.orig)) + ')</span>' : ''}</td>
      <td class="hi">${pl ? esc(pl.name) : '<span class="dim">—</span>'}</td><td>${pl ? posTag(pl.group) + ' <span class="dim">' + esc(pl.pos) + '</span>' : ''}</td><td class="dim">${pl ? esc(pl.school || '') : ''}</td>
      <td class="num">${pl ? '#' + pl.boardRank + (m.reach > 6 ? ' <span class="amb">reach</span>' : m.reach < -6 ? ' <span class="up">value</span>' : '') : ''}</td><td class="num">${fmt(m.value)}</td></tr>`;
  }
  h += `</tbody></table></div><p class="note">Board source: ${esc(S.boardSource)}. IDP prospects are slotted for your scoring (tackle-heavy LB/S rise, sack-reliant edges fall since sacks = 1 pt).</p>`;
  // needs
  const me = S.needs[S.myRid];
  h += `<h2>YOUR POSITIONAL NEED <small>&gt;1.0 = below league median at that spot</small></h2><div class="kpi">${E.GROUPS.filter(g => g !== 'K').map(g => `<div><span>${g}</span><b class="${me[g] > 1.05 ? 'amb' : me[g] < 0.95 ? 'up' : ''}">${me[g].toFixed(2)}</b></div>`).join('')}</div>`;
  view.innerHTML = h;
}

// ---- LINEUP ----
function renderLineup() {
  if (!S.weeklyReady) { view.innerHTML = '<pre class="bootlog">> loading projections, Vegas lines, recent form…</pre>'; return; }
  if (!S.week) { view.innerHTML = '<div class="banner">Regular season is over — lineup tool returns in Week 1.</div>'; return; }
  const rid = S.ui.lineupRid ?? S.myRid;
  const r = S.teams[rid].roster, rp = S.league.roster_positions;
  const pids = (r.players || []).filter(pid => !(r.taxi || []).includes(pid) && !(r.reserve || []).includes(pid));
  const pc = {}; pids.forEach(pid => (pc[pid] = proj(pid)));
  const opt = E.optimalLineup(pids, rp, pid => E.eligibility(P(pid)), pid => pc[pid].pts);
  const cur = new Set((r.starters || []).filter(x => x && x !== '0'));
  const optSet = new Set(opt.lineup.map(x => x.pid).filter(Boolean));
  const curTotal = [...cur].reduce((a, pid) => a + (pc[pid]?.pts ?? proj(pid).pts), 0);
  // opponent
  let oppHtml = '';
  const mm = (S.matchups || []).find(m => m.roster_id === rid);
  if (mm) {
    const om = S.matchups.find(m => m.matchup_id === mm.matchup_id && m.roster_id !== rid);
    if (om) {
      const orr = S.teams[om.roster_id].roster;
      const op = (orr.players || []).filter(pid => !(orr.taxi || []).includes(pid) && !(orr.reserve || []).includes(pid));
      const ot = E.optimalLineup(op, rp, pid => E.eligibility(P(pid)), pid => proj(pid).pts).total;
      const wp = E.winProb(opt.total, ot);
      oppHtml = `<div class="kpi"><div><span>YOUR OPTIMAL</span><b>${f1(opt.total)}</b></div><div><span>CURRENT LINEUP</span><b class="${curTotal < opt.total - 0.5 ? 'amb' : ''}">${f1(curTotal)}</b></div><div><span>VS ${esc(teamName(om.roster_id))}</span><b>${f1(ot)}</b></div><div><span>WIN PROB</span><b class="${wp >= 0.5 ? 'up' : 'dn'}">${Math.round(wp * 100)}%</b></div></div>`;
    }
  }
  const swapsIn = [...optSet].filter(p => !cur.has(p)), swapsOut = [...cur].filter(p => !optSet.has(p));
  const row = (slot, pid, extra = '') => {
    if (!pid) return `<tr><td class="dim">${slot}</td><td class="dim" colspan="6">— empty —</td></tr>`;
    const p = P(pid), x = pc[pid] || proj(pid), g = x.game;
    const fl = (x.flags || []).map(f => `<span class="tag ${f === 'est' ? 'est' : f === 'BYE' ? 'bye' : 'q'}">${f}</span>`).join('');
    return `<tr><td class="dim">${slot.replace('SUPER_FLEX', 'SFLX')}</td><td>${posTag(pos(pid))}</td><td class="hi">${esc(p.n)}${fl}${extra}</td><td class="dim">${p.team || ''}${g ? (g.home ? ' v ' : ' @ ') + g.opp : ''}</td>
      <td class="num dim">${g ? f1(g.implied) : ''}</td><td class="num">${f1(S.recent[pid])}</td><td class="num hi">${f1(x.pts)}</td></tr>`;
  };
  let h = `<div class="row"><select id="lineupTeam">${S.rosters.map(x => `<option value="${x.roster_id}" ${x.roster_id === rid ? 'selected' : ''}>${esc(teamName(x.roster_id))}</option>`).join('')}</select><span class="dim">Week ${S.week}</span></div><br>${oppHtml}`;
  if (swapsIn.length) h += `<div class="banner g">MOVES: ${swapsIn.map(p => `<span class="swap-in">▲ start ${esc(P(p).n)}</span>`).join(' · ')}${swapsOut.length ? ' · ' + swapsOut.map(p => `<span class="swap-out">▼ bench ${esc(P(p).n)}</span>`).join(' · ') : ''}</div>`;
  else h += '<div class="banner g">Your Sleeper lineup already matches the optimal lineup. ✔</div>';
  h += '<h2>OPTIMAL LINEUP</h2><div class="tw"><table><thead><tr><th>SLOT</th><th></th><th>PLAYER</th><th>GAME</th><th class="num">TEAM IMP</th><th class="num">L3 AVG</th><th class="num">PROJ</th></tr></thead><tbody>';
  for (const s of opt.lineup) h += row(s.slot, s.pid, s.pid && !cur.has(s.pid) ? ' <span class="swap-in">▲</span>' : '');
  h += '</tbody></table></div><h2>BENCH</h2><div class="tw"><table><tbody>';
  for (const pid of pids.filter(p => !optSet.has(p)).sort((a, b) => pc[b].pts - pc[a].pts)) h += row('BN', pid, cur.has(pid) ? ' <span class="swap-out">▼</span>' : '');
  h += `</tbody></table></div><p class="note">PROJ = 70% Sleeper projection + 30% last-3-week form, scored with your league settings, then adjusted for Vegas implied team total (offense) or game total (IDP) and injury status. "est" = no Sleeper projection, built from form + season PPG. Taxi & IR excluded.</p>`;
  view.innerHTML = h;
}

// ---- WAIVERS ----
function renderWaivers() {
  const W = (S.ui.w ||= { pos: 'ALL', sort: 'value' });
  const fa = Object.keys(S.players).filter(pid => !S.rostered.has(pid) && S.players[pid].team && S.values[pid]);
  const ready = S.weeklyReady && S.ctx;
  const rows = fa.filter(pid => W.pos === 'ALL' || pos(pid) === W.pos).map(pid => ({
    pid, value: V(pid), ppg: S.values[pid].ppg, l3: S.recent?.[pid], wk: ready ? proj(pid).pts : null, tr: S.trending[pid] || 0,
  }));
  const key = { value: 'value', week: 'wk', trend: 'tr', l3: 'l3' }[W.sort];
  rows.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
  let h = `<h2>WAIVER WIRE <small>${fa.length} unrostered players</small></h2>
    <div class="chips">${['ALL', ...E.GROUPS].map(p => `<button class="chip ${W.pos === p ? 'on' : ''}" data-wp="${p}">${p}</button>`).join('')}</div>
    <div class="chips">${[['value', 'DYNASTY VALUE'], ['week', 'THIS WEEK'], ['l3', 'HOT (L3)'], ['trend', 'TRENDING ADDS']].map(([k, l]) => `<button class="chip ${W.sort === k ? 'on' : ''}" data-ws="${k}">${l}</button>`).join('')}</div>
    <div class="tw"><table><thead><tr><th></th><th>PLAYER</th><th>NFL</th><th class="num">AGE</th><th class="num">VALUE</th><th class="num">PPG</th><th class="num">L3</th><th class="num">WK PROJ</th><th class="num">ADDS 48H</th></tr></thead><tbody>`;
  for (const x of rows.slice(0, 75)) {
    const p = P(x.pid);
    h += `<tr><td>${posTag(pos(x.pid))}</td><td class="hi">${esc(p.n)}${p.inj ? `<span class="tag q">${esc(p.inj)}</span>` : ''}</td><td class="dim">${p.team}</td><td class="num">${age(x.pid)}</td><td class="num hi">${fmt(x.value)}</td><td class="num">${f1(x.ppg)}</td><td class="num">${f1(x.l3)}</td><td class="num">${x.wk == null ? '…' : f1(x.wk)}</td><td class="num ${x.tr > 1000 ? 'up' : ''}">${x.tr ? fmt(x.tr) : ''}</td></tr>`;
  }
  h += '</tbody></table></div><p class="note">ADDS 48H = Sleeper-wide add count (all leagues) — early signal before your league reacts.</p>';
  view.innerHTML = h;
}

// ---------------- events ----------------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-tsub],[data-loadtrade],[data-tab],[data-team],[data-ts],[data-mr],[data-wp],[data-ws],[data-rm],#refresh');
  if (!t) return;
  if (t.dataset.tsub) { S.ui.tradeSub = t.dataset.tsub; render(); }
  else if (t.dataset.loadtrade) {
    const r = S.finderCache.list[+t.dataset.loadtrade], me = S.ui.finderRid ?? S.myRid;
    S.ui.trade = { a: me, b: r.partner, sa: r.give.map(x => x.id), sb: [r.get], qa: '', qb: '' }; S.ui.tradeSub = 'calc'; render(); window.scrollTo(0, 0);
  }
  else if (t.dataset.tab) { S.tab = t.dataset.tab; localStorage.setItem('dhq-tab', S.tab); render(); window.scrollTo(0, 0); }
  else if (t.dataset.team) { const r = +t.dataset.team; S.ui.openTeam = S.ui.openTeam === r ? null : r; render(); }
  else if (t.dataset.ts) { S.ui.teamSort = t.dataset.ts; render(); }
  else if (t.dataset.mr) { S.ui.mockRound = t.dataset.mr === 'ALL' ? 'ALL' : +t.dataset.mr; render(); }
  else if (t.dataset.wp) { S.ui.w.pos = t.dataset.wp; render(); }
  else if (t.dataset.ws) { S.ui.w.sort = t.dataset.ws; render(); }
  else if (t.dataset.rm) { const [k, id] = t.dataset.rm.split(':'); const T = S.ui.trade; T['s' + k] = T['s' + k].filter(x => x !== id); render(); }
  else if (t.id === 'refresh') { D.clearCache(); location.reload(); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.side) { const T = S.ui.trade; T[t.dataset.side] = +t.value; T['s' + t.dataset.side] = []; render(); }
  else if (t.dataset.pick) { const T = S.ui.trade, k = 's' + t.dataset.pick; T[k] = t.checked ? [...T[k], t.value] : T[k].filter(x => x !== t.value); const y = window.scrollY; render(); window.scrollTo(0, y); }
  else if (t.id === 'finderTeam') { S.ui.finderRid = +t.value; render(); }
  else if (t.id === 'lineupTeam') { S.ui.lineupRid = +t.value; render(); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.q) { S.ui.trade['q' + t.dataset.q] = t.value; const pos0 = t.selectionStart; render(); const n = document.querySelector(`[data-q="${t.dataset.q}"]`); n.focus(); n.setSelectionRange(pos0, pos0); }
});

render();
boot();
