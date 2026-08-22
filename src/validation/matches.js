import { z } from 'zod';

export const MATCH_STATUS = {
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  FINISHED: 'finished',
};

export const listMatchesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  sport: z.string().trim().min(1).optional(),
  status: z.enum([MATCH_STATUS.SCHEDULED, MATCH_STATUS.LIVE, MATCH_STATUS.FINISHED]).optional(),
});

export const matchIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const isoDateStringSchema = z.iso.datetime({ offset: true });

export const createMatchSchema = z
  .object({
    sport: z.string().trim().min(1),
    homeTeam: z.string().trim().min(1),
    awayTeam: z.string().trim().min(1),
    startTime: isoDateStringSchema,
    endTime: isoDateStringSchema,
    homeScore: z.coerce.number().int().nonnegative().optional(),
    awayScore: z.coerce.number().int().nonnegative().optional(),
    homeWickets: z.coerce.number().int().min(0).max(10).optional(),
    awayWickets: z.coerce.number().int().min(0).max(10).optional(),
  })
  .superRefine(({ startTime, endTime }, context) => {
    if (new Date(endTime) <= new Date(startTime)) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'endTime must be after startTime',
      });
    }
  });

export const updateScoreSchema = z.object({
  homeScore: z.coerce.number().int().nonnegative(),
  awayScore: z.coerce.number().int().nonnegative(),
  homeWickets: z.coerce.number().int().min(0).max(10).optional(),
  awayWickets: z.coerce.number().int().min(0).max(10).optional(),
});
