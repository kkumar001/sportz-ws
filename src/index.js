import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { matchRouter } from './routes/matches.js';
import { commentaryRouter } from './routes/commentary.js';
import { attachWebSocketServer } from './ws/server.js';
import { securityMiddleware } from './arcjet.js';
import { pool } from './db/db.js';
import { seedDemoMatches } from './seed/demo-matches.js';

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);

function parseAllowedOrigins(value) {
	if (!value || !String(value).trim()) {
		return null;
	}

	return String(value)
		.split(',')
		.map((origin) => origin.trim().replace(/\/+$/, ''))
		.filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins(process.env.FRONTEND_ORIGIN);

app.use(cors({
	origin(origin, callback) {
		if (!origin || !allowedOrigins) {
			return callback(null, true);
		}

		const normalized = origin.replace(/\/+$/, '');
		if (allowedOrigins.includes(normalized)) {
			return callback(null, true);
		}

		return callback(null, false);
	},
}));
app.use(express.json());

app.get('/', (req, res) => {
	res.send('Hello from Sportz API');
});

app.get('/health', async (req, res) => {
	try {
		await pool.query('SELECT 1');
		return res.status(200).json({ status: 'ok' });
	} catch (error) {
		return res.status(503).json({ status: 'error', error: 'Database unavailable' });
	}
});

app.use(securityMiddleware());

app.use('/matches', matchRouter);
app.use('/matches/:id/commentary', commentaryRouter);

const {
	broadcastMatchCreated,
	broadcastMatchUpdated,
	broadcastScoreUpdated,
	broadcastCommentary,
	broadcastSimulator,
} = attachWebSocketServer(server);

app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastMatchUpdated = broadcastMatchUpdated;
app.locals.broadcastScoreUpdated = broadcastScoreUpdated;
app.locals.broadcastCommentary = broadcastCommentary;
app.locals.broadcastSimulator = broadcastSimulator;

function getPublicBaseUrl() {
	const isProd = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
	if (isProd && process.env.RENDER_EXTERNAL_URL) {
		return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
	}

	const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
	return `http://${displayHost}:${port}`;
}

server.listen(port, host, async () => {
	const baseUrl = getPublicBaseUrl();
	const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;
	console.log(`Server is listening at ${baseUrl} (bind ${host}:${port})`);
	console.log(`WebSocket Server is listening at ${wsUrl}`);
	console.log(`CORS allowed origins: ${allowedOrigins ? allowedOrigins.join(', ') : '(any)'}`);

	try {
		const seeded = await seedDemoMatches();
		const ids = seeded.matches.map((match) => `${match.sport}:${match.id}`).join(', ');
		console.log(`Demo matches ready (${ids})`);
	} catch (error) {
		console.error('Failed to seed demo matches on startup:', error);
	}
});
