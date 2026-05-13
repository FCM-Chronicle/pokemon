const express = require('express');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = 3000;

// 데이터 파일 초기화
const FILES = {
  users: './users.json',
  fight: './fight.json'
};

Object.values(FILES).forEach(f => {
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, JSON.stringify(f === FILES.users ? {} : { ranking: [], battleLog: [] }));
  }
});

app.use(express.static('public'));

const server = app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
const wss = new WebSocketServer({ server });

let clients = new Map(); // id -> { ws, playerName, team }

wss.on('connection', (ws) => {
  let myId = null;

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'register_login':
        handleAuth(ws, data);
        break;

      case 'join':
        myId = data.playerId;
        clients.set(myId, { ws, name: data.playerName, team: data.team });
        broadcastPlayerList();
        sendRanking(ws);
        break;

      case 'challenge':
        relay(data.targetId, { type: 'challenged', challengerId: myId, challengerName: clients.get(myId).name, challengerTeam: data.team });
        break;

      case 'accept':
        relay(data.challengerId, { type: 'accepted', opponentId: myId, opponentTeam: data.team });
        break;

      case 'decline':
        relay(data.challengerId, { type: 'declined', opponentId: myId });
        break;

      case 'turn_action':
        relay(data.opponentId, { type: 'turn_action', action: data.action });
        break;

      case 'battle_result':
        updateRanking(data);
        break;
    }
  });

  ws.on('close', () => {
    if (myId) {
      clients.delete(myId);
      broadcastPlayerList();
    }
  });
});

function handleAuth(ws, { username, password }) {
  const users = JSON.parse(fs.readFileSync(FILES.users));
  if (users[username]) {
    if (users[username].password === password) {
      ws.send(JSON.stringify({ type: 'auth_success', playerId: users[username].id, playerName: username }));
    } else {
      ws.send(JSON.stringify({ type: 'auth_fail', message: '비밀번호가 틀렸습니다.' }));
    }
  } else {
    const newId = uuidv4();
    users[username] = { id: newId, password };
    fs.writeFileSync(FILES.users, JSON.stringify(users));
    ws.send(JSON.stringify({ type: 'auth_success', playerId: newId, playerName: username }));
  }
}

function broadcastPlayerList() {
  const players = Array.from(clients.entries()).map(([id, p]) => ({ id, name: p.name, team: p.team }));
  const msg = JSON.stringify({ type: 'player_list', players });
  clients.forEach(c => c.ws.send(msg));
}

function relay(targetId, data) {
  const target = clients.get(targetId);
  if (target) target.ws.send(JSON.stringify(data));
}

function sendRanking(ws) {
  const fight = JSON.parse(fs.readFileSync(FILES.fight));
  ws.send(JSON.stringify({ type: 'ranking_update', ranking: fight.ranking }));
}

function updateRanking({ winnerId, loserId, winnerName, loserName }) {
  const fight = JSON.parse(fs.readFileSync(FILES.fight));
  const updateEntry = (id, name, result) => {
    let p = fight.ranking.find(r => r.playerId === id);
    if (!p) {
      p = { playerId: id, playerName: name, win: 0, lose: 0, draw: 0, totalBattles: 0, winRate: 0, lastUpdated: "" };
      fight.ranking.push(p);
    }
    if (result === 'win') p.win++; else p.lose++;
    p.totalBattles++;
    p.winRate = parseFloat((p.win / p.totalBattles * 100).toFixed(2));
    p.lastUpdated = new Date().toISOString();
  };

  updateEntry(winnerId, winnerName, 'win');
  updateEntry(loserId, loserName, 'lose');

  fight.battleLog.unshift({ battleId: uuidv4(), winner: winnerName, loser: loserName, timestamp: new Date().toISOString() });
  if (fight.battleLog.length > 50) fight.battleLog.pop();

  fight.ranking.sort((a, b) => b.winRate - a.winRate || b.win - a.win);
  fs.writeFileSync(FILES.fight, JSON.stringify(fight));

  const msg = JSON.stringify({ type: 'ranking_update', ranking: fight.ranking });
  clients.forEach(c => c.ws.send(msg));
}
