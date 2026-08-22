import { eq } from 'drizzle-orm';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { withDerivedStatus } from './match-status.js';

export async function persistMatchStatuses(rows, onUpdated) {
    const now = new Date();
    const result = [];

    for (const row of rows) {
        const { match, changed } = withDerivedStatus(row, now);
        if (!changed) {
            result.push(row);
            continue;
        }

        const [updated] = await db
            .update(matches)
            .set({ status: match.status })
            .where(eq(matches.id, row.id))
            .returning();

        const next = updated ?? match;
        if (onUpdated) {
            onUpdated(next);
        }
        result.push(next);
    }

    return result;
}
