import { and, eq } from 'drizzle-orm';
import { db } from '../db/db.js';
import { commentary, matches } from '../db/schema.js';
import { MATCH_STATUS } from '../validation/matches.js';
import { getMatchStatus } from '../utils/match-status.js';
import { isSimulationRunning } from '../simulator/engine.js';

export const DEMO_FIXTURES = [
  {
    sport: 'cricket',
    homeTeam: 'India',
    awayTeam: 'Australia',
    durationMs: 3 * 60 * 60 * 1000,
  },
  {
    sport: 'football',
    homeTeam: 'Portugal',
    awayTeam: 'Argentina',
    durationMs: 2 * 60 * 60 * 1000,
  },
  {
    sport: 'hockey',
    homeTeam: 'India',
    awayTeam: 'Pakistan',
    durationMs: 2 * 60 * 60 * 1000,
  },
];

function scheduledWindow(durationMs, now = new Date()) {
  const startTime = new Date(now.getTime() + 60 * 60 * 1000);
  const endTime = new Date(startTime.getTime() + durationMs);
  return { startTime, endTime };
}

async function findFixture({ sport, homeTeam, awayTeam }) {
  const [row] = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.sport, sport),
        eq(matches.homeTeam, homeTeam),
        eq(matches.awayTeam, awayTeam),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function seedDemoMatches({ reset = false } = {}) {
  const inserted = [];
  const resetMatches = [];
  const skipped = [];
  const resetSkipped = [];

  for (const fixture of DEMO_FIXTURES) {
    const existing = await findFixture(fixture);

    if (!existing) {
      const { startTime, endTime } = scheduledWindow(fixture.durationMs);
      const [row] = await db
        .insert(matches)
        .values({
          sport: fixture.sport,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          startTime,
          endTime,
          homeScore: 0,
          awayScore: 0,
          homeWickets: 0,
          awayWickets: 0,
          status: getMatchStatus(startTime, endTime) ?? MATCH_STATUS.SCHEDULED,
        })
        .returning();
      inserted.push(row);
      continue;
    }

    if (!reset) {
      skipped.push(existing);
      continue;
    }

    if (isSimulationRunning(existing.id)) {
      resetSkipped.push({
        match: existing,
        reason: 'Simulation already running for this match',
      });
      continue;
    }

    const { startTime, endTime } = scheduledWindow(fixture.durationMs);
    await db.delete(commentary).where(eq(commentary.matchId, existing.id));
    const [updated] = await db
      .update(matches)
      .set({
        startTime,
        endTime,
        homeScore: 0,
        awayScore: 0,
        homeWickets: 0,
        awayWickets: 0,
        status: getMatchStatus(startTime, endTime) ?? MATCH_STATUS.SCHEDULED,
      })
      .where(eq(matches.id, existing.id))
      .returning();

    resetMatches.push(updated);
  }

  return {
    matches: [...inserted, ...resetMatches, ...skipped, ...resetSkipped.map((item) => item.match)],
    inserted,
    reset: resetMatches,
    created: [...inserted, ...resetMatches],
    unchanged: skipped,
    resetSkipped,
  };
}
