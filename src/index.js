import express from 'express';
import { matchRouter } from './routes/matches.js';
const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());

app.get('/', (req, res) => {
	res.send('Hello from Sportz API');
});

app.use('/matches', matchRouter);

const server = app.listen(port, () => {
	const url = `http://localhost:${port}`;
	console.log(`Server listening at http://localhost:${url}`);
});

export default server;