import { WebSocket, WebSocketServer } from 'ws';
import { wsArcjet } from '../arcjet.js';

function sendJSON(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(payload));
}

function broadcast(wss, payload) {
    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;

        client.send(JSON.stringify(payload));
    }
}

export function attachWebSocketServer(server) {
    const wss = new WebSocketServer({
        server,
        path: '/ws',
        maxPayload: 1024 * 1024
    });

    wss.on('connection', async (socket, req) => {
        if (wsArcjet) {
            try {
                const decision = await wsArcjet.protect(req);

                if (decision.isDenied()) {
                    const code = decision.reason.isRateLimit() ? 1013 : 1008;
                    const message = decision.reason.isRateLimit() ? 'Rate Limit Exceeded!' : 'Access denied!';

                    socket.close(code, message);
                    return;
                }
            } catch (error) {
                console.error('Arcjet WebSocket error:', error);
                socket.close(1011, 'Internal Server Error!');
                return;
            }
        }

        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });

        sendJSON(socket, { type: 'welcome' });

        socket.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    });

    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();

            ws.isAlive = false;
            ws.ping();
        })
    }, 30000);

    wss.on('close', () => {
        clearInterval(interval);
    });

    function broadcastMatchCreated(match) {
        broadcast(wss, { type: 'match_created', data: match });
    }

    return { broadcastMatchCreated };
}