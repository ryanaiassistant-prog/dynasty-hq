// Dynasty HQ — pure calculation engine (no DOM). Runs in the browser and in Node tests.

export const OFF = ['QB', 'RB', 'WR', 'TE', 'K'];
export const IDP = ['DL', 'LB', 'DB'];
export const GROUPS = ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB', 'K'];
const IDP_MAP = { DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', EDGE: 'DL', ED: 'DL', DI: 'DL', LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB', CB: 'DB', S: 'DB', SS: 'DB', FS: 'DB', DB: 'DB' };
export const SLOT_ELIG = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DL: ['DL'], LB: ['LB'], DB: ['DB'], DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], IDP_FLEX: ['DL', 'LB', 'DB'],
};
const NON_STARTING = new Set(['BN', 'TAXI', 'IR']);

export function groupOf(pos) { return OFF.includes(pos) ? pos : (IDP_MAP[pos] || pos); }
export function primaryPos(p) {
  const g = groupOf(p.pos);
  if (GROUPS.includes(g)) return g;
  return (p.fp || []).map(groupOf).find(x => GROUPS.includes(x)) || g;
}
export function eligibility(p) {
  const s = new Set([primaryPos(p)]);
  for (const f of p.fp || []) { const g = groupOf(f); if (GROUPS.includes(g)) s.add(g); }
  return [...s];
}

// ---------- scoring ----------
export function scoreStats(stats, scoring) {
  if (!stats) return 0;
  let t = 0;
  for (const k in scoring) { const v = stats[k]; if (v) t += v * scoring[k]; }
  return Math.round(t * 100) / 100;
}

/** Season scoring with touchdowns regressed halfway toward what the yardage supports (TDs are the noisiest stat). */
const YDS_PER_TD = { rush: 130, rec: 155, pass: 155 };
export function scoreStatsRegressed(stats, scoring) {
  if (!stats) return 0;
  const s = { ...stats };
  if (s.rush_td || s.rush_yd) s.rush_td = 0.5 * (s.rush_td || 0) + 0.5 * Math.max(0, s.rush_yd || 0) / YDS_PER_TD.rush;
  if (s.rec_td || s.rec_yd) s.rec_td = 0.5 * (s.rec_td || 0) + 0.5 * Math.max(0, s.rec_yd || 0) / YDS_PER_TD.rec;
  if (s.pass_td || s.pass_yd) s.pass_td = 0.5 * (s.pass_td || 0) + 0.5 * Math.max(0, s.pass_yd || 0) / YDS_PER_TD.pass;
  return scoreStats(s, scoring);
}

// season production: {pid: {gp, pts}} for current and previous season → ppg blend
export function blendPPG(cur, prev) {
  const c = cur && cur.gp > 0 ? cur : null, p = prev && prev.gp > 0 ? prev : null;
  // last season's weight shrinks as this season builds: 0.6 at week 0 → ~0.3 by game 9 → 0.15 floor
  if (c && p) { const wp = Math.max(0.15, 0.6 * (1 - c.gp / 17)); return (c.pts + p.pts * wp) / (c.gp + p.gp * wp); }
  if (c) return c.pts / c.gp;
  if (p) return (p.pts / p.gp) * 0.9;
  return 0;
}

// ---------- replacement level ----------
export function starterSlots(rosterPositions) { return rosterPositions.filter(s => !NON_STARTING.has(s)); }

export function replacementLevels(pool, rosterPositions, teams) {
  // pool: [{pos, ppg}] using primary group. Greedy-fill league-wide starters, replacement = next 3 avg.
  const byPos = {};
  for (const p of pool) (byPos[p.pos] ||= []).push(p.ppg);
  for (const k in byPos) byPos[k].sort((a, b) => b - a);
  const used = {};
  const flex = [];
  for (const s of starterSlots(rosterPositions)) {
    const el = SLOT_ELIG[s] || [s];
    if (el.length === 1) used[el[0]] = (used[el[0]] || 0) + teams;
    else for (let i = 0; i < teams; i++) flex.push(el);
  }
  flex.sort((a, b) => a.length - b.length);
  for (const el of flex) {
    let best = null, bv = -1;
    for (const pos of el) { const v = (byPos[pos] || [])[used[pos] || 0] ?? -1; if (v > bv) { bv = v; best = pos; } }
    if (best) used[best] = (used[best] || 0) + 1;
  }
  const repl = {};
  for (const pos of GROUPS) {
    const arr = byPos[pos] || [], i = used[pos] || 0;
    const nxt = arr.slice(i, i + 3);
    repl[pos] = nxt.length ? nxt.reduce((a, b) => a + b, 0) / nxt.length : 0;
  }
  return { repl, starters: used };
}

