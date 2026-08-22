import { z } from 'zod';

export const seedMatchesSchema = z.object({
  reset: z.boolean().optional().default(false),
});
