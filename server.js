const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fsPromises = require('fs/promises'); // fs.promises 추가

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const FIGHT_FILE = path.join(__dirname, 'fight.json');
const PORT = 3000;

// fight.json 초기화 (비동기 함수를 사용하기 위해 즉시 실행 함수로 감쌈)
(async () => {
    if (!fs.existsSync(FIGHT_FILE)) {
        await fsPromises.writeFile(FIGHT_FILE, JSON.stringify({ ranking: [], battleLog: [] }));
    }
})();
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
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error("Invalid JSON received:", e.message);
            return;
        }

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

async function readFightData() {
    try {
        const data = await fsPromises.readFile(FIGHT_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // 파일이 없을 경우 초기 데이터 반환
            return { ranking: [], battleLog: [] };
        }
        console.error("Error reading fight data:", error);
        return { ranking: [], battleLog: [] }; // 에러 발생 시 기본값 반환
    }
}

async function writeFightData(data) {
    try {
        await fsPromises.writeFile(FIGHT_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error("Error writing fight data:", error);
    }
}

async function sendRanking(ws) {
    const data = await readFightData();
    ws.send(JSON.stringify({ type: "ranking_update", ranking: data.ranking }));
}

async function updateFightData({ winnerId, loserId, winnerName, loserName }) {
    const data = await readFightData();
    
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
    
    await writeFightData(data);
    
    const updateMsg = JSON.stringify({ type: "ranking_update", ranking: data.ranking });
    wss.clients.forEach(c => c.send(updateMsg));
}

server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
