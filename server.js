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
const POKE_FILE = path.join(__dirname, 'poke.json');
const GITHUB_TOKEN = process.env.POKEGAME; // 발급받은 GitHub API 키 변수 활용
const GITHUB_OWNER = 'FCM-Chronicle';
const GITHUB_REPO = 'pokemon';
const PLAYERS_PATH = 'player.json'; // 파일명 일치시킴
const POKE_PATH = 'poke.json';
const FIGHT_PATH = 'fight.json';

const PORT = process.env.PORT || 3000;

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
                // 서버의 poke.json 캐시 데이터 전송
                readPokeCache().then(cache => ws.send(JSON.stringify({ type: "sync_cache", cache })));
                break;

            case "challenge":
                relay(data.targetId, { type: "challenged", challengerId: playerId, challengerName: clients.get(playerId).name, challengerTeam: clients.get(playerId).team });
                break;

            case "accept":
                clients.get(playerId).status = 'battle';
                clients.get(playerId).opponentId = data.challengerId;
                clients.get(data.challengerId).status = 'battle';
                clients.get(data.challengerId).opponentId = playerId;
                relay(data.challengerId, { type: "accepted", opponentId: playerId, opponentName: clients.get(playerId).name, opponentTeam: clients.get(playerId).team });
                broadcastPlayerList();
                break;

            case "turn_action":
                relay(data.opponentId, { type: "turn_action", action: data.action });
                break;

            case "battle_result":
                updateFightData(data);
                if(clients.has(playerId)) {
                    clients.get(playerId).status = 'online';
                    clients.get(playerId).opponentId = null;
                }
                if(clients.has(data.loserId)) {
                    clients.get(data.loserId).status = 'online';
                    clients.get(data.loserId).opponentId = null;
                }
                broadcastPlayerList();
                break;
                
            case "update_team":
                if(clients.has(playerId)) clients.get(playerId).team = data.team;
                broadcastPlayerList();
                break;

            case "update_cache":
                writePokeCache(data.cache);
                break;
        }
    });

    ws.on('close', () => {
        if (playerId) {
            const client = clients.get(playerId);
            if (client && client.status === 'battle' && client.opponentId) {
                relay(client.opponentId, { type: "opponent_disconnected" });
                const opp = clients.get(client.opponentId);
                if (opp) {
                    opp.status = 'online';
                    opp.opponentId = null;
                }
            }
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

async function readPokeCache() {
    const { data } = await readPokeFromGithub();
    return data || {};
}

async function readFightData() {
    const { data } = await readFightFromGithub();
    return data || { ranking: [], battleLog: [] };
}

async function sendRanking(ws) {
    const data = await readFightData();
    ws.send(JSON.stringify({ type: "ranking_update", ranking: data.ranking }));
}

// GitHub 저장 재시도 래퍼 함수 (충돌 방지)
// readFn: () => Promise<{ data: any, sha: string }>
// modifyAndWriteFn: (currentData: any, sha: string, payloadToApply: any) => Promise<Response>
async function safeWriteToGithub(readFn, modifyAndWriteFn, payloadToApply, retryCount = 3) {
    for (let i = 0; i < retryCount; i++) {
        try {
            const { data: currentData, sha } = await readFn(); // Read current data and SHA
            const res = await modifyAndWriteFn(currentData, sha, payloadToApply); // Modify and write
            if (res.ok) return true;
            
            // 409 외의 에러 로그 출력 (예: 401 권한부족, 404 경로오류)
            const errorText = await res.text();
            console.error(`GitHub API Error (${res.status}):`, errorText);
            
            if (res.status === 409 && i < retryCount - 1) continue; // 충돌 시 재시도
        } catch (e) {
            console.error("GitHub Write Error:", e);
        }
    }
    return false;
}

async function writeFightData(data) {
    await safeWriteToGithub(
        readFightFromGithub,
        async (currentData, sha, newFightData) => {
            return await writeFightToGithub(newFightData, sha);
        },
        data
    );
}

async function writePokeCache(cache) {
    await safeWriteToGithub(
        readPokeFromGithub,
        async (currentData, sha, newCacheData) => {
            // The newCacheData is already the complete cache object to be written
            // currentData는 여기서는 무시됩니다. 전체 캐시를 덮어쓰기 때문입니다.
            return await writePokeToGithub(newCacheData, sha);
        },
        cache
    );
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

async function readPlayersFromGithub() {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PLAYERS_PATH}`, {
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) return { data: { players: [] }, sha: null };
    const json = await res.json();
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    return { data: JSON.parse(content), sha: json.sha };
}

async function writePlayersToGithub(players, sha) {
    const content = Buffer.from(JSON.stringify(players, null, 2), 'utf8').toString('base64');
    const body = { message: 'update players', content };
    if (sha) body.sha = sha;

    return await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PLAYERS_PATH}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function readPokeFromGithub() {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${POKE_PATH}`, {
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) return { data: {}, sha: null };
    const json = await res.json();
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    return { data: JSON.parse(content), sha: json.sha };
}

async function writePokeToGithub(cache, sha) {
    const content = Buffer.from(JSON.stringify(cache, null, 2), 'utf8').toString('base64');
    const body = { message: 'update poke cache', content };
    if (sha) body.sha = sha;

    return await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${POKE_PATH}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function readFightFromGithub() {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FIGHT_PATH}`, {
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) return { data: { ranking: [], battleLog: [] }, sha: null };
    const json = await res.json();
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    return { data: JSON.parse(content), sha: json.sha };
}

async function writeFightToGithub(data, sha) {
    const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
    const body = { message: 'update fight data', content };
    if (sha) body.sha = sha;

    return await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FIGHT_PATH}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

// 플레이어 불러오기
app.get('/api/players/:id', async (req, res) => {
    try {
        const { data } = await readPlayersFromGithub(); // data는 { players: [...] } 형태
        const player = (data?.players || []).find(p => p.name === req.params.id);
        res.json({ player: player || null });
    } catch (e) {
        res.json({ player: null }); // 에러 시 null 반환하여 클라이언트 fallback 유도
    }
});

// 플레이어 저장
app.post('/api/players', express.json(), async (req, res) => {
    try {
        const success = await safeWriteToGithub(
            readPlayersFromGithub, // readFn
            async (currentPlayersData, sha, newPlayer) => { // modifyAndWriteFn
                // 구조 유연하게 처리
                let players = Array.isArray(currentPlayersData) ? currentPlayersData : (currentPlayersData?.players || []);
                const idx = players.findIndex(p => p.name === newPlayer.name);
                if (idx >= 0) players[idx] = newPlayer; else players.push(newPlayer);
                return await writePlayersToGithub({ players }, sha); // 저장 시에는 표준 객체 구조로 저장
            },
            req.body // payloadToApply (the new player object)
        );
        if (!success) throw new Error('Failed to save player data to GitHub after retries.');
        res.json({ ok: true }); // Only send success if write was successful
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PokeAPI Proxy (학교 와이파이 차단 우회용)
app.get('/api/pokeapi/*', async (req, res) => {
    const subPath = req.params[0];
    const targetUrl = `https://pokeapi.co/api/v2/${subPath}`;
    try {
        const response = await fetch(targetUrl);
        if (!response.ok) return res.status(response.status).send('API Error');
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Proxy failed', details: e.message });
    }
});
