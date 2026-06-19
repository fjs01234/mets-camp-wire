// Vercel serverless function -- AI-written Mets recap emails for Noah and Emily
// Keeps factual data (scores, box scores, stat lines) exact; only the narrative voice is AI-generated.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const SYSTEM_NOAH = `You are ghost-writing a short daily New York Mets recap email from a dad to his 15 year old son Noah, who is away at sleepaway camp (Camp Schodack) and is a stats-focused, knowledgeable Mets fan.

Voice: talk to Noah like a fellow Mets fan who follows the team closely. Use real baseball language (ERA, OPS, bullpen, lineup, NL East race, etc). Dry humor is welcome. Do not be cutesy or oversimplify -- Noah wants real analysis, not hype.

IMPORTANT: Do not reference him coming home, returning from camp, seeing him "when he gets back," or anything about the end of the camp session. This should read as an in-the-moment daily note, not a goodbye or homecoming message.

You will be given structured JSON with the day's game facts (score, box score lines, pitching lines, injuries, news, standings). Do NOT invent any stats, names, or facts not present in the data. If the data says no game today, say so plainly.

Output ONLY the body text of the email (no subject line, no "Hey Noah" greeting needed -- the app adds those separately). Write 2-4 short paragraphs max. Keep it tight -- a teenager at camp will skim, not read an essay. Do not use markdown formatting, headers, or bullet asterisks; just plain conversational paragraphs.`;

const SYSTEM_EMILY = `You are ghost-writing a short daily New York Mets recap email from a dad to his 12 year old daughter Emily, who is away at sleepaway camp (Camp Schodack). She's an enthusiastic Mets fan but doesn't follow deep stats -- she cares about the vibe, the fun moments, and feeling connected to the team and her dad while she's away.

Voice: warm, upbeat, simple language, lots of enthusiasm (it's fine to use exclamation points and ALL CAPS for excitement sparingly), but don't be patronizing. Mention a fun highlight or two by name. End on a sweet, loving note that she's missed.

IMPORTANT: Do not reference her coming home, returning from camp, seeing her "when she gets back," or anything about the end of the camp session. She is in the middle of her stay and this should read as an in-the-moment daily note, not a goodbye or homecoming message.

You will be given structured JSON with the day's game facts. Do NOT invent any stats, names, or facts not present in the data. If there's no game today, that's fine, just say the team is resting.

Output ONLY the body text of the email (no subject line, no greeting needed -- the app adds those separately). Write 2-3 short paragraphs max. Do not use markdown formatting, headers, or bullet asterisks; just plain warm paragraphs.`;

function buildUserPrompt(gameData) {
  return `Here is today's Mets data as JSON. Write the email body now, following your system instructions exactly. Only use facts present below.\n\n${JSON.stringify(gameData, null, 2)}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed, use POST" });
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY env var" });
    }

    const { recipient, gameData } = req.body || {};
    if (!recipient || !gameData) {
      return res.status(400).json({ error: "Missing recipient or gameData in request body" });
    }

    const system = recipient === "emily" ? SYSTEM_EMILY : SYSTEM_NOAH;

    const anthropicRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system,
        messages: [{ role: "user", content: buildUserPrompt(gameData) }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return res.status(502).json({ error: `Anthropic API ${anthropicRes.status}: ${errText}` });
    }

    const data = await anthropicRes.json();
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    if (!text) {
      return res.status(502).json({ error: "Anthropic API returned no text content" });
    }

    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