// ---------- age curves ----------
const CURVE = {
  QB: { peak: [24, 33], dec: 0.12 }, RB: { peak: [22, 27], dec: 0.17 }, WR: { peak: [23, 29], dec: 0.14 },
  TE: { peak: [24, 30], dec: 0.14 }, K: { peak: [23, 38], dec: 0.06 },
  DL: { peak: [24, 30], dec: 0.13 }, LB: { peak: [23, 29], dec: 0.15 }, DB: { peak: [23, 29], dec: 0.15 },
};
function ageMult(pos, age) {
  const c = CURVE[pos]; if (!c || !age) return 1;
  if (age > c.peak[1]) return Math.max(0, 1 - c.dec * (age - c.peak[1]));
  return 1;
}
export function dynastyMult(pos, age) {
  let m = 0; for (let t = 0; t < 5; t++) m += ageMult(pos, (age || 26) + t) * Math.pow(0.8, t);
  return m;
}

// ---------- fit model → market scale ----------
function fitLogLog(pairs) {
  const xs = [], ys = [];
  for (const [r, m] of pairs) if (r > 0 && m > 0) { xs.push(Math.log(r)); ys.push(Math.log(m)); }
  if (xs.length < 30) return null;
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  return r => Math.min(10500, Math.exp(a + b * Math.log(r)));
}

// DynastyProcess ECR → value curve (fit to their own value_2qb column)
export const ecrToValue = ecr => Math.round(10116 * Math.exp(-0.02328 * ecr));

// ---------- player values ----------
/**
 * players: {pid: {n,pos,fp,team,age,exp,inj}}
 * prod: {pid: {cur:{gp,pts}, prev:{gp,pts}}}
 * market: {pid: value}  (superflex market, offense only)
 * capital: {pid: {dr, do}} draft round / overall
 */
// Final display scale: overall rank in the relevant universe (offense + IDP) → value. #1 ≈ 10,000 · #100 ≈ 4,900 · #300 ≈ 1,800 · #500 ≈ 900
export const rankCurve = r => 10000 / Math.pow(1 + (r - 1) / 300, 2.48);

/** Build a monotone map from the raw (steep) scale onto the flat display scale, using the ranking of `olds`. */
export function buildScaleMap(olds) {
  const xs = olds.filter(v => v > 0).sort((a, b) => b - a);
  const ys = xs.map((_, i) => rankCurve(i + 1));
  const g = x => {
    if (!(x > 0) || !xs.length) return 0;
    if (x >= xs[0]) return ys[0] * Math.min(1.05, x / xs[0]);
    const last = xs.length - 1;
    if (x <= xs[last]) return ys[last] * (x / xs[last]);
    let lo = 0, hi = last; // xs descending
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] >= x) lo = mid; else hi = mid; }
    const t = (xs[lo] - x) / Math.max(1e-9, xs[lo] - xs[hi]);
    return ys[lo] + t * (ys[hi] - ys[lo]);
  };
  return g;
}

/**
 * players: {pid: {n,pos,fp,team,age,exp,inj}}
 * prod: {pid: {cur:{gp,pts}, prev:{gp,pts}}}
 * market: {pid: value}  (superflex market, offense only, DynastyProcess scale)
 * capital: {pid: {dr, do}} NFL draft round / overall
 * Returns values on the flat display scale plus `scale` (raw → display map) for picks/rookies.
 */
