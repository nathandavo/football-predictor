const express = require('express');
const router = express.Router();
const axios = require('axios');

router.get('/upcoming', async (req, res) => {
  try {
    const response = await axios.get('https://api-football-v1.p.rapidapi.com/v3/fixtures', {
      params: { season: '2025', next: 10 },
      headers: {
        'X-RapidAPI-Key': process.env.FOOTBALL_API_KEY,
        'X-RapidAPI-Host': 'api-football-v1.p.rapidapi.com'
      }
    });

    const fixtures = response.data.response.map(f => ({
      fixtureId: f.fixture.id,
      home: f.teams.home.name,
      away: f.teams.away.name
    }));

    res.json(fixtures);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: 'Could not fetch fixtures' });
  }
});

module.exports = router;
