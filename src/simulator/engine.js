import { eq } from 'drizzle-orm';
import { db } from '../db/db.js';
import { commentary, matches } from '../db/schema.js';
import { MATCH_STATUS } from '../validation/matches.js';
import { toPublicMatch } from '../utils/match-score.js';
import { getSimulatorScript } from './scripts.js';

const jobs = new Map();

function simulationError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(simulationError('ABORTED', 'Simulation stopped'));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(simulationError('ABORTED', 'Simulation stopped'));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function snapshot(job) {
  const elapsed = Date.now() - job.startedAt;
  return {
    running: true,
    matchId: job.matchId,
    sport: job.sport,
    homeTeam: job.homeTeam,
    awayTeam: job.awayTeam,
    startedAt: new Date(job.startedAt).toISOString(),
    currentStep: job.currentStep,
    totalSteps: job.totalSteps,
    estimatedDurationMs: job.estimatedDurationMs,
    estimatedRemainingMs: Math.max(0, job.estimatedDurationMs - elapsed),
  };
}

export function isSimulationRunning(matchId) {
  return jobs.has(matchId);
}

export function getSimulationStatus(matchId) {
  const job = jobs.get(matchId);
  if (!job) {
    return { running: false, matchId };
  }
  return snapshot(job);
}

async function loadMatch(matchId) {
  const [row] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  return row ?? null;
}

async function persistMatch(matchId, values) {
  const [updated] = await db.update(matches).set(values).where(eq(matches.id, matchId)).returning();
  return updated ? toPublicMatch(updated) : null;
}

async function insertCommentary(matchId, payload) {
  const [event] = await db
    .insert(commentary)
    .values({ matchId, ...payload })
    .returning();
  return event;
}

async function prepareMatch(match, estimatedDurationMs) {
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + estimatedDurationMs + 15_000);

  await db.delete(commentary).where(eq(commentary.matchId, match.id));

  return persistMatch(match.id, {
    startTime,
    endTime,
    homeScore: 0,
    awayScore: 0,
    homeWickets: 0,
    awayWickets: 0,
    status: MATCH_STATUS.LIVE,
  });
}

async function finishMatch(matchId, lastScores) {
  const now = new Date();
  return persistMatch(matchId, {
    ...(lastScores ?? {}),
    endTime: now,
    status: MATCH_STATUS.FINISHED,
  });
}

async function applyEvent(matchId, event, broadcasts) {
  let match = await loadMatch(matchId);
  if (!match) {
    throw simulationError('NOT_FOUND', 'Match not found!');
  }

  const scoreChanged =
    typeof event.homeScore === 'number' && typeof event.awayScore === 'number';

  if (scoreChanged) {
    const values = {
      homeScore: event.homeScore,
      awayScore: event.awayScore,
      status: MATCH_STATUS.LIVE,
    };
    if (typeof event.homeWickets === 'number') {
      values.homeWickets = event.homeWickets;
    }
    if (typeof event.awayWickets === 'number') {
      values.awayWickets = event.awayWickets;
    }
    match = await persistMatch(matchId, values);
    broadcasts.scoreUpdated?.(match);
  }

  if (event.commentary) {
    const row = await insertCommentary(matchId, event.commentary);
    broadcasts.commentary?.(matchId, row);
  }

  return match;
}

async function runJob(job, script, broadcasts) {
  const { signal } = job.controller;
  let lastScores = { homeScore: 0, awayScore: 0, homeWickets: 0, awayWickets: 0 };

  try {
    const prepared = await prepareMatch(
      { id: job.matchId, ...job },
      script.estimatedDurationMs,
    );
    if (!prepared) {
      throw simulationError('NOT_FOUND', 'Match not found!');
    }

    broadcasts.matchUpdated?.(prepared);
    broadcasts.simulator?.('simulator_started', snapshot(job));

    for (const event of script.events) {
      await delay(event.delayMs, signal);
      job.currentStep += 1;
      const match = await applyEvent(job.matchId, event, broadcasts);
      if (typeof event.homeScore === 'number' && typeof event.awayScore === 'number') {
        lastScores = {
          homeScore: event.homeScore,
          awayScore: event.awayScore,
          ...(typeof event.homeWickets === 'number' ? { homeWickets: event.homeWickets } : {}),
          ...(typeof event.awayWickets === 'number' ? { awayWickets: event.awayWickets } : {}),
        };
      }
      if (match) {
        job.homeTeam = match.homeTeam;
        job.awayTeam = match.awayTeam;
      }
    }

    const finished = await finishMatch(job.matchId, lastScores);
    if (finished) {
      broadcasts.matchUpdated?.(finished);
      broadcasts.simulator?.('simulator_finished', {
        matchId: job.matchId,
        match: finished,
      });
    }
  } catch (error) {
    if (error.code === 'ABORTED') {
      const current = await loadMatch(job.matchId);
      broadcasts.simulator?.('simulator_stopped', {
        matchId: job.matchId,
        match: current,
      });
      return;
    }

    console.error(`Simulator failed for match ${job.matchId}:`, error);
    broadcasts.simulator?.('simulator_error', {
      matchId: job.matchId,
      error: error.message || 'Simulation failed',
    });
  } finally {
    jobs.delete(job.matchId);
  }
}

export async function startSimulation(matchId, broadcasts) {
  if (jobs.has(matchId)) {
    throw simulationError('ALREADY_RUNNING', 'Simulation already running for this match', {
      status: snapshot(jobs.get(matchId)),
    });
  }

  const job = {
    matchId,
    sport: '',
    homeTeam: '',
    awayTeam: '',
    controller: new AbortController(),
    startedAt: Date.now(),
    currentStep: 0,
    totalSteps: 0,
    estimatedDurationMs: 0,
  };
  jobs.set(matchId, job);

  try {
    const match = await loadMatch(matchId);
    if (!match) {
      throw simulationError('NOT_FOUND', 'Match not found!');
    }

    const script = getSimulatorScript(match);
    if (!script) {
      throw simulationError(
        'NO_SCRIPT',
        `No simulator script for sport "${match.sport}". Supported: cricket, football, hockey.`,
      );
    }

    job.sport = script.sport;
    job.homeTeam = match.homeTeam;
    job.awayTeam = match.awayTeam;
    job.totalSteps = script.events.length;
    job.estimatedDurationMs = script.estimatedDurationMs;
    job.promise = runJob(job, script, broadcasts);
    return snapshot(job);
  } catch (error) {
    jobs.delete(matchId);
    throw error;
  }
}

export async function stopSimulation(matchId) {
  const job = jobs.get(matchId);
  if (!job) {
    throw simulationError('NOT_RUNNING', 'No simulation is running for this match');
  }

  job.controller.abort();
  try {
    await job.promise;
  } catch {
    // runJob swallows abort; ignore
  }

  return { running: false, matchId, stopped: true };
}
