import { WebSocket, WebSocketServer } from 'ws';
import { wsArcjet } from '../arcjet.js';

const matchSubscribers = new Map();

function subscribeToMatch(socket, matchId) {
    if (!matchSubscribers.has(matchId)) {
        matchSubscribers.set(matchId, new Set());
    }
    matchSubscribers.get(matchId).add(socket);
}

function unsubscribeFromMatch(socket, matchId) {
    const subscribers = matchSubscribers.get(matchId);
    if (!subscribers) return;

    subscribers.delete(socket);

    if (subscribers.size === 0) {
        matchSubscribers.delete(matchId);
    }
}

function cleanupSubscribers(socket) {
    for (const matchId of socket.subscriptions) {
        unsubscribeFromMatch(socket, matchId);
    }
}

function sendJSON(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(payload));
}

function broadcastToMatch(matchId, payload) {
    const subscribers = matchSubscribers.get(matchId);
    if (!subscribers || subscribers.size === 0) return;

    for (const client of subscribers) {
        if (client.readyState !== WebSocket.OPEN) continue;

        client.send(JSON.stringify(payload));
    }
}

function broadcastToAll(wss, payload) {
    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;

        client.send(JSON.stringify(payload));
    }
}

function handleMessage(socket, data) {
    let message;
    try {
        message = JSON.parse(data.toString());
    } catch (e) {
        sendJSON(socket, { type: 'error', error: 'Invalid JSON format' });
    }

    if (message?.type === 'subscribe' && Number.isInteger(message.matchId)) {
        subscribeToMatch(socket, message.matchId);
        socket.subscriptions.add(message.matchId);
        sendJSON(socket, { type: 'subscribed', matchId: message.matchId });
        return;
    }

    if (message.type === 'unsubscribe' && message.matchId) {
        unsubscribeFromMatch(socket, message.matchId);
        socket.subscriptions.delete(message.matchId);
        sendJSON(socket, { type: 'unsubscribed', matchId: message.matchId });
        return;
    }
}

export function attachWebSocketServer(server) {
    const wss = new WebSocketServer({
        noServer: true,
        path: '/ws',
        maxPayload: 1024 * 1024
    });

    server.on('upgrade', async (req, socket, head) => {
        const { pathname } = new URL(req.url, `http://${req.headers.host}`);

        if (pathname !== '/ws') {
            return;
        }

        if (wsArcjet) {
            try {
                const decision = await wsArcjet.protect(req);

                if (decision.isDenied()) {
                    if (decision.reason.isRateLimit()) {
                        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
                    } else {
                        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                    }
                    socket.destroy();
                    return;
                }
            } catch (e) {
                console.error('WS upgrade protection error', e);
                socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                socket.destroy();
                return;
            }
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', async (socket, req) => {
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });

        socket.subscriptions = new Set();

        sendJSON(socket, { type: 'welcome' });

        socket.on('message', (data) => {
            handleMessage(socket, data);
        });

        socket.on('error', (error) => {
            console.error('WebSocket error:', error);
            socket.terminate();
        });

        socket.on('close', () => {
            cleanupSubscribers(socket);
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
        broadcastToAll(wss, { type: 'match_created', data: match });
    }

    function broadcastCommentary(matchId, comment) {
        broadcastToMatch(matchId, { type: 'commentary_created', data: comment });
    }

    return { broadcastMatchCreated, broadcastCommentary };
}