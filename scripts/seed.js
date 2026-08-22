import { seedDemoMatches } from '../src/seed/demo-matches.js';
import { pool } from '../src/db/db.js';

try {
  const result = await seedDemoMatches({ reset: process.argv.includes('--reset') });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Failed to seed demo matches:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
