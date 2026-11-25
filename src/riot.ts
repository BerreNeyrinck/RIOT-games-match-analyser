// ─── Riot API client ───────────────────────────────────────────────
// Docs: https://developer.riotgames.com/docs/lol
// All endpoints require an API key passed as the `X-Riot-Token` header.

// Platform (summoner) routing → regional (match) routing map.
// Summoner lookups use the platform host (e.g. na1.api.riotgames.com).
// Match lookups use the regional host (e.g. americas.api.riotgames.com).
const REGIONAL_ROUTING: Record<string, string> = {
  // Americas
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  oc1: "americas",
  // Europe
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  // Asia
  kr: "asia", jp1: "asia",
  // SEA
  ph2: "sea", sg2: "sea", th2: "sea", tw2: "sea", vn2: "sea",
};

function platformHost(region: string): string {
  return `${region}.api.riotgames.com`;
}

function regionalHost(region: string): string {
  const regional = REGIONAL_ROUTING[region];
  if (!regional) throw new Error(`Unknown region: ${region}`);
  return `${regional}.api.riotgames.com`;
}

export interface SummonerInfo {
  puuid: string;
  name: string;
  summonerLevel: number;
  profileIconId: number;
}

export interface MatchSummary {
  matchId: string;
  champion: string;
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
  position: string;
  gameMode: string;
  gameDuration: number;
  gameCreation: number;
  kda: number;
}

// ── Get summoner by name ──────────────────────────────────────────
export async function getSummoner(
  apiKey: string,
  region: string,
  name: string,
): Promise<SummonerInfo> {
  const res = await fetch(
    `https://${platformHost(region)}/lol/summoner/v4/summoners/by-name/${encodeURIComponent(name)}`,
    { headers: { "X-Riot-Token": apiKey } },
  );
  if (res.status === 404) throw new Error(`Summoner "${name}" not found in region ${region}.`);
  if (!res.ok) throw new Error(`Riot API error (summoner): ${res.status} ${await res.text()}`);
  const data = await res.json() as any;
  return {
    puuid: data.puuid,
    name: data.name,
    summonerLevel: data.summonerLevel,
    profileIconId: data.profileIconId,
  };
}