export function computeValues({ players, prod, market, capital, league, teams, marketWeight = 0.65, idpWeight = 0.8, rostered = null }) {
  const rp = league.roster_positions;
  const pool = [];
  for (const pid in players) {
    const p = players[pid]; const pos = primaryPos(p);
    if (!GROUPS.includes(pos)) continue;
    const ppg = blendPPG(prod[pid]?.cur, prod[pid]?.prev);
    pool.push({ pid, pos, ppg, age: p.age });
  }
  const { repl, starters } = replacementLevels(pool, rp, teams);
  // Points over replacement with a soft taper below the line (no hard zero for depth players)
  const soft = (ppg, r) => ppg >= r ? ppg - r + 1 : Math.exp((ppg - r) / Math.max(1, 0.2 * r));
  const raw = {};
  for (const x of pool) raw[x.pid] = soft(x.ppg, repl[x.pos]) * 17 * dynastyMult(x.pos, x.age);
  // Prospect floor from NFL draft capital for young players (all positions)
  const p90 = {};
  for (const g of GROUPS) { const a = pool.filter(x => x.pos === g).map(x => raw[x.pid]).sort((a, b) => b - a); p90[g] = a[Math.floor(a.length * 0.1)] || 0; }
  for (const x of pool) {
    const p = players[x.pid], c = capital?.[x.pid];
    if (!c || !c.dr || (p.exp ?? 9) > 2 || x.pos === 'K') continue;
    const f = c.do && c.do <= 12 ? 0.6 : c.dr === 1 ? 0.45 : c.dr === 2 ? 0.3 : c.dr === 3 ? 0.18 : c.dr <= 5 ? 0.1 : 0.06;
    raw[x.pid] = Math.max(raw[x.pid], f * p90[x.pos] * (1 - 0.25 * (p.exp || 0) / 2));
  }
  const fit = fitLogLog(pool.filter(x => OFF.includes(x.pos) && market[x.pid] > 300).map(x => [raw[x.pid], market[x.pid]]));
  const maxRaw = Math.max(1, ...Object.values(raw));
  const toScale = fit || (r => (r / maxRaw) * 9500);
  // 1) combine on the raw (DynastyProcess) scale
  const rawVals = {};
  for (const x of pool) {
    const modelV = raw[x.pid] > 0 ? toScale(raw[x.pid]) : 0;
    const m = market[x.pid];
    let v = m ? marketWeight * m + (1 - marketWeight) * modelV : modelV;
    let mod = modelV;
    if (x.pos === 'K') { v = Math.min(v, 400); mod = Math.min(mod, 400); }
    if (IDP.includes(x.pos)) { v *= idpWeight; mod *= idpWeight; }
    rawVals[x.pid] = { v, mod, m: m || null };
  }
  // 2) remap onto the flat display scale by overall rank within the relevant universe:
  //    rostered in this league + anyone with a market price + top IDP by model (keeps deep filler from diluting ranks)
  const uni = new Set();
  for (const x of pool) if ((rostered && rostered.has(x.pid)) || market[x.pid]) uni.add(x.pid);
  for (const g0 of IDP) pool.filter(x => x.pos === g0).sort((a, b) => rawVals[b.pid].v - rawVals[a.pid].v).slice(0, 120).forEach(x => uni.add(x.pid));
  const g = buildScaleMap([...uni].map(pid => rawVals[pid].v));
  const values = {};
  for (const x of pool) {
    const r = rawVals[x.pid], v = Math.round(g(r.v));
    values[x.pid] = {
      value: v, dyn: v, now: v, ppg: Math.round(x.ppg * 10) / 10,
      model: Math.round(g(r.mod)), market: r.m ? Math.round(g(r.m)) : null, pos: x.pos,
      games: (prod[x.pid]?.cur?.gp || 0) + (prod[x.pid]?.prev?.gp || 0),
    };
  }
  return { values, repl, starters, scale: g };
}

// ---------- picks ----------
/** dpPicks: rows from values-picks.csv. Returns helpers for slot and generic pick values. */
export function pickValueModel(dpPicks, teams = 12) {
  const slot = {}; let slotYear = 0;
  const generic = {};
  for (const r of dpPicks) {
    const m = /^(\d{4}) Pick (\d+)\.(\d+)$/.exec(r.player);
    const ecr = parseFloat(r.ecr_2qb);
    if (m) { const y = +m[1]; if (y >= slotYear) { if (y > slotYear) { slotYear = y; for (const k in slot) delete slot[k]; } slot[(+m[2] - 1) * teams + +m[3]] = ecr; } continue; }
    const g = /^(\d{4}) (\d)(?:st|nd|rd|th)$/.exec(r.player);
    if (g) (generic[+g[1]] ||= {})[+g[2]] = ecr;
  }
  const maxSlot = Math.max(0, ...Object.keys(slot).map(Number));
  const slotEcr = n => slot[n] ?? (slot[maxSlot] ?? 330) + 3 * (n - maxSlot);
  const years = Object.keys(generic).map(Number).sort();
  const genericVal = (season, round) => {
    let y = years.includes(season) ? season : years[years.length - 1];
    if (!y) return slotValue((round - 1) * teams + Math.ceil(teams / 2));
    const row = generic[y];
    const maxR = Math.max(...Object.keys(row).map(Number));
    let v = ecrToValue(row[Math.min(round, maxR)]);
    if (round > maxR) v *= Math.pow(0.55, round - maxR);
    if (season > y) v *= Math.pow(0.95, season - y);
    return Math.round(v);
  };
  const slotValue = overall => ecrToValue(slotEcr(overall));
  return { slotValue, genericVal };
}

