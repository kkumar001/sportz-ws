import express from 'express';
import { matchRouter } from './routes/matches.js';
import http from 'http';
import { attachWebSocketServer } from './ws/server.js';

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);

app.use(express.json());

app.get('/', (req, res) => {
	res.send('Hello from Sportz API');
});

app.use('/matches', matchRouter);

const { broadcastMatchCreated } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;

server.listen(port, host, () => {
	const baseUrl = host === '0.0.0.0' ? `http://localhost:${port}` : `http://${host}:${port}`;
	console.log(`Server is listening at ${baseUrl}`);
	console.log(`WebSocket Server is listening at ${baseUrl.replace('http', 'ws')}/ws`);
});