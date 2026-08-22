import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/db.js';
import { commentary, matches } from '../db/schema.js';
import { createCommentarySchema, listCommentaryQuerySchema } from '../validation/commentary.js';
import { matchIdParamSchema } from '../validation/matches.js';

const commentaryRouter = Router({ mergeParams: true });
const MAX_LIMIT = 100;

async function findMatch(id) {
    const [row] = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
    return row ?? null;
}

commentaryRouter.get('/', async (req, res) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);

    if (!parsedParams.success) {
        return res.status(400).json({ error: 'Invalid Match ID!', details: parsedParams.error.issues });
    }

    const parsedQuery = listCommentaryQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
        return res.status(400).json({ error: 'Invalid Query!', details: parsedQuery.error.issues });
    }

    const limit = Math.min(parsedQuery.data.limit ?? MAX_LIMIT, MAX_LIMIT);

    try {
        const match = await findMatch(parsedParams.data.id);

        if (!match) {
            return res.status(404).json({ error: 'Match not found!' });
        }

        const data = await db
            .select()
            .from(commentary)
            .where(eq(commentary.matchId, parsedParams.data.id))
            .orderBy(desc(commentary.createdAt))
            .limit(limit);

        return res.status(200).json({ message: 'Commentary List', data });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch commentary!', details: JSON.stringify(error) });
    }
});

commentaryRouter.post('/', async (req, res) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);

    if (!parsedParams.success) {
        return res.status(400).json({ error: 'Invalid Match ID!', details: parsedParams.error.issues });
    }

    const parsedBody = createCommentarySchema.safeParse(req.body);

    if (!parsedBody.success) {
        return res.status(400).json({ error: 'Invalid Payload!', details: parsedBody.error.issues });
    }

    try {
        const match = await findMatch(parsedParams.data.id);

        if (!match) {
            return res.status(404).json({ error: 'Match not found!' });
        }

        const [event] = await db.insert(commentary).values({
            matchId: parsedParams.data.id,
            ...parsedBody.data
        }).returning();

        if (res.app.locals.broadcastCommentary) {
            res.app.locals.broadcastCommentary(event.matchId, event);
        }

        return res.status(201).json({ message: 'Commentary created successfully!', data: event });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to create commentary!', details: JSON.stringify(error) });
    }
});

export { commentaryRouter };
