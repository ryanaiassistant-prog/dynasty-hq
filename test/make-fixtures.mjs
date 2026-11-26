// Builds Sleeper-shaped fixtures from real DynastyProcess IDs/values so the app can be tested offline.
import fs from 'fs';
import { parseCSV } from '../js/data.js';
const DP = process.argv[2] || '/tmp/dp';
const out = new URL('./fx/', import.meta.url).pathname; fs.mkdirSync(out, { recursive: true });
const W = (n, o) => fs.writeFileSync(out + n, JSON.stringify(o));
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const ids = parseCSV(fs.readFileSync(DP + '/db_playerids.csv', 'utf8'));
const vals = parseCSV(fs.readFileSync(DP + '/values-players.csv', 'utf8'));
const fp2s = {}; for (const r of ids) if (r.sleeper_id !== 'NA' && r.fantasypros_id !== 'NA') fp2s[r.fantasypros_id] = r.sleeper_id;
const mv = {}; for (const v of vals) { const s = fp2s[v.fp_id]; if (s) mv[s] = +v.value_2qb; }
const FP = { QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], PK: ['K'], DE: ['DL'], DT: ['DL'], LB: ['LB'], CB: ['DB'], S: ['DB'] };
const players = {};
for (const r of ids) {
  if (r.sleeper_id === 'NA' || r.db_season !== '2026' || r.team === 'NA' || !FP[r.position]) continue;
  const pos = r.position === 'PK' ? 'K' : r.position;
  players[r.sleeper_id] = { player_id: r.sleeper_id, full_name: r.name, position: pos, fantasy_positions: FP[r.position], team: r.team === 'LVR' ? 'LV' : r.team === 'LA' ? 'LAR' : r.team,
    age: Math.round(+r.age) || 26, years_exp: Math.max(0, 2026 - (+r.draft_year || 2022)), injury_status: rnd() < 0.06 ? (rnd() < 0.5 ? 'Questionable' : 'Out') : null };
}
const pids = Object.keys(players);
const quality = {}; for (const pid of pids) quality[pid] = mv[pid] ? mv[pid] / 10000 : rnd() * 0.5;
function stats(pid, games) {
  const p = players[pid], q = quality[pid] * (0.7 + rnd() * 0.6), g = games;
  const s = { gp: g };
  if (p.position === 'QB') Object.assign(s, { pass_yd: g * (150 + 130 * q), pass_td: g * (0.8 + 1.4 * q), pass_cmp: g * (15 + 9 * q), pass_inc: g * (11 - 3 * q), pass_int: g * 0.7, rush_yd: g * 15 * q, rush_fd: g * q });
  if (p.position === 'RB') Object.assign(s, { rush_yd: g * (25 + 70 * q), rush_td: g * 0.6 * q, rush_fd: g * (1 + 4 * q), rec_yd: g * 20 * q, rec_fd: g * q, fum_lost: g * 0.05 });
  if (p.position === 'WR') Object.assign(s, { rec_yd: g * (20 + 75 * q), rec_td: g * 0.55 * q, rec_fd: g * (1 + 4 * q) });
  if (p.position === 'TE') Object.assign(s, { rec_yd: g * (12 + 55 * q), rec_td: g * 0.45 * q, rec_fd: g * (0.6 + 3 * q) });
  if (p.position === 'K') Object.assign(s, { fgm: g * 1.8, xpm: g * 2.4, fgm_yds_over_30: g * 25 });
  const idp = { LB: [4.5, 2.5], S: [3.5, 1.5], CB: [3, 1], DE: [2, 1.2], DT: [1.6, 1.4] }[p.position];
  if (idp) { const iq = 0.4 + rnd() * 0.9; Object.assign(s, { idp_tkl_solo: g * idp[0] * iq, idp_tkl_ast: g * idp[1] * iq, idp_tkl_loss: g * 0.4 * iq, idp_sack: g * (p.position === 'DE' ? 0.5 : 0.1) * iq, idp_qb_hit: g * (p.position === 'DE' ? 1 : 0.2) * iq, idp_pass_def: g * (p.position === 'CB' ? 0.8 : 0.2) * iq, idp_int: g * 0.05 * iq, idp_ff: g * 0.05 }); }
  return s;
}
const cur = {}, prev = {}; const wk = {}, proj = {};
for (const pid of pids) { if (rnd() < 0.9) cur[pid] = stats(pid, 7 + Math.floor(rnd() * 5)); if (players[pid].years_exp > 0 && rnd() < 0.9) prev[pid] = stats(pid, 10 + Math.floor(rnd() * 7)); }
for (const w of [9, 10, 11]) { wk[w] = {}; for (const pid in cur) if (rnd() < 0.85) wk[w][pid] = stats(pid, 1); }
for (const pid in cur) if (rnd() < 0.8) proj[pid] = stats(pid, 1);
W('stats-2026.json', cur); W('stats-2025.json', prev); for (const w in wk) W(`stats-2026-${w}.json`, wk[w]); W('proj-2026-12.json', proj); W('players.json', players);