// ── Get recent match IDs ──────────────────────────────────────────
export async function getMatchIds(
  apiKey: string,
  region: string,
  puuid: string,
  count = 20,
): Promise<string[]> {
  const res = await fetch(
    `https://${regionalHost(region)}/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}`,
    { headers: { "X-Riot-Token": apiKey } },
  );
  if (!res.ok) throw new Error(`Riot API error (match list): ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Get full match data ───────────────────────────────────────────
export async function getMatch(
  apiKey: string,
  region: string,
  matchId: string,
): Promise<any> {
  const res = await fetch(
    `https://${regionalHost(region)}/lol/match/v5/matches/${matchId}`,
    { headers: { "X-Riot-Token": apiKey } },
  );
  if (!res.ok) throw new Error(`Riot API error (match): ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Get match timeline ────────────────────────────────────────────
export async function getMatchTimeline(
  apiKey: string,
  region: string,
  matchId: string,
): Promise<any> {
  const res = await fetch(
    `https://${regionalHost(region)}/lol/match/v5/matches/${matchId}/timeline`,
    { headers: { "X-Riot-Token": apiKey } },
  );
  if (!res.ok) throw new Error(`Riot API error (timeline): ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Extract a compact summary of a match for the player ──────────
// The full match + timeline JSON can be several MB. We extract only
// the fields the LLM needs to produce a coaching analysis.
export function extractPlayerData(
  match: any,
  timeline: any,
  puuid: string,
): string {
  const info = match.info;
  const participants = info.participants;
  const player = participants.find((p: any) => p.puuid === puuid);

  if (!player) throw new Error("Player not found in this match.");

  const durationMin = Math.round(info.gameDuration / 60);

  // Build a compact summary of all participants
  const allPlayers = participants.map((p: any) => ({
    name: p.summonerName,
    champion: p.championName,
    team: p.teamId,
    role: p.individualPosition,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    gold: p.goldEarned,
    cs: p.totalMinionsKilled + p.neutralMinionsKilled,
    damage: p.totalDamageDealtToChampions,
    vision: p.visionScore,
    items: [
      p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6,
    ].filter((id: number) => id > 0),
  }));

  // Extract key timeline events involving the player
  const playerEvents: any[] = [];
  const teamEvents: any[] = [];

  for (const frame of timeline.info.frames) {
    for (const event of frame.events) {
      const ts = event.timestamp; // ms

      if (event.type === "CHAMPION_KILL") {
        const killer = participants.find((p: any) => p.participantId === event.killerId);
        const victim = participants.find((p: any) => p.participantId === event.victimId);
        const assistNames = (event.assistingParticipantIds || [])
          .map((id: number) => participants.find((p: any) => p.participantId === id)?.summonerName)
          .filter(Boolean);

        const entry = {
          time: formatTime(ts),
          killer: killer?.summonerName ?? "Unknown",
          killerChamp: killer?.championName,
          victim: victim?.summonerName ?? "Unknown",
          victimChamp: victim?.championName,
          position: event.position,
          assists: assistNames,
        };

        if (victim?.puuid === puuid) {
          playerEvents.push({ ...entry, type: "DEATH" });
        } else if (killer?.puuid === puuid) {
          playerEvents.push({ ...entry, type: "KILL" });
        }
      }

      if (event.type === "ELITE_MONSTER_KILL") {
        const killer = participants.find((p: any) => p.participantId === event.killerId);
        const entry = {
          time: formatTime(ts),
          monster: event.monsterType, // DRAGON or BARON
          subtype: event.monsterSubType,
          killer: killer?.summonerName,
          killerTeam: event.killerTeamId,
        };
        teamEvents.push(entry);
        if (killer?.puuid === puuid) {
          playerEvents.push({ ...entry, type: "OBJECTIVE" });
        }
      }

      if (event.type === "BUILDING_KILL") {
        const killer = participants.find((p: any) => p.participantId === event.killerId);
        teamEvents.push({
          time: formatTime(ts),
          building: event.buildingType,
          lane: event.laneType,
          team: event.teamId,
          killer: killer?.summonerName,
        });
      }
    }
  }

  // Build the text for the LLM
  const playerStats = {
    summonerName: player.summonerName,
    champion: player.championName,
    role: player.individualPosition,
    teamPosition: player.teamPosition,
    win: player.win,
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    kda: ((player.kills + player.assists) / Math.max(player.deaths, 1)).toFixed(2),
    goldEarned: player.goldEarned,
    goldSpent: player.goldSpent,
    totalCS: player.totalMinionsKilled + player.neutralMinionsKilled,
    csPerMin: ((player.totalMinionsKilled + player.neutralMinionsKilled) / durationMin).toFixed(1),
    visionScore: player.visionScore,
    wardsPlaced: player.wardsPlaced,
    wardsKilled: player.wardsKilled,
    visionWardsBought: player.visionWardsBought,
    damageToChampions: player.totalDamageDealtToChampions,
    damageTaken: player.totalDamageTaken,
    damageMitigated: player.damageSelfMitigated,
    heal: player.totalHeal,
    items: [
      player.item0, player.item1, player.item2,
      player.item3, player.item4, player.item5, player.item6,
    ].filter((id: number) => id > 0),
    primaryRune: player.perks?.styles?.[0]?.selections?.[0]?.perk,
    secondaryRune: player.perks?.styles?.[1]?.style,
    doubleKills: player.doubleKills,
    tripleKills: player.tripleKills,
    quadraKills: player.quadraKills,
    pentaKills: player.pentaKills,
    firstBloodKill: player.firstBloodKill,
    firstBloodAssist: player.firstBloodAssist,
    firstTowerKill: player.firstTowerKill,
    timeCCingOthers: player.timeCCingOthers,
    totalTimeCCDealt: player.totalTimeCCDealt,
    spell1Casts: player.spell1Casts,
    spell2Casts: player.spell2Casts,
    spell3Casts: player.spell3Casts,
    spell4Casts: player.spell4Casts,
  };

  const summary = {
    gameInfo: {
      matchId: match.metadata.matchId,
      gameMode: info.gameMode,
      gameType: info.gameType,
      gameDuration: `${durationMin} min`,
      gameCreation: new Date(info.gameCreation).toISOString(),
      patch: info.gameVersion,
    },
    playerStats,
    allParticipants: allPlayers,
    playerEvents,
    teamEvents,
  };

  return JSON.stringify(summary, null, 2);
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

// ── Convert a full match into a lightweight summary for the match list ─
export function matchToSummary(match: any, puuid: string): MatchSummary {
  const player = match.info.participants.find((p: any) => p.puuid === puuid);
  if (!player) throw new Error("Player not in match");
  return {
    matchId: match.metadata.matchId,
    champion: player.championName,
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    win: player.win,
    position: player.individualPosition,
    gameMode: match.info.gameMode,
    gameDuration: match.info.gameDuration,
    gameCreation: match.info.gameCreation,
    kda: (player.kills + player.assists) / Math.max(player.deaths, 1),
  };
}
