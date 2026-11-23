// League config — the only file you might ever edit.
export const CONFIG = {
  leagueId: '1348689730811736064',   // auto-follows to next season's league after Sleeper rollover
  myUsername: 'rynosmitty',            // default team in Lineup / Trade tabs
  marketWeight: 0.65,                  // offense: share of value from market (DynastyProcess superflex) vs league-scoring model
  idpWeight: 0.8,                      // IDP volatility discount (IDP production is less sticky year to year)
  houseRules: {
    taxiStealMinRound: 2,              // stealing a taxi player requires at least a 2nd-round pick
    offseasonTradeOpen: null,          // e.g. '2027-04-20' once the league sets it; trades reopen for rookie draft
  },
};

export const SOURCES = {
  sleeper: 'https://api.sleeper.app/v1',
  dpValues: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv',
  dpPicks: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-picks.csv',
  dpIds: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv',
  games: 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',
  rookies: './data/rookies.json',
};