// League (real settings) + 12 rosters
const league = JSON.parse(fs.readFileSync(new URL('./league.json', import.meta.url)));
W('league.json', league);
const names = ['rynosmitty', 'victorl2013', 'andygauer', 'skilletbeans', 'jdub', 'mgreen', 'tbone', 'kcrew', 'pmac', 'drizzy', 'lou22', 'bigsexy'];
const users = names.map((n, i) => ({ user_id: 'u' + (i + 1), display_name: n, metadata: { team_name: i === 0 ? 'Bo & the Injured Reserve' : n.toUpperCase() + ' FC' } }));
W('users.json', users);
const pool = pids.slice().sort((a, b) => (mv[b] || quality[b] * 3000) - (mv[a] || quality[a] * 3000));
const rosters = names.map((_, i) => ({ roster_id: i + 1, owner_id: 'u' + (i + 1), players: [], starters: [], taxi: [], reserve: [], settings: { wins: 0, losses: 0, fpts: 0 } }));
const off = pool.filter(p => ['QB', 'RB', 'WR', 'TE', 'K'].includes(players[p].position)).slice(0, 12 * 24);
const def = pool.filter(p => !['QB', 'RB', 'WR', 'TE', 'K'].includes(players[p].position)).sort(() => rnd() - 0.5).slice(0, 12 * 14);
off.forEach((p, i) => rosters[(Math.floor(i / 12) % 2 ? 11 - i % 12 : i % 12)].players.push(p));
def.forEach((p, i) => rosters[i % 12].players.push(p));
rosters.forEach((r, i) => { r.taxi = r.players.filter(p => players[p].years_exp <= 1).slice(0, 3); r.reserve = r.players.filter(p => players[p].injury_status === 'Out').slice(0, 2);
  r.starters = r.players.slice(0, 19); r.settings = { wins: Math.floor(rnd() * 11), losses: 0, fpts: 1400 + Math.floor(rnd() * 500), fpts_decimal: 25 }; r.settings.losses = 11 - r.settings.wins; });
W('rosters.json', rosters);
W('traded.json', [{ season: '2027', round: 1, roster_id: 2, owner_id: 1, previous_owner_id: 2 }, { season: '2027', round: 2, roster_id: 5, owner_id: 1, previous_owner_id: 5 }, { season: '2028', round: 1, roster_id: 4, owner_id: 1, previous_owner_id: 4 }, { season: '2027', round: 1, roster_id: 1, owner_id: 7, previous_owner_id: 1 }]);
W('drafts.json', [{ draft_id: 'd26', season: '2026', status: 'complete', slot_to_roster_id: {} }]);
W('matchups.json', rosters.map(r => ({ roster_id: r.roster_id, matchup_id: Math.ceil(r.roster_id / 2), starters: r.starters })));
W('state.json', { season: '2026', season_type: 'regular', week: 12, display_week: 12 });
W('trending.json', pids.filter(p => !rosters.some(r => r.players.includes(p))).slice(0, 30).map((p, i) => ({ player_id: p, count: 5000 - i * 150 })));
W('userleagues.json', []);
console.log('players', pids.length, 'rostered', rosters.reduce((a, r) => a + r.players.length, 0));

// ---- trade history fixtures
{
  const R = rosters; const pick = (r, f) => r.players.filter(f)[Math.floor(rnd() * r.players.filter(f).length)];
  const isIdp = p => !['QB', 'RB', 'WR', 'TE', 'K'].includes(players[p].position), isOff = p => !isIdp(p);
  const tx = [];
  const mk = (id, ts, a, b, aGets, bGets, picks = []) => tx.push({ transaction_id: id, type: 'trade', status: 'complete', status_updated: ts, created: ts, roster_ids: [a, b],
    adds: Object.fromEntries([...aGets.map(p => [p, a]), ...bGets.map(p => [p, b])]), draft_picks: picks });
  const now = Date.now(), d = 86400e3;
  mk('t1', now - 20 * d, 1, 2, [pick(R[1], isOff)], [pick(R[0], isIdp), pick(R[0], isIdp)]);
  mk('t2', now - 35 * d, 3, 4, [pick(R[3], isIdp)], [pick(R[2], isOff)]);
  mk('t3', now - 50 * d, 5, 6, [pick(R[5], isOff)], [], [{ season: '2027', round: 1, roster_id: 5, owner_id: 6, previous_owner_id: 5 }, { season: '2027', round: 2, roster_id: 5, owner_id: 6, previous_owner_id: 5 }]);
  mk('t4', now - 70 * d, 1, 7, [pick(R[6], isOff), pick(R[6], isIdp)], [pick(R[0], isOff)], [{ season: '2026', round: 1, roster_id: 7, owner_id: 1, previous_owner_id: 7 }]);
  mk('t5', now - 90 * d, 8, 9, [pick(R[8], isIdp), pick(R[8], isIdp)], [pick(R[7], isOff)]);
  mk('t6', now - 110 * d, 10, 11, [pick(R[10], isOff)], [pick(R[9], isIdp)], [{ season: '2027', round: 3, roster_id: 10, owner_id: 11, previous_owner_id: 10 }]);
  W('tx-5.json', tx.slice(0, 3)); W('tx-9.json', tx.slice(3));
  const rookies = pids.filter(p => players[p].years_exp === 0).slice(0, 24);
  W('drafts.json', [{ draft_id: 'd26', season: '2026', status: 'complete', slot_to_roster_id: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 12 - i])) }]);
  W('draftpicks.json', rookies.map((p, i) => ({ round: Math.floor(i / 12) + 1, draft_slot: (i % 12) + 1, roster_id: 12 - (i % 12), player_id: p, pick_no: i + 1 })));
}
