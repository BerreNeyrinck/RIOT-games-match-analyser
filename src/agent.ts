import { Agent } from "agents";
import {
  getSummoner,
  getMatchIds,
  getMatch,
  getMatchTimeline,
  extractPlayerData,
  matchToSummary,
  type MatchSummary,
} from "./riot";

export interface Env {
  AI: Ai;
  RIOT_API_KEY: string;
}

// The Agent is a Durable Object — it persists match data in SQLite
// so repeated analyses don't hit the Riot API again.
export class LolAgent extends Agent<Env> {
  // Ensure SQLite tables exist on first use
  private async ensureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        puuid TEXT NOT NULL,
        region TEXT NOT NULL,
        data TEXT NOT NULL,
        timeline TEXT,
        analysis TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
  }

  // ── HTTP request handler ──────────────────────────────────────────
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/matches") {
      return this.handleGetMatches(url);
    }

    if (url.pathname === "/api/analyze") {
      return this.handleAnalyze(url);
    }

    return new Response("Not found", { status: 404 });
  }

  // ── GET /api/matches?summoner=NAME&region=REGION ──────────────────
  // Returns the player's recent match list with basic KDA per game.
  private async handleGetMatches(url: URL): Promise<Response> {
    const summonerName = url.searchParams.get("summoner");
    const region = url.searchParams.get("region") ?? "na1";

    if (!summonerName) {
      return json({ error: "Missing 'summoner' parameter" }, 400);
    }

    const apiKey = this.env.RIOT_API_KEY;
    if (!apiKey) {
      return json({ error: "RIOT_API_KEY secret is not set. Run: wrangler secret put RIOT_API_KEY" }, 500);
    }

    try {
      // 1. Look up the summoner to get their PUUID
      const summoner = await getSummoner(apiKey, region, summonerName);

      // 2. Get recent match IDs
      const matchIds = await getMatchIds(apiKey, region, summoner.puuid, 20);

      // 3. Fetch each match (with simple caching)
      const matches: MatchSummary[] = [];
      for (const id of matchIds) {
        const cached = await this.getCachedMatch(id);
        if (cached) {
          matches.push(matchToSummary(cached, summoner.puuid));
        } else {
          try {
            const matchData = await getMatch(apiKey, region, id);
            await this.cacheMatch(id, summoner.puuid, region, matchData);
            matches.push(matchToSummary(matchData, summoner.puuid));
          } catch {
            // Skip individual match failures
          }
        }
      }

      return json({ summoner, matches });
    } catch (e: any) {
      return json({ error: e.message }, 502);
    }
  }

  // ── GET /api/analyze?matchId=ID&summoner=NAME&region=REGION ───────
  // Fetches full match + timeline, then asks the LLM for a coaching analysis.
  private async handleAnalyze(url: URL): Promise<Response> {
    const matchId = url.searchParams.get("matchId");
    const summonerName = url.searchParams.get("summoner");
    const region = url.searchParams.get("region") ?? "na1";

    if (!matchId || !summonerName) {
      return json({ error: "Missing 'matchId' or 'summoner' parameter" }, 400);
    }

    const apiKey = this.env.RIOT_API_KEY;
    if (!apiKey) {
      return json({ error: "RIOT_API_KEY secret is not set. Run: wrangler secret put RIOT_API_KEY" }, 500);
    }

    try {
      // 1. Get summoner PUUID
      const summoner = await getSummoner(apiKey, region, summonerName);

      // 2. Get match data (cached or fresh)
      let matchData = await this.getCachedMatch(matchId);
      if (!matchData) {
        matchData = await getMatch(apiKey, region, matchId);
        await this.cacheMatch(matchId, summoner.puuid, region, matchData);
      }

      // 3. Get timeline (cached or fresh)
      let timelineData = await this.getCachedTimeline(matchId);
      if (!timelineData) {
        timelineData = await getMatchTimeline(apiKey, region, matchId);
        await this.cacheTimeline(matchId, timelineData);
      }

      // 4. Check for cached analysis
      const cachedAnalysis = await this.getCachedAnalysis(matchId);
      if (cachedAnalysis) {
        return json({ matchId, analysis: cachedAnalysis, cached: true });
      }

      // 5. Extract relevant data for the LLM
      const playerData = extractPlayerData(matchData, timelineData, summoner.puuid);

      // 6. Run the LLM analysis
      const analysis = await this.runLLMAnalysis(playerData);

      // 7. Cache the analysis
      await this.cacheAnalysis(matchId, analysis);

      return json({ matchId, analysis, cached: false });
    } catch (e: any) {
      return json({ error: e.message }, 502);
    }
  }

  // ── LLM analysis via Workers AI ──────────────────────────────────
  // Uses @cf/zai-org/glm-4.7-flash — available on the free plan,
  // 131k context window, supports reasoning and function calling.
  private async runLLMAnalysis(playerData: string): Promise<string> {
    const systemPrompt = `You are an expert League of Legends coach. You analyze match data and provide constructive, specific feedback.

The user will give you a JSON object containing:
- Game info (mode, duration, patch)
- The player's detailed stats (KDA, gold, CS, vision, damage, items, runes, spell casts)
- All 10 participants' basic stats
- A timeline of the player's kills, deaths, and objective participation with timestamps
- A timeline of team-wide events (objectives, buildings)

Analyze the match and provide a detailed coaching breakdown in Markdown:

## Summary
A 2-3 sentence overview of how the game went for the player.

## What Went Well
2-4 bullet points of things the player did correctly.

## What Went Wrong (with timestamps)
This is the most important section. List every significant mistake with the in-game timestamp:
- Deaths: For each death, explain WHY it happened (bad positioning, overextended, caught alone, forced fight, etc.) and what the player should have done instead.
- Missed objectives: If the player was alive but not at an important objective fight, note it.
- CS gaps: If CS/min dropped significantly during a period, note when and why.
- Vision: If vision score is low, note specific time windows where wards were missing.
- Itemization: If items were suboptimal for the matchup, explain why.
- Spell usage: If summoner spell casts seem too low or too high, comment on it.

## Key Moments
2-3 moments that were turning points in the game, with timestamps.

## Actionable Advice
3-5 specific, concrete things the player should focus on improving in their next games. Be specific to their champion and role.

Use the timestamps from the data (they are in MM:SS format). Be honest but constructive. If the player performed well, say so — but still find areas for improvement.`;

    const response = await this.env.AI.run("@cf/zai-org/glm-4.7-flash", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Here is the match data. Analyze the player's performance:\n\n${playerData}` },
      ],
      max_tokens: 4096,
    }) as any;

    return response.response ?? response.message ?? JSON.stringify(response);
  }

  // ── SQLite cache helpers ─────────────────────────────────────────
  private async ensureTable() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        puuid TEXT,
        region TEXT,
        data TEXT,
        timeline TEXT,
        analysis TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
  }

  private async getCachedMatch(matchId: string): Promise<any | null> {
    await this.ensureTable();
    const cursor = this.ctx.storage.sql.exec(
      `SELECT data FROM matches WHERE match_id = ?`, matchId,
    );
    for (const row of cursor) {
      return JSON.parse(row.data as string);
    }
    return null;
  }

  private async cacheMatch(matchId: string, puuid: string, region: string, data: any): Promise<void> {
    await this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO matches (match_id, puuid, region, data) VALUES (?, ?, ?, ?)`,
      matchId, puuid, region, JSON.stringify(data),
    );
  }

  private async getCachedTimeline(matchId: string): Promise<any | null> {
    await this.ensureTable();
    const cursor = this.ctx.storage.sql.exec(
      `SELECT timeline FROM matches WHERE match_id = ?`, matchId,
    );
    for (const row of cursor) {
      if (row.timeline) return JSON.parse(row.timeline as string);
    }
    return null;
  }

  private async cacheTimeline(matchId: string, timeline: any): Promise<void> {
    await this.ensureTable();
    this.ctx.storage.sql.exec(
      `UPDATE matches SET timeline = ? WHERE match_id = ?`,
      JSON.stringify(timeline), matchId,
    );
  }

  private async getCachedAnalysis(matchId: string): Promise<string | null> {
    await this.ensureTable();
    const cursor = this.ctx.storage.sql.exec(
      `SELECT analysis FROM matches WHERE match_id = ?`, matchId,
    );
    for (const row of cursor) {
      if (row.analysis) return row.analysis as string;
    }
    return null;
  }

  private async cacheAnalysis(matchId: string, analysis: string): Promise<void> {
    await this.ensureTable();
    this.ctx.storage.sql.exec(
      `UPDATE matches SET analysis = ? WHERE match_id = ?`,
      analysis, matchId,
    );
  }
}

// Helper: JSON response
function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
