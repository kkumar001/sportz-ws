import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import {
  createMatchSchema,
  listMatchesQuerySchema,
  matchIdParamSchema,
  updateScoreSchema,
} from '../validation/matches.js';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { getMatchStatus } from '../utils/match-status.js';
import { persistMatchStatuses } from '../utils/persist-match-status.js';
import { toPublicMatch, toPublicMatches } from '../utils/match-score.js';
import { seedDemoMatches } from '../seed/demo-matches.js';
import { seedMatchesSchema } from '../validation/simulate.js';
import {
  getSimulationStatus,
  startSimulation,
  stopSimulation,
} from '../simulator/engine.js';

const matchRouter = Router();

const MAX_LIMIT = 100;

function broadcastMatchUpdated(req, match) {
  if (req.app.locals.broadcastMatchUpdated) {
    req.app.locals.broadcastMatchUpdated(match);
  }
}

function simulatorBroadcasts(req) {
  return {
    matchUpdated: req.app.locals.broadcastMatchUpdated,
    scoreUpdated: req.app.locals.broadcastScoreUpdated,
    commentary: req.app.locals.broadcastCommentary,
    simulator: req.app.locals.broadcastSimulator,
  };
}

matchRouter.get('/', async (req, res) => {
  const parsed = listMatchesQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid Query!', details: parsed.error.issues });
  }

  const limit = Math.min(parsed.data.limit ?? 50, MAX_LIMIT);

  try {
    const query = parsed.data.sport
      ? db.select().from(matches).where(eq(matches.sport, parsed.data.sport))
      : db.select().from(matches);

    const data = await query.orderBy(desc(matches.createdAt)).limit(limit);
    const synced = await persistMatchStatuses(data, (match) => broadcastMatchUpdated(req, match));
    const filtered = parsed.data.status
      ? synced.filter((match) => match.status === parsed.data.status)
      : synced;

    return res.status(200).json({ message: 'Matches List', data: toPublicMatches(filtered) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch matches!', details: JSON.stringify(error) });
  }
});

matchRouter.post('/seed', async (req, res) => {
  const parsed = seedMatchesSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid Payload!', details: parsed.error.issues });
  }

  try {
    const result = await seedDemoMatches({ reset: parsed.data.reset });
    for (const match of result.inserted) {
      if (req.app.locals.broadcastMatchCreated) {
        req.app.locals.broadcastMatchCreated(match);
      }
    }
    for (const match of result.reset) {
      broadcastMatchUpdated(req, match);
    }
    return res.status(200).json({
      message: parsed.data.reset ? 'Demo matches reset' : 'Demo matches ready',
      data: toPublicMatches(result.matches),
      meta: {
        inserted: result.inserted.map((match) => match.id),
        reset: result.reset.map((match) => match.id),
        unchanged: result.unchanged.map((match) => match.id),
        resetSkipped: result.resetSkipped.map((item) => ({
          id: item.match.id,
          reason: item.reason,
        })),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to seed demo matches!', details: error.message });
  }
});

matchRouter.get('/:id', async (req, res) => {
  const parsedParams = matchIdParamSchema.safeParse(req.params);

  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Invalid Match ID!', details: parsedParams.error.issues });
  }

  try {
    const [row] = await db.select().from(matches).where(eq(matches.id, parsedParams.data.id)).limit(1);

    if (!row) {
      return res.status(404).json({ error: 'Match not found!' });
    }

    const [synced] = await persistMatchStatuses([row], (match) => broadcastMatchUpdated(req, match));

    return res.status(200).json({ message: 'Match details', data: toPublicMatch(synced) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch match!', details: JSON.stringify(error) });
  }
});

matchRouter.post('/', async (req, res) => {
  const parsed = createMatchSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid Payload!', details: parsed.error.issues });
  }

  const { data: { startTime, endTime, homeScore, awayScore, homeWickets, awayWickets } } = parsed;

  try {
    const [event] = await db.insert(matches).values({
      ...parsed.data,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      homeScore: homeScore ?? 0,
      awayScore: awayScore ?? 0,
      homeWickets: homeWickets ?? 0,
      awayWickets: awayWickets ?? 0,
      status: getMatchStatus(startTime, endTime),
    }).returning();

    const created = toPublicMatch(event);

    if (res.app.locals.broadcastMatchCreated) {
      res.app.locals.broadcastMatchCreated(created);
    }

    return res.status(201).json({ message: 'Match created successfully!', data: created });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to create match!', details: JSON.stringify(error) });
  }
});

matchRouter.patch('/:id/score', async (req, res) => {
  const parsedParams = matchIdParamSchema.safeParse(req.params);

  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Invalid Match ID!', details: parsedParams.error.issues });
  }

  const parsedBody = updateScoreSchema.safeParse(req.body);

  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Invalid Payload!', details: parsedBody.error.issues });
  }

  try {
    const [existing] = await db.select().from(matches).where(eq(matches.id, parsedParams.data.id)).limit(1);

    if (!existing) {
      return res.status(404).json({ error: 'Match not found!' });
    }

    const nextStatus = getMatchStatus(existing.startTime, existing.endTime) ?? existing.status;

    const [updated] = await db
      .update(matches)
      .set({
        homeScore: parsedBody.data.homeScore,
        awayScore: parsedBody.data.awayScore,
        homeWickets: parsedBody.data.homeWickets ?? existing.homeWickets ?? 0,
        awayWickets: parsedBody.data.awayWickets ?? existing.awayWickets ?? 0,
        status: nextStatus,
      })
      .where(eq(matches.id, parsedParams.data.id))
      .returning();

    const scored = toPublicMatch(updated);

    if (res.app.locals.broadcastScoreUpdated) {
      res.app.locals.broadcastScoreUpdated(scored);
    }

    return res.status(200).json({ message: 'Score updated successfully!', data: scored });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update score!', details: JSON.stringify(error) });
  }
});

matchRouter.get('/:id/simulate', async (req, res) => {
  const parsedParams = matchIdParamSchema.safeParse(req.params);

  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Invalid Match ID!', details: parsedParams.error.issues });
  }

  try {
    const [existing] = await db.select().from(matches).where(eq(matches.id, parsedParams.data.id)).limit(1);

    if (!existing) {
      return res.status(404).json({ error: 'Match not found!' });
    }

    return res.status(200).json({
      message: 'Simulation status',
      data: getSimulationStatus(parsedParams.data.id),
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch simulation status!', details: error.message });
  }
});

matchRouter.post('/:id/simulate', async (req, res) => {
  const parsedParams = matchIdParamSchema.safeParse(req.params);

  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Invalid Match ID!', details: parsedParams.error.issues });
  }

  try {
    const data = await startSimulation(parsedParams.data.id, simulatorBroadcasts(req));
    return res.status(202).json({ message: 'Simulation started', data });
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Match not found!' });
    }
    if (error.code === 'ALREADY_RUNNING') {
      return res.status(409).json({
        error: 'Simulation already running for this match',
        data: error.status,
      });
    }
    if (error.code === 'NO_SCRIPT') {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to start simulation!', details: error.message });
  }
});

matchRouter.delete('/:id/simulate', async (req, res) => {
  const parsedParams = matchIdParamSchema.safeParse(req.params);

  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Invalid Match ID!', details: parsedParams.error.issues });
  }

  try {
    const [existing] = await db.select().from(matches).where(eq(matches.id, parsedParams.data.id)).limit(1);

    if (!existing) {
      return res.status(404).json({ error: 'Match not found!' });
    }

    const data = await stopSimulation(parsedParams.data.id);
    return res.status(200).json({ message: 'Simulation stopped', data });
  } catch (error) {
    if (error.code === 'NOT_RUNNING') {
      return res.status(409).json({ error: 'No simulation is running for this match' });
    }
    return res.status(500).json({ error: 'Failed to stop simulation!', details: error.message });
  }
});

export { matchRouter };
