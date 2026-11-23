// Data layer: fetch live sources, trim, cache in localStorage.
import { SOURCES } from './config.js';
import { scoreStats, groupOf, GROUPS } from './engine.js';

const S = SOURCES.sleeper;
const H = 3600e3;
const TEAM_FIX = { LA: 'LAR' };

export async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function cached(key, ttl, loader) {
  try {
    const raw = localStorage.getItem('dhq:' + key);
    if (raw) { const o = JSON.parse(raw); if (Date.now() - o.t < ttl) return o.v; }
  } catch { /* storage unavailable */ }
  const v = await loader();
  try { localStorage.setItem('dhq:' + key, JSON.stringify({ t: Date.now(), v })); }
  catch { pruneCache(); try { localStorage.setItem('dhq:' + key, JSON.stringify({ t: Date.now(), v })); } catch { /* give up */ } }
  return v;
}
function pruneCache() {
  try {
    const keys = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('dhq:')) keys.push(k); }
    keys.filter(k => /wk|proj/.test(k)).forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
export function clearCache() {
  try { Object.keys(localStorage).filter(k => k.startsWith('dhq:')).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
}

export function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// ---------- Sleeper ----------
export const sleeper = {
  state: () => getJSON(`${S}/state/nfl`),
  league: id => getJSON(`${S}/league/${id}`),
  users: id => getJSON(`${S}/league/${id}/users`),
  rosters: id => getJSON(`${S}/league/${id}/rosters`),
  traded: id => getJSON(`${S}/league/${id}/traded_picks`),
  drafts: id => getJSON(`${S}/league/${id}/drafts`),
  matchups: (id, w) => getJSON(`${S}/league/${id}/matchups/${w}`),
  userLeagues: (uid, season) => getJSON(`${S}/user/${uid}/leagues/nfl/${season}`),
  trending: () => cached('trend', 1 * H, () => getJSON(`${S}/players/nfl/trending/add?lookback_hours=48&limit=100`)),
};

/** Follow the league forward after Sleeper's season rollover so config never needs editing. */
export async function resolveLeague(id) {
  let league = await sleeper.league(id);
  for (let hop = 0; hop < 3; hop++) {
    try {
      const users = await sleeper.users(league.league_id);
      const u = users[0]; if (!u) break;
      const next = await sleeper.userLeagues(u.user_id, Number(league.season) + 1);
      const nl = (next || []).find(l => l.previous_league_id === league.league_id);
      if (!nl) break;
      league = nl;
    } catch { break; }
  }
  return league;
}

const KEEP_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DE', 'DT', 'NT', 'DL', 'LB', 'OLB', 'ILB', 'MLB', 'CB', 'S', 'SS', 'FS', 'DB']);
export function trimPlayers(all, rosteredSet) {
  const out = {};
  for (const pid in all) {
    const p = all[pid];
    if (!KEEP_POS.has(p.position)) continue;
    if (!p.team && !rosteredSet.has(pid)) continue;
    out[pid] = {
      n: p.full_name || `${p.first_name} ${p.last_name}`, pos: p.position, fp: p.fantasy_positions || [],
      team: p.team || null, age: p.age || null, exp: p.years_exp ?? null, inj: p.injury_status || null,
      dc: p.depth_chart_order ?? null, num: p.number ?? null,
    };
  }
  return out;
}
export async function loadPlayers(rosteredSet) {
  // Big (~5MB) file: refresh once per 12h, store trimmed.
  const trimmed = await cached('players', 12 * H, async () => trimPlayers(await getJSON(`${S}/players/nfl`), rosteredSet));
  return trimmed;
}

function statsToPts(obj, scoring) {
  const out = {};
  for (const pid in obj || {}) { const s = obj[pid]; if (!s) continue; const gp = s.gp || 0; const pts = scoreStats(s, scoring); if (gp || pts) out[pid] = { gp, pts }; }
  return out;
}
export async function loadSeasonPts(season, scoring, leagueId, current) {
  return cached(`season:${leagueId}:${season}`, (current ? 6 : 24 * 7) * H, async () =>
    statsToPts(await getJSON(`${S}/stats/nfl/regular/${season}`), scoring));
}
export async function loadWeekPts(season, week, scoring, leagueId) {
  return cached(`wk:${leagueId}:${season}:${week}`, 24 * H, async () => {
    const raw = await getJSON(`${S}/stats/nfl/regular/${season}/${week}`);
    const out = {}; for (const pid in raw || {}) { const s = raw[pid]; if (s && (s.gp || s.off_snp || s.def_snp)) out[pid] = scoreStats(s, scoring); }
    return out;
  });
}
export async function loadProjections(season, week, scoring, leagueId) {
  return cached(`proj:${leagueId}:${season}:${week}`, 1 * H, async () => {
    const out = {};
    try {
      const raw = await getJSON(`${S}/projections/nfl/regular/${season}/${week}`);
      for (const pid in raw || {}) { const s = raw[pid]; if (s) { const v = scoreStats(s, scoring); if (v) out[pid] = v; } }
    } catch { /* projections endpoint optional */ }
    if (Object.keys(out).length < 50) {
      try {
        const pos = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'].map(p => `position[]=${p}`).join('&');
        const arr = await getJSON(`https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular&${pos}`);
        for (const r of arr || []) { const v = scoreStats(r.stats, scoring); if (v) out[r.player_id] = v; }
      } catch { /* ignore */ }
    }
    return out;
  });
}

// ---------- DynastyProcess ----------
export async function loadMarket() {
  return cached('dp', 12 * H, async () => {
    const [vals, picks, ids] = await Promise.all([getText(SOURCES.dpValues), getText(SOURCES.dpPicks), getText(SOURCES.dpIds)]);
    const idRows = parseCSV(ids);
    const fpToSleeper = {}, capital = {}, classRows = [];
    const thisYear = new Date().getFullYear();
    for (const r of idRows) {
      const sid = r.sleeper_id; const hasS = sid && sid !== 'NA';
      if (hasS && r.fantasypros_id && r.fantasypros_id !== 'NA') fpToSleeper[r.fantasypros_id] = sid;
      const dy = +r.draft_year;
      if (hasS && dy >= thisYear - 4) capital[sid] = { dy, dr: +r.draft_round || null, do: +r.draft_ovr || null };
      if (dy >= thisYear && r.draft_ovr && r.draft_ovr !== 'NA') classRows.push({ sid: hasS ? sid : null, name: r.name, pos: r.position, school: r.college, dy, do: +r.draft_ovr });
    }
    const market = {}, marketByName = {};
    for (const r of parseCSV(vals)) {
      const v = +r.value_2qb; if (!v) continue;
      const sid = fpToSleeper[r.fp_id];
      if (sid) market[sid] = v; else marketByName[norm(r.player)] = v;
      if (+r.draft_year >= thisYear) classRows.push({ sid: sid || null, name: r.player, pos: r.pos, dy: +r.draft_year, market: v });
    }
    const pickRows = parseCSV(picks).map(r => ({ player: r.player, ecr_2qb: r.ecr_2qb }));
    return { market, marketByName, capital, pickRows, classRows };
  });
}
export const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '').replace(/(jr|sr|ii|iii|iv|v)$/, '');

// ---------- schedule + Vegas lines ----------
export async function loadGames(season) {
  return cached(`games:${season}`, 3 * H, async () => {
    const rows = parseCSV(await getText(SOURCES.games));
    return rows.filter(r => r.season === String(season) && r.game_type === 'REG').map(r => ({
      w: +r.week, away: TEAM_FIX[r.away_team] || r.away_team, home: TEAM_FIX[r.home_team] || r.home_team,
      spread: r.spread_line === 'NA' || r.spread_line === '' ? 0 : +r.spread_line,
      total: r.total_line === 'NA' || r.total_line === '' ? 44 : +r.total_line,
      kickoff: `${r.gameday}T${r.gametime || '13:00'}`, done: r.home_score !== 'NA' && r.home_score !== '',
    }));
  });
}

export async function loadRookieBoard() {
  try { return await getJSON(SOURCES.rookies + '?v=' + Math.floor(Date.now() / H)); } catch { return null; }
}

export { GROUPS, groupOf };