export function standings(rosters) {
  return [...rosters].map(r => ({
    rid: r.roster_id, w: r.settings?.wins || 0, l: r.settings?.losses || 0, t: r.settings?.ties || 0,
    pf: (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100,
  })).sort((a, b) => b.w - a.w || b.pf - a.pf);
}

/** Pick ownership for seasons × rounds, with traded picks applied. */
export function pickOwnership(rosters, traded, seasons, rounds) {
  const own = [];
  for (const season of seasons) for (let round = 1; round <= rounds; round++) for (const r of rosters) {
    own.push({ season, round, orig: r.roster_id, owner: r.roster_id });
  }
  const idx = new Map(own.map(p => [`${p.season}-${p.round}-${p.orig}`, p]));
  for (const t of traded || []) {
    const p = idx.get(`${t.season}-${t.round}-${t.roster_id}`);
    if (p) p.owner = t.owner_id;
  }
  return own;
}

/**
 * Projected draft order for the upcoming rookie draft.
 * slotToRid: actual Sleeper order if set; otherwise reverse standings.
 */
export function projectedOrder(rosters, slotToRid) {
  if (slotToRid && Object.keys(slotToRid).length === rosters.length) {
    const out = {}; for (const s in slotToRid) out[slotToRid[s]] = +s; return out;
  }
  const st = standings(rosters).reverse();
  const out = {}; st.forEach((s, i) => (out[s.rid] = i + 1)); return out;
}

export function valuePicks(own, { draftSeason, order, teams, certainty, pm }) {
  return own.map(p => {
    let value, label, overall = null;
    if (p.season === draftSeason) {
      const slot = order[p.orig]; overall = (p.round - 1) * teams + slot;
      const sv = pm.slotValue(overall), gv = pm.genericVal(p.season, p.round);
      value = Math.round(certainty * sv + (1 - certainty) * gv);
      label = `${p.season} ${p.round}.${String(slot).padStart(2, '0')}`;
    } else {
      value = pm.genericVal(p.season, p.round);
      label = `${p.season} R${p.round}`;
    }
    return { ...p, value, label, overall, id: `pick:${p.season}-${p.round}-${p.orig}` };
  });
}

// ---------- rookie board ----------
const IDP_RANK_FACTOR = { LB: 2.0, S: 2.2, CB: 3.0, ED: 3.5, EDGE: 3.5, DE: 3.5, DI: 4.0, DT: 4.0 };
/** Merge offensive dynasty rookie ranks with IDP NFL-board ranks into one league board. */
export function buildRookieBoard({ offense, idp, pm }) {
  const rows = [];
  for (const o of offense) rows.push({ ...o, eff: o.rank, group: groupOf(o.pos) });
  for (const d of idp) rows.push({ ...d, eff: d.rank * (IDP_RANK_FACTOR[d.pos] || 3), group: groupOf(d.pos) });
  rows.sort((a, b) => a.eff - b.eff);
  return rows.map((r, i) => ({ ...r, boardRank: i + 1, value: r.value ?? pm.slotValue(i + 1) }));
}

// ---------- team strength & needs ----------
const NEED_K = { QB: 2, RB: 3, WR: 4, TE: 1, DL: 3, LB: 3, DB: 3, K: 1 };
export function teamGroupStrength(pids, players, values) {
  const by = {};
  for (const pid of pids) { const p = players[pid]; if (!p) continue; const g = primaryPos(p); (by[g] ||= []).push(values[pid]?.value || 0); }
  const out = {};
  for (const g of GROUPS) { const arr = (by[g] || []).sort((a, b) => b - a).slice(0, NEED_K[g]); out[g] = arr.reduce((a, b) => a + b, 0); }
  return out;
}
export function teamNeeds(rosters, players, values) {
  const str = {}; for (const r of rosters) str[r.roster_id] = teamGroupStrength(r.players || [], players, values);
  const med = {};
  for (const g of GROUPS) { const a = Object.values(str).map(s => s[g]).sort((x, y) => x - y); med[g] = a[Math.floor(a.length / 2)] || 1; }
  const needs = {};
  for (const rid in str) { needs[rid] = {}; for (const g of GROUPS) needs[rid][g] = Math.min(1.3, Math.max(0.85, 1 + 0.3 * (med[g] - str[rid][g]) / Math.max(med[g], 1))); }
  return { needs, strength: str, median: med };
}

export function mockDraft(picksInOrder, board, needs) {
  const avail = board.slice();
  const need = JSON.parse(JSON.stringify(needs));
  const out = [];
  for (const p of picksInOrder) {
    if (!avail.length) { out.push({ ...p, player: null }); continue; }
    const n = need[p.owner] || {};
    let bi = 0, bs = -1;
    for (let i = 0; i < Math.min(avail.length, 25); i++) { const r = avail[i]; const s = r.value * (n[r.group] ?? 1); if (s > bs) { bs = s; bi = i; } }
    const pick = avail.splice(bi, 1)[0];
    if (n[pick.group]) n[pick.group] = Math.max(0.85, n[pick.group] - 0.15);
    out.push({ ...p, player: pick, reach: pick.boardRank - p.overall });
  }
  return out;
}

// ---------- trade ----------
export function tradeSide(values) {
  const raw = values.reduce((a, b) => a + b, 0);
  const adj = Math.pow(values.reduce((a, v) => a + Math.pow(Math.max(v, 0), 1.5), 0), 1 / 1.5);
  return { raw: Math.round(raw), adj: Math.round(adj) };
}
export function tradeVerdict(a, b) {
  const diff = a.adj - b.adj, base = Math.max(a.adj, b.adj, 1), pct = diff / base;
  if (Math.abs(pct) < 0.05) return { text: 'FAIR', pct, diff };
  return { text: pct > 0 ? 'SIDE A WINS' : 'SIDE B WINS', pct, diff };
}

// ---------- weekly projections ----------
const OUT_STATUS = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR', 'COV']);
export function injuryFactor(inj) {
  if (!inj) return 1;
  if (OUT_STATUS.has(inj)) return 0;
  if (inj === 'Doubtful') return 0.25;
  if (inj === 'Questionable') return 0.85;
  return 1;
}
/** games: [{w, away, home, spread, total, kickoff}] for the week. Returns team → game context. */
export function gameContext(games) {
  const ctx = {};
  for (const g of games) {
    const total = g.total || 44, sp = g.spread || 0;
    const homeImp = (total + sp) / 2, awayImp = (total - sp) / 2;
    ctx[g.home] = { opp: g.away, home: true, implied: homeImp, oppImplied: awayImp, total, kickoff: g.kickoff, spread: -sp };
    ctx[g.away] = { opp: g.home, home: false, implied: awayImp, oppImplied: homeImp, total, kickoff: g.kickoff, spread: sp };
  }
  return ctx;
}
export function projectPlayer({ p, pos, projPts, recent, ppg, ctx }) {
  const flags = [];
  if (!p.team || !ctx[p.team]) return { pts: 0, flags: [p.team ? 'BYE' : 'FA'] };
  let base;
  if (projPts != null && projPts > 0) base = 0.7 * projPts + 0.3 * (recent ?? ppg);
  else { base = recent != null ? 0.6 * recent + 0.4 * ppg : ppg; flags.push('est'); }
  const g = ctx[p.team];
  let mf = 1;
  if (OFF.includes(pos) && pos !== 'K') mf = Math.pow(Math.min(1.2, Math.max(0.8, g.implied / 22.5)), 0.6);
  else if (pos === 'K') mf = Math.pow(Math.min(1.2, Math.max(0.8, g.implied / 22.5)), 0.4);
  else mf = Math.pow(g.total / 45, 0.3);
  const inj = injuryFactor(p.inj); if (p.inj) flags.push(p.inj);
  return { pts: Math.round(base * mf * inj * 10) / 10, flags, mf: Math.round(mf * 100) / 100, game: g };
}

/** Greedy optimal lineup: most-restrictive slots first. */
export function optimalLineup(pids, rosterPositions, elig, proj) {
  const slots = starterSlots(rosterPositions).map((s, i) => ({ s, i, el: SLOT_ELIG[s] || [s] }));
  const order = [...slots].sort((a, b) => a.el.length - b.el.length || a.i - b.i);
  const used = new Set(); const lineup = new Array(slots.length).fill(null);
  for (const sl of order) {
    let best = null, bv = -Infinity;
    for (const pid of pids) {
      if (used.has(pid)) continue;
      if (!elig(pid).some(e => sl.el.includes(e))) continue;
      const v = proj(pid); if (v > bv) { bv = v; best = pid; }
    }
    if (best) { used.add(best); lineup[sl.i] = { slot: sl.s, pid: best, pts: bv }; }
    else lineup[sl.i] = { slot: sl.s, pid: null, pts: 0 };
  }
  const total = lineup.reduce((a, x) => a + (x.pts || 0), 0);
  return { lineup, total: Math.round(total * 10) / 10 };
}

/** Win probability from projected totals (normal approx, sd ~ 12% of combined). */
export function winProb(a, b) {
  const sd = Math.max(15, 0.12 * (a + b));
  const z = (a - b) / (sd * Math.SQRT2);
  // erf approximation
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + (z >= 0 ? y : -y));
}

