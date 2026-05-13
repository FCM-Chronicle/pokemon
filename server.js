const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const FIGHT_FILE = path.join(__dirname, 'fight.json');
const PORT = 3000;

// fight.json 초기화
if (!fs.existsSync(FIGHT_FILE)) {
    fs.writeFileSync(FIGHT_FILE, JSON.stringify({ ranking: [], battleLog: [] }));
}

app.use(express.static(path.join(__dirname)));

let clients = new Map(); // id -> { ws, name, team }

wss.on('connection', (ws) => {
    if (clients.size >= 10) {
        ws.send(JSON.stringify({ type: "full", message: "서버가 가득 찼습니다 (최대 10명)" }));
        ws.close();
        return;
    }

    let playerId = null;

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch (data.type) {
            case "join":
                playerId = data.playerId;
                clients.set(playerId, { ws, name: data.playerName, team: data.team, status: 'online' });
                broadcastPlayerList();
                sendRanking(ws);
                break;

            case "challenge":
                relay(data.targetId, { type: "challenged", challengerId: playerId, challengerName: clients.get(playerId).name, challengerTeam: clients.get(playerId).team });
                break;

            case "accept":
                clients.get(playerId).status = 'battle';
                clients.get(data.challengerId).status = 'battle';
                relay(data.challengerId, { type: "accepted", opponentId: playerId, opponentTeam: clients.get(playerId).team });
                broadcastPlayerList();
                break;

            case "turn_action":
                relay(data.opponentId, { type: "turn_action", action: data.action });
                break;

            case "battle_result":
                updateFightData(data);
                if(clients.has(playerId)) clients.get(playerId).status = 'online';
                broadcastPlayerList();
                break;
                
            case "update_team":
                if(clients.has(playerId)) clients.get(playerId).team = data.team;
                broadcastPlayerList();
                break;
        }
    });

    ws.on('close', () => {
        if (playerId) {
            clients.delete(playerId);
            broadcastPlayerList();
        }
    });
});

function relay(targetId, msg) {
    const target = clients.get(targetId);
    if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify(msg));
    }
}

function broadcastPlayerList() {
    const players = Array.from(clients.entries()).map(([id, p]) => ({ id, name: p.name, team: p.team, status: p.status }));
    const msg = JSON.stringify({ type: "player_list", players });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

function sendRanking(ws) {
    const data = JSON.parse(fs.readFileSync(FIGHT_FILE));
    ws.send(JSON.stringify({ type: "ranking_update", ranking: data.ranking }));
}

function updateFightData({ winnerId, loserId, winnerName, loserName }) {
    const data = JSON.parse(fs.readFileSync(FIGHT_FILE));
    
    const updateEntry = (id, name, isWinner) => {
        let p = data.ranking.find(r => r.playerId === id);
        if (!p) {
            p = { playerId: id, playerName: name, win: 0, lose: 0, totalBattles: 0, winRate: 0, lastUpdated: "" };
            data.ranking.push(p);
        }
        if (isWinner) p.win++; else p.lose++;
        p.totalBattles = p.win + p.lose;
        p.winRate = ((p.win / p.totalBattles) * 100).toFixed(2);
        p.lastUpdated = new Date().toISOString();
    };

    updateEntry(winnerId, winnerName, true);
    updateEntry(loserId, loserName, false);

    data.battleLog.unshift({ battleId: uuidv4(), winner: winnerName, loser: loserName, timestamp: new Date().toISOString() });
    data.battleLog = data.battleLog.slice(0, 50);

    data.ranking.sort((a, b) => b.winRate - a.winRate || b.win - a.win);
    
    fs.writeFileSync(FIGHT_FILE, JSON.stringify(data));
    
    const updateMsg = JSON.stringify({ type: "ranking_update", ranking: data.ranking });
    wss.clients.forEach(c => c.send(updateMsg));
}

server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
