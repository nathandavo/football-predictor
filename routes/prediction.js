// routes/prediction.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth'); 
const OpenAI = require('openai');
const User = require('../models/User');
const fetch = require('node-fetch'); // npm i node-fetch@2

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getGameWeek() {
  const seasonStart = new Date('2025-08-01');
  const today = new Date();
  const diff = Math.floor((today - seasonStart) / (1000*60*60*24));
  return Math.max(1, Math.min(38, Math.ceil(diff/7)));
}

async function fetchStats(homeTeamId, awayTeamId) {
  try {
    const key = process.env.FOOTBALL_API_KEY;
    if (!key) return { homeStats: {}, awayStats: {}, h2h: [] };
    const headers = { 'x-apisports-key': key };
    const league = 39;

    const getRecentForm = async (teamId) => {
      const res = await fetch(`https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${league}&last=5`, { headers });
      const data = await res.json().catch(()=>({}));
      if (!data.response) return [];
      const sorted = data.response.sort((a,b)=>new Date(a.fixture.date)-new Date(b.fixture.date));
      return sorted.map(match=>{
        if (match.teams.home.id===teamId){
          if (match.goals.home>match.goals.away) return "W";
          if (match.goals.home<match.goals.away) return "L";
          return "D";
        } else {
          if (match.goals.away>match.goals.home) return "W";
          if (match.goals.away<match.goals.home) return "L";
          return "D";
        }
      });
    };

    const h2hRes = await fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}`, { headers });
    const h2hData = await h2hRes.json().catch(()=>({}));
    const h2hArray = h2hData?.response ?? [];
    const lastH2H = h2hArray.length>0 ? [h2hArray[0]] : [];

    const [homeForm, awayForm] = await Promise.all([getRecentForm(homeTeamId), getRecentForm(awayTeamId)]);

    const safe = (obj,path,fallback=null)=>{try{return path.split('.').reduce((a,b)=>(a&&a[b]!==undefined?a[b]:undefined),obj)??fallback}catch{return fallback}};

    const [homeStatsRes, awayStatsRes] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${homeTeamId}`,{headers}),
      fetch(`https://v3.football.api-sports.io/teams/statistics?league=${league}&season=2025&team=${awayTeamId}`,{headers}),
    ]);

    const homeData = await homeStatsRes.json().catch(()=>({}));
    const awayData = await awayStatsRes.json().catch(()=>({}));

    return {
      h2h: lastH2H,
      homeStats: {
        id: homeTeamId,
        name: safe(homeData,'response.team.name','Home Team'),
        recentForm: homeForm,
      },
      awayStats: {
        id: awayTeamId,
        name: safe(awayData,'response.team.name','Away Team'),
        recentForm: awayForm,
      },
    };
  } catch (err) {
    console.log('Error fetching stats:', err);
    return {
      h2h: [],
      homeStats: { id:null, name:'Home', recentForm:[] },
      awayStats: { id:null, name:'Away', recentForm:[] },
    };
  }
}

router.post('/free', auth, async (req,res)=>{
  try{
    let {fixtureId, homeTeam, awayTeam} = req.body;
    if (!homeTeam && req.body.fixture){
      const f=req.body.fixture;
      homeTeam=f?.home?.id ?? homeTeam;
      awayTeam=f?.away?.id ?? awayTeam;
      fixtureId=fixtureId ?? f?.id;
    }
    if (homeTeam?.id) homeTeam=homeTeam.id;
    if (awayTeam?.id) awayTeam=awayTeam.id;
    if (!homeTeam||!awayTeam) return res.status(400).json({error:'homeTeam and awayTeam IDs required'});

    const gameweek=`GW${getGameWeek()}`;
    if (!req.user?.id) return res.status(401).json({error:'Unauthorized: user missing'});
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({error:'User not found'});
    if (!user.isPremium && user.freePredictions?.[gameweek]) return res.status(403).json({error:'Free prediction already used this week'});

    const stats = await fetchStats(homeTeam, awayTeam);

    // PROMPT for single-line colored charts and short insight
    const prompt=[
      `You are a football analyst. Provide the output in the following format ONLY:`,
      `1) ONE SINGLE-LINE colored bar for Win Probability, divided by Home (green), Draw (yellow), Away (red).`,
      `2) ONE SINGLE-LINE colored bar for BTTS Probability (green = yes, red = no).`,
      `3) ONE SINGLE-LINE colored bar for Expected Goals (green = Home goals, red = Away goals).`,
      `4) Numbers UNDER the single bars to show % or expected goals.`,
      `5) Recent form as colored buttons for last 5 matches (no letters, just colors).`,
      `6) Short 1-2 sentence insight summarizing form effect.`,
      `Use actual team names.`,
      `Do NOT create multiple recent form charts, only ONE summary.`,
      `Do NOT exceed 300 words.`,
      `Home team: ${stats.homeStats.name}`,
      `Away team: ${stats.awayStats.name}`,
      `Stats: ${JSON.stringify(stats)}`
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model:'gpt-4o-mini',
      messages:[
        {role:'system', content:'You are a football analyst specialized in concise colored single-line charts.'},
        {role:'user', content:prompt}
      ],
      max_tokens:400,
      temperature:0.75,
    });

    const prediction = completion.choices?.[0]?.message?.content ?? 'No prediction returned';

    if (!user.isPremium){
      user.freePredictions = user.freePredictions || {};
      user.freePredictions[gameweek]=true;
      await user.save();
    }

    res.json({prediction, stats});

  }catch(err){
    console.error('Prediction route error:',err);
    if(err?.status===429) return res.status(429).json({error:'OpenAI quota/rate limit. Check your API key and quota.'});
    res.status(500).json({error:'Prediction failed'});
  }
});

module.exports=router;
