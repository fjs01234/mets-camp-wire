const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('public'));

app.post('/api/recap', async (req, res) => {
  try {
    const today = new Date();
    const dateFormatted = today.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const espnDate = today.toISOString().slice(0,10).replace(/-/g,'');

    let gameContext = 'No Mets game today (off day).';
    let newsContext = 'No recent Mets news available.';

    // ESPN scoreboard
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${espnDate}`);
      if (r.ok) {
        const j = await r.json();
        const game = (j.events||[]).find(e =>
          e.competitions?.[0]?.competitors?.some(c => c.team?.abbreviation === 'NYM')
        );
        if (game) {
          const comp = game.competitions[0];
          const home = comp.competitors.find(c => c.homeAway === 'home');
          const away = comp.competitors.find(c => c.homeAway === 'away');
          const status = comp.status?.type?.description || '';
          const venue = comp.venue?.fullName || '';
          gameContext = `${away.team.displayName} @ ${home.team.displayName}\nScore: ${away.team.displayName} ${away.score} - ${home.team.displayName} ${home.score}\nStatus: ${status}${venue ? '\nVenue: ' + venue : ''}`;
        }
      }
    } catch(e) { console.log('ESPN score error:', e.message); }

    // ESPN news
    try {
      const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news?team=21&limit=5');
      if (r.ok) {
        const j = await r.json();
        const arts = (j.articles||[]).slice(0,4);
        if (arts.length) newsContext = arts.map((a,i) => `${i+1}. ${a.headline}${a.description?' - '+a.description:''}`).join('\n');
      }
    } catch(e) { console.log('ESPN news error:', e.message); }

    // Call Anthropic
    const prompt = `You are writing a fun daily Mets baseball recap email from a dad named Jason to his two kids at summer camp: Noah (age 15) and Emily (age 12). Both LOVE the New York Mets.

Today: ${dateFormatted}

METS GAME DATA:
${gameContext}

RECENT METS NEWS:
${newsContext}

Write a plain text email. No HTML, no markdown, no asterisks, no bullet symbols. Rules:
- Line 1: "SUBJECT: [fun subject line]"
- Blank line
- Open: "Hey Noah and Emily!"
- Lead with the score if available, or talk about the Mets season if no game
- Mention 1-2 news items conversationally
- Include "METS MOOD OF THE DAY: [description] [X]/10"
- End with a Mets trivia question or dad joke
- Sign off warmly from Dad
- Under 300 words, punchy and fun`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await anthropicRes.json();
    const emailText = data.content?.find(b => b.type === 'text')?.text || '';
    if (!emailText) throw new Error(data.error?.message || 'No text returned');

    res.json({ email: emailText });
  } catch(err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mets Camp Wire running on port ${PORT}`));
