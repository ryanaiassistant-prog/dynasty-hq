# Dynasty HQ

Self-updating dashboard for the **Super Best Friend Squad Dynasty League** (Sleeper, 12-team superflex IDP).

It's a static site with no server or database. Every page load pulls live data and recalculates in the browser:

| Source | What it provides |
|---|---|
| Sleeper API | league settings and scoring, rosters, taxi/IR, traded picks, standings, stats, weekly projections, matchups, trending adds |
| DynastyProcess (GitHub) | superflex market values for offense, rookie pick value curve, player ID map, NFL draft capital |
| nflverse (GitHub) | schedule, byes, Vegas spreads and totals |
| `data/rookies.json` | pre-NFL-draft rookie board. Once the NFL Draft happens, the app switches to live rookie values automatically |

## Tabs
- **Teams**: power rankings (roster + picks), every roster with values and daily ▲▼ changes
- **Trade**: two-team calculator with a stud-consolidation adjustment, suggestions to balance a deal, the taxi-steal rule check, and a deadline lock banner
- **Draft**: pick ownership grid for 3 seasons, plus a full mock draft (best available × positional need)
- **Lineup**: optimal lineup each week vs your current Sleeper lineup, start/bench moves, opponent projection, win probability
- **Waivers**: every unrostered player, sortable by dynasty value, this week's projection, hot streak, or Sleeper-wide trending adds

## How values work
League-specific model: points per game under *your* scoring (0 PPR, first-down bonuses, incompletion penalty, 1-pt sacks, tackle-heavy IDP), minus positional replacement level for 12 teams with this lineup, × a 5-year age curve. Offense blends 65% market and 35% model. IDP is model-only on the same scale, × 0.8 for volatility. Knobs live in `js/config.js`.

## Hosting
Pushing to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`). Turn it on once in Settings → Pages → Source: **GitHub Actions**.

## Dev
`python3 -m http.server` and open http://localhost:8000. Offline test: `node test/make-fixtures.mjs <dp-dir> && python3 test/e2e.py <dp-dir>`.
