async function fetchStats(homeTeamId, awayTeamId) {
  try {
    const headers = {
      "x-apisports-key": process.env.API_FOOTBALL_KEY,
    };

    const league = 39;      // Premier League
    const season = 2024;    // Change if needed

    // 1️⃣ Head-to-Head
    const h2hRes = await fetch(
      `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}`,
      { headers }
    );
    const h2hData = await h2hRes.json();

    // 2️⃣ Home team stats
    const homeRes = await fetch(
      `https://v3.football.api-sports.io/teams/statistics?league=${league}&season=${season}&team=${homeTeamId}`,
      { headers }
    );
    const homeData = await homeRes.json();

    // 3️⃣ Away team stats
    const awayRes = await fetch(
      `https://v3.football.api-sports.io/teams/statistics?league=${league}&season=${season}&team=${awayTeamId}`,
      { headers }
    );
    const awayData = await awayRes.json();

    return {
      h2h: h2hData.response || [],

      homeStats: {
        goalsScored: homeData.response?.goals?.for?.total?.total || 0,
        goalsConceded: homeData.response?.goals?.against?.total?.total || 0,
        recentForm:
          homeData.response?.form
            ? homeData.response.form.split("")
            : [],
        wins: homeData.response?.fixtures?.wins?.total || 0,
        draws: homeData.response?.fixtures?.draws?.total || 0,
        losses: homeData.response?.fixtures?.loses?.total || 0,
      },

      awayStats: {
        goalsScored: awayData.response?.goals?.for?.total?.total || 0,
        goalsConceded: awayData.response?.goals?.against?.total?.total || 0,
        recentForm:
          awayData.response?.form
            ? awayData.response.form.split("")
            : [],
        wins: awayData.response?.fixtures?.wins?.total || 0,
        draws: awayData.response?.fixtures?.draws?.total || 0,
        losses: awayData.response?.fixtures?.loses?.total || 0,
      },
    };
  } catch (err) {
    console.log("Error fetching stats:", err);
    return {
      h2h: [],
      homeStats: {},
      awayStats: {},
    };
  }
}