// ---------- trade finder ----------
/**
 * Finds mutually beneficial trades for team `me`.
 * val: {pid: number} in the active mode. picks: valued pick objects. standingsRank: rid → 1..n (1 = best).
 */
export function findTrades({ me, rosters, players, val, picks, standingsRank, taxiMinRound = 2, limit = 12 }) {
  const vo = {}; for (const k in val) vo[k] = { value: val[k] };
  const V = pid => val[pid] || 0;
  const tot = s => Object.values(s).reduce((a, b) => a + b, 0);
  const str = pids => teamGroupStrength(pids, players, vo);
  const { needs } = teamNeeds(rosters, players, vo);
  const R = Object.fromEntries(rosters.map(r => [r.roster_id, r]));
  const base = {}; for (const r of rosters) base[r.roster_id] = str(r.players || []);
  const n = rosters.length;
  const myR = R[me], mine = myR.players || [];
  const myPlayers = mine.filter(p => V(p) >= 150).sort((a, b) => V(b) - V(a)).slice(0, 20).map(pid => ({ kind: 'p', id: pid, v: V(pid) }));
  const myPicks = picks.filter(p => p.owner === me && p.value >= 80).sort((a, b) => b.value - a.value).slice(0, 8).map(p => ({ kind: 'k', id: p.id, v: p.value, round: p.round, label: p.label }));
  const pieces = [...myPlayers, ...myPicks];
  const pkgs = [];
  for (let i = 0; i < pieces.length; i++) {
    pkgs.push([pieces[i]]);
    for (let j = i + 1; j < pieces.length; j++) pkgs.push([pieces[i], pieces[j]]);
  }
  const results = [];
  for (const T of rosters) {
    const t = T.roster_id; if (t === me) continue;
    const rebuilding = standingsRank[t] > n * 0.66;
    const targets = (T.players || []).filter(pid => {
      const pl = players[pid]; if (!pl || !pl.team || pl.inj === 'IR') return false;
      const g = primaryPos(pl); if (!GROUPS.includes(g) || g === 'K') return false;
      return V(pid) >= 400 && needs[me][g] >= 1.0 && needs[t][g] <= 1.1;
    }).sort((a, b) => V(b) - V(a)).slice(0, 6);
    for (const tgt of targets) {
      const tv = tradeSide([V(tgt)]).adj;
      const onTaxi = (T.taxi || []).includes(tgt);
      let best = null;
      for (const pk of pkgs) {
        const side = tradeSide(pk.map(x => x.v));
        if (side.adj < tv * 0.96 || side.adj > tv * 1.06) continue;
        if (onTaxi && !pk.some(x => x.kind === 'k' && x.round <= taxiMinRound)) continue;
        const outP = new Set(pk.filter(x => x.kind === 'p').map(x => x.id));
        const myAfter = str([...mine.filter(p => !outP.has(p)), tgt]);
        const gainMe = tot(myAfter) - tot(base[me]);
        if (gainMe <= 0) continue;
        const theirAfter = str([...(T.players || []).filter(p => p !== tgt), ...outP]);
        let gainT = tot(theirAfter) - tot(base[t]);
        const pickV = pk.filter(x => x.kind === 'k').reduce((a, x) => a + x.v, 0);
        if (rebuilding) gainT += pickV * 0.6; else gainT += pickV * 0.2;
        if (gainT < -0.15 * tv) continue; // they'd balk
        const overpay = side.adj - tv;
        const score = gainMe + 0.4 * Math.min(Math.max(gainT, 0), gainMe) - 0.3 * Math.max(0, overpay);
        if (!best || score > best.score) best = { score, pk, gainMe, gainT, side, tv };
      }
      if (best) {
        const g = primaryPos(players[tgt]);
        const giveGroups = [...new Set(best.pk.filter(x => x.kind === 'p').map(x => primaryPos(players[x.id])))];
        results.push({
          partner: t, get: tgt, getGroup: g, give: best.pk, myGain: Math.round(best.gainMe), theirGain: Math.round(best.gainT),
          giveAdj: best.side.adj, getAdj: Math.round(best.tv), score: best.score, rebuilding, onTaxi,
          why: { myNeed: needs[me][g], theirDepth: needs[t][g], theirNeeds: giveGroups.filter(x => needs[t][x] > 1.02).map(x => [x, needs[t][x]]) },
        });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  const seen = new Set(), out = [], perTeam = {};
  for (const r of results) {
    if (seen.has(r.get)) continue;
    if ((perTeam[r.partner] || 0) >= 2) continue;
    seen.add(r.get); perTeam[r.partner] = (perTeam[r.partner] || 0) + 1; out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- targeted acquisition ----------
/**
 * Build fair offers from `me` for each target asset.
 * targets: [{kind:'p'|'k', id, owner, v, round?, label?}]  (v on the display scale)
 */
export function offersFor({ me, rosters, players, val, picks, standingsRank, targets, taxiMinRound = 2, limit = 15 }) {
  const vo = {}; for (const k in val) vo[k] = { value: val[k] };
  const V = pid => val[pid] || 0;
  const tot = s => Object.values(s).reduce((a, b) => a + b, 0);
  const str = pids => teamGroupStrength(pids, players, vo);
  const R = Object.fromEntries(rosters.map(r => [r.roster_id, r]));
  const n = rosters.length;
  const mine = R[me].players || [];
  const myBase = tot(str(mine));
  const myPlayers = mine.filter(p => V(p) >= 100).sort((a, b) => V(b) - V(a)).slice(0, 22).map(pid => ({ kind: 'p', id: pid, v: V(pid) }));
  const myPicks = picks.filter(p => p.owner === me && p.value >= 80).sort((a, b) => b.value - a.value).slice(0, 10).map(p => ({ kind: 'k', id: p.id, v: p.value, round: p.round, label: p.label }));
  const pieces = [...myPlayers, ...myPicks];
  const pkgs = [];
  for (let i = 0; i < pieces.length; i++) {
    pkgs.push([pieces[i]]);
    for (let j = i + 1; j < pieces.length; j++) {
      pkgs.push([pieces[i], pieces[j]]);
      if (i < 14 && j < 14) for (let k = j + 1; k < 14; k++) pkgs.push([pieces[i], pieces[j], pieces[k]]);
    }
  }
  const pkgSide = pkgs.map(pk => tradeSide(pk.map(x => x.v)).adj);
  const out = [];
  for (const t of targets) {
    if (t.owner === me) continue;
    const T = R[t.owner]; if (!T) continue;
    const tv = tradeSide([t.v]).adj;
    const theirBase = tot(str(T.players || []));
    const rebuilding = standingsRank[t.owner] > n * 0.66;
    const onTaxi = t.kind === 'p' && (T.taxi || []).includes(t.id);
    let best = null;
    for (let i = 0; i < pkgs.length; i++) {
      const side = pkgSide[i];
      if (side < tv * 0.97 || side > tv * 1.08) continue;
      const pk = pkgs[i];
      if (pk.some(x => x.kind === t.kind && x.id === t.id)) continue;
      if (onTaxi && !pk.some(x => x.kind === 'k' && x.round <= taxiMinRound)) continue;
      const outP = new Set(pk.filter(x => x.kind === 'p').map(x => x.id));
      const myAfter = tot(str([...mine.filter(p => !outP.has(p)), ...(t.kind === 'p' ? [t.id] : [])]));
      const myDelta = myAfter - myBase;
      const theirAfter = tot(str([...(T.players || []).filter(p => p !== t.id), ...outP]));
      let gainT = theirAfter - theirBase;
      const pickV = pk.filter(x => x.kind === 'k').reduce((a, x) => a + x.v, 0);
      gainT += pickV * (rebuilding ? 0.6 : 0.2);
      if (gainT < -0.2 * tv) continue;
      const score = myDelta + 0.4 * Math.min(Math.max(gainT, 0), tv) - 0.5 * (side - tv);
      if (!best || score > best.score) best = { score, pk, side, myDelta, gainT };
    }
    if (best) out.push({ target: t, give: best.pk, giveAdj: Math.round(best.side), getAdj: Math.round(tv), myDelta: Math.round(best.myDelta), theirGain: Math.round(best.gainT), rebuilding, onTaxi, score: best.score, partner: t.owner });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// ---------- trade history grading & calibration ----------
/**
 * Grade a historical trade with today's values.
 * assetValue(asset) → {v, cat:'OFF'|'IDP'|'PICK', label}
 */
export function gradeTrade(tr, assetOf) {
  const sides = {};
  for (const rid of tr.rids) sides[rid] = { rid, got: [], total: 0 };
  for (const pid in tr.adds) { const rid = tr.adds[pid]; const a = assetOf({ kind: 'p', id: pid }); (sides[rid] ||= { rid, got: [], total: 0 }).got.push(a); }
  for (const pk of tr.picks) { const a = assetOf({ kind: 'k', ...pk }); (sides[pk.to] ||= { rid: pk.to, got: [], total: 0 }).got.push(a); }
  const list = Object.values(sides);
  for (const s of list) { s.total = s.got.reduce((a, x) => a + x.v, 0); s.adj = tradeSide(s.got.map(x => x.v)).adj; }
  list.sort((a, b) => b.adj - a.adj);
  const top = list[0], second = list[1] || { adj: 0 };
  return { ...tr, sides: list, winner: top?.rid, margin: top ? top.adj - second.adj : 0, pct: top && top.adj ? (top.adj - second.adj) / top.adj : 0 };
}

/**
 * Least-squares estimate of how the league prices IDP and picks relative to offense,
 * from 2-team trades the managers actually accepted (assumes accepted trades are roughly fair).
 * Returns multipliers {idp, pick, n}. 1.0 = league agrees with the model.
 */
export function calibrate(graded) {
  const rows = [];
  for (const g of graded) {
    if (g.sides.length !== 2) continue;
    const [a, b] = g.sides; const cat = (s, c) => s.got.filter(x => x.cat === c).reduce((t, x) => t + x.v, 0);
    const dO = cat(a, 'OFF') - cat(b, 'OFF'), dI = cat(a, 'IDP') - cat(b, 'IDP'), dP = cat(a, 'PICK') - cat(b, 'PICK');
    const scale = Math.max(1, a.total + b.total);
    if (Math.abs(dI) + Math.abs(dP) < 1) continue;
    rows.push([dI / scale, dP / scale, -dO / scale]);
  }
  const n = rows.length;
  if (n < 3) return { idp: 1, pick: 1, n };
  // ridge-regularized 2x2 normal equations, shrinking toward 1.0
  const lam = 0.05;
  let a11 = lam, a12 = 0, a22 = lam, b1 = lam, b2 = lam;
  for (const [x1, x2, y] of rows) { a11 += x1 * x1; a12 += x1 * x2; a22 += x2 * x2; b1 += x1 * y; b2 += x2 * y; }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-9) return { idp: 1, pick: 1, n };
  const clamp = v => Math.min(2.5, Math.max(0.3, v));
  return { idp: clamp((b1 * a22 - b2 * a12) / det), pick: clamp((a11 * b2 - a12 * b1) / det), n };
}
