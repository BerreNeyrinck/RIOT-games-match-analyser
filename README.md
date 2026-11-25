# LoL Match Analyzer — AI Coach

A website that analyzes your League of Legends matches using the Riot API and gives you an LLM-powered coaching breakdown of what you did wrong and when.

**Stack:**
- **Cloudflare Agents** (Durable Object) — stateful agent that caches match data in SQLite and orchestrates the analysis
- **Riot Games API** — fetches summoner info, match history, full match data, and match timelines
- **Workers AI** (`@cf/zai-org/glm-4.7-flash`) — generates the coaching analysis (free tier: 10,000 neurons/day)

## Prerequisites

1. A [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. [Node.js](https://nodejs.org/) v18+
3. A **Riot API key** — get one at https://developer.riotgames.com/ (sign in, then your key appears on the dashboard)
   - Development keys are free and expire every 24 hours
   - Production keys are permanent (require a Riot app submission)

## Setup

```bash
# Install dependencies
npm install

# Set your Riot API key as a secret
npx wrangler secret put RIOT_API_KEY
# Paste your API key when prompted (e.g. RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
```

## Run locally

```bash
npm run dev
```

Open `http://localhost:8787`, enter your summoner name, pick your region, and search.

## Deploy

```bash
npm run deploy
```

Your site will be live at `https://lol-match-analyzer.<your-subdomain>.workers.dev`.

## How it works

```
Browser → Worker (src/index.ts)
  ├── /api/* → routeAgentRequest → LolAgent (Durable Object)
  │     ├── GET /api/matches  → Riot API: summoner + match list → returns KDA per game
  │     └── GET /api/analyze  → Riot API: match + timeline → extract player data → Workers AI → coaching analysis
  └── /*     → static assets (public/index.html)
```

The Agent caches match data, timelines, and analyses in its built-in SQLite storage, so:
- Repeated match list loads don't re-hit the Riot API
- Analyses are cached — viewing the same match twice returns instantly

## Free tier limits

| Resource | Free limit |
|---|---|
| Workers AI | 10,000 neurons/day (resets at 00:00 UTC) |
| Workers requests | 100,000/day |
| Durable Objects (SQLite) | Available on free plan |
| Riot API (dev key) | 20 req/s, 100 req/2min |

## Customizing

- **Different LLM model**: Change `@cf/zai-org/glm-4.7-flash` in `src/agent.ts` to any [Workers AI model](https://developers.cloudflare.com/workers-ai/models/) on the free plan (e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`)
- **Analysis depth**: Edit the system prompt in `src/agent.ts` → `runLLMAnalysis()` to change what the coach focuses on
- **Match count**: Change the `count` parameter in `getMatchIds()` (default: 20)
