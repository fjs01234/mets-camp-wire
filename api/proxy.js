// Vercel serverless function -- handles all proxy routes for Mets Camp Wire
const SITE = "https://site.api.espn.com/apis/site/v2";
const CORE = "https://sports.core.api.espn.com/v2";
const NYM_ID = "21";

const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

async function espnFetch(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`ESPN ${r.status}: ${url}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { pathname, searchParams } = new URL(req.url, `https://${req.headers.host}`);
  const parts = pathname.replace(/^\/api\/proxy\/?/, '').split('/').filter(Boolean);
  const route = parts[0] || '';

  try {
    // GET /api/proxy/espn?path=...
    if (route === 'espn') {
      const path = searchParams.get('path') || '';
      const data = await espnFetch(`${SITE}/${path}`);
      return res.json(data);
    }

    // GET /api/proxy/scoreboard/baseball/mlb?dates=YYYYMMDD
    if (route === 'scoreboard') {
      const sport = parts[1] || 'baseball';
      const league = parts[2] || 'mlb';
      const dates = searchParams.get('dates') || '';
      const url = dates
        ? `${SITE}/sports/${sport}/${league}/scoreboard?dates=${dates}`
        : `${SITE}/sports/${sport}/${league}/scoreboard`;
      return res.json(await espnFetch(url));
    }

    // GET /api/proxy/news/baseball/mlb/21
    if (route === 'news') {
      const [,sport, league, teamId] = parts;
      const data = await espnFetch(`${SITE}/sports/${sport}/${league}/news?team=${teamId}&limit=20`);
      // Enrich articles
      const articles = (data?.articles || []).map(a => ({
        headline: a.headline || '',
        description: a.description || a.story?.slice(0, 200) || '',
        published: a.published || a.lastModified || '',
        _published: a.published || a.lastModified || '',
        _isPreview: a.type === 'Preview' || /preview/i.test(a.categories?.map(c=>c.description).join(' ') || '')
      }));
      return res.json({ articles });
    }

    // GET /api/proxy/summary/baseball/mlb/:gameId
    if (route === 'summary') {
      const [,sport, league, gameId] = parts;
      return res.json(await espnFetch(`${SITE}/sports/${sport}/${league}/summary?event=${gameId}`));
    }

    // GET /api/proxy/gamedetail/baseball/mlb/21
    if (route === 'gamedetail') {
      const [,sport, league, teamId] = parts;
      return res.json(await handleGameDetail(sport, league, teamId));
    }

    // GET /api/proxy/mlbraw/mets
    if (route === 'mlbraw') {
      const teamSlug = parts[1] || 'mets';
      const r = await fetch(`https://www.mlb.com/news/${teamSlug}-injuries-and-roster-moves`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.google.com/"
        }
      });
      const html = await r.text();
      res.setHeader("Content-Type", "text/html");
      return res.send(html);
    }

    return res.status(404).json({ error: "Unknown route", route, parts });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleGameDetail(sport, league, teamId) {
  const dates = [
    null,
    (() => { const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
    (() => { const d=new Date(); d.setDate(d.getDate()-2); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
    (() => { const d=new Date(); d.setDate(d.getDate()-3); return d.toISOString().slice(0,10).replace(/-/g,""); })(),
  ];

  let gameId = null, gameEvent = null;
  for (const date of dates) {
    const url = date
      ? `${SITE}/sports/${sport}/${league}/scoreboard?dates=${date}`
      : `${SITE}/sports/${sport}/${league}/scoreboard`;
    const sb = await fetch(url, { headers: { Accept: "application/json" } }).catch(()=>null);
    if (!sb?.ok) continue;
    const sbData = await sb.json();
    for (const ev of (sbData?.events || [])) {
      const comp = ev.competitions?.[0];
      const involved = comp?.competitors?.some(c => String(c.team?.id) === String(teamId));
      if (involved && ev.status?.type?.completed) { gameId = ev.id; gameEvent = ev; break; }
    }
    if (gameId) break;
  }
  if (!gameId) return { found: false };

  const sumRes = await fetch(`${SITE}/sports/${sport}/${league}/summary?event=${gameId}`, { headers: { Accept: "application/json" } });
  const sum = await sumRes.json();
  const boxscore = sum?.boxscore || {};
  const players  = boxscore?.players || [];

  // R/H/E
  const teamRHE = {};
  const compObj = gameEvent?.competitions?.[0];
  for (const competitor of (compObj?.competitors || [])) {
    const abbr = competitor?.team?.abbreviation || "";
    if (abbr) teamRHE[abbr] = { R: competitor.score ?? "?", H: "?", E: "0" };
  }
  const lsTeams = sum?.linescore?.teams || [];
  for (const lt of lsTeams) {
    const abbr = lt?.team?.abbreviation || "";
    if (abbr) { teamRHE[abbr] = { R: lt?.runs ?? teamRHE[abbr]?.R ?? "?", H: lt?.hits ?? "?", E: lt?.errors ?? "0" }; }
  }

  const teamStats = [];
  for (const teamBlock of players) {
    const tName = teamBlock?.team?.displayName || "";
    const tAbbr = teamBlock?.team?.abbreviation || "";
    const isNYM = tAbbr === "NYM" || String(teamBlock?.team?.id) === String(teamId);
    const hitters = [], pitchers = [];

    for (const statGroup of (teamBlock?.statistics || [])) {
      const type = (statGroup?.type || statGroup?.name || "").toLowerCase();
      const keys = statGroup?.keys || [];
      const totals = statGroup?.totals || [];

      if (type === "batting" && totals.length) {
        const hIdx = keys.indexOf("hits");
        const rIdx = keys.indexOf("runs");
        if (hIdx >= 0 && totals[hIdx]) teamRHE[tAbbr] = { ...teamRHE[tAbbr], H: totals[hIdx] };
        if (rIdx >= 0 && totals[rIdx] && teamRHE[tAbbr]?.R === "?") teamRHE[tAbbr].R = totals[rIdx];
      }

      for (const ath of (statGroup?.athletes || [])) {
        const name = ath?.athlete?.displayName || "";
        const vals = ath?.stats || [];
        if (!name || !vals.length) continue;
        const sm = {};
        keys.forEach((k, i) => { if (vals[i] != null && vals[i] !== "--") sm[k] = vals[i]; });

        if (type === "batting") {
          const hab = sm["hits-atBats"] || "";
          const hr = sm["homeRuns"]; const rbi = sm["RBIs"]; const bb = sm["walks"];
          if (hab) {
            const habReadable = hab.replace(/^(\d+)-(\d+)$/, "$1 for $2");
            let line = `${name}: ${habReadable}`;
            if (hr && hr !== "0") line += `, ${hr === "1" ? "HR" : hr + " HR"}`;
            if (rbi && rbi !== "0") line += `, ${rbi} RBI`;
            if (bb && bb !== "0") line += `, BB`;
            const hitCount = parseInt(hab.split("-")[0]) || 0;
            if (hitCount > 0 || (hr && hr !== "0") || (rbi && rbi !== "0")) hitters.push({ name, line });
          }
        } else if (type === "pitching") {
          const ip = sm["fullInnings.partInnings"];
          const er = sm["earnedRuns"]; const so = sm["strikeouts"];
          const bb = sm["walks"]; const era = sm["ERA"];
          if (ip) {
            let line = `${name}: ${ip} IP`;
            if (er != null) line += `, ${er} ER`;
            if (so && so !== "0") line += `, ${so} K`;
            if (bb && bb !== "0") line += `, ${bb} BB`;
            if (era) line += ` (ERA: ${era})`;
            pitchers.push({ name, line });
          }
        }
      }
    }

    const rhe = teamRHE[tAbbr] || { R:"?", H:"?", E:"0" };
    teamStats.push({ tName, tAbbr, isNYM, hitters, pitchers, R: rhe.R, H: rhe.H, E: rhe.E });
  }

  // Scoring plays
  const scoringPlays = (sum?.plays || [])
    .filter(p => p?.scoringPlay)
    .slice(0, 8)
    .map(p => ({ text: p?.text || "", score: p?.homeScore !== undefined ? `${p.awayScore}-${p.homeScore}` : "" }));

  const home = compObj?.competitors?.find(c => c.homeAway === "home");
  const away = compObj?.competitors?.find(c => c.homeAway === "away");

  return {
    found: true, gameId,
    home: { name: home?.team?.displayName, abbr: home?.team?.abbreviation, score: home?.score },
    away: { name: away?.team?.displayName, abbr: away?.team?.abbreviation, score: away?.score },
    teamStats, scoringPlays,
    status: gameEvent?.status?.type?.description || "Final"
  };
}
