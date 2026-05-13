const game = {
    state: {
        player: null,
        activeTab: 'wild',
        currentBattle: null,
        pokeCache: {},
    },

    db: {
        getPlayerData() {
            return JSON.parse(localStorage.getItem('player_data'));
        },
        savePlayerData(data) {
            localStorage.setItem('player_data', JSON.stringify(data));
            if (game.network.socket && game.network.socket.readyState === WebSocket.OPEN)
                game.network.send({ type: 'update_team', team: data.team });
        },
        savePokemonCacheToServer(data) {
            game.state.pokeCache = data;
            if (game.network.socket && game.network.socket.readyState === WebSocket.OPEN)
                game.network.send({ type: 'update_cache', cache: data });
        }
    },

    async fetchPokemon(id) {
        if (this.state.pokeCache[id]) return this.state.pokeCache[id];
        try {
            const response = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
            const data = await response.json();
            const pokeData = {
                id: data.id,
                name: data.name,
                types: data.types.map(t => t.type.name),
                stats: data.stats.reduce((acc, s) => ({ ...acc, [s.stat.name]: s.base_stat }), {}),
                moves: data.moves.slice(0, 4).map(m => m.move.name),
                spriteUrl: data.sprites.other['official-artwork'].front_default || data.sprites.front_default,
                spriteAnimated: data.sprites.versions?.['generation-v']?.['black-white']?.animated?.front_default || data.sprites.front_default
            };
            this.state.pokeCache[id] = pokeData;
            this.db.savePokemonCacheToServer(this.state.pokeCache);
            return pokeData;
        } catch (e) {
            console.error("API 오류:", e);
            return null;
        }
    },

    battle: {
        async startWildBattle() {
            if (game.state.currentBattle) return;
            const randomId = Math.floor(Math.random() * 151) + 1;
            const wildPoke = await game.fetchPokemon(randomId);
            if (!wildPoke) return;

            const wildPokeCopy = { ...wildPoke };
            wildPokeCopy.currentHp = wildPokeCopy.stats.hp;
            wildPokeCopy.level = Math.floor(Math.random() * 15) + 5;

            const playerPoke = game.state.player?.team[0];
            if (!playerPoke) {
                game.ui.showToast("전투 가능한 포켓몬이 없습니다!");
                return;
            }
            if (!playerPoke.currentHp || playerPoke.currentHp <= 0) {
                playerPoke.currentHp = playerPoke.stats.hp;
            }

            game.state.currentBattle = {
                type: 'wild',
                opponent: wildPokeCopy,
                playerPoke: playerPoke,
                isPlayerTurn: true,
                catchAttempts: 0,
            };

            game.ui.showBattleScene(true);
            game.ui.updateBattleUI();
            game.ui.log(`야생 ${wildPokeCopy.name}이(가) 나타났다!`);
        },

        async useMove(moveName) {
            const b = game.state.currentBattle;
            if (!b || !b.isPlayerTurn) return;
            b.isPlayerTurn = false;

            const damage = this.calculateDamage(b.playerPoke.stats.attack, b.opponent.stats.defense, 40, b.playerPoke.level || 5, 1);
            b.opponent.currentHp = Math.max(0, b.opponent.currentHp - damage);
            game.ui.log(`${b.playerPoke.nickname || b.playerPoke.name}의 ${moveName}! ${damage}의 데미지!`);
            game.ui.updateBattleUI();

            if (b.opponent.currentHp <= 0) {
                game.ui.log(`야생 ${b.opponent.name}이(가) 쓰러졌다!`);
                const expGain = Math.floor(b.opponent.stats['special-attack'] * b.opponent.level / 7);
                game.ui.log(`경험치 ${expGain}을 얻었다!`);
                setTimeout(() => this.endBattle(true), 1500);
                return;
            }

            setTimeout(() => {
                const oppDamage = this.calculateDamage(b.opponent.stats.attack, b.playerPoke.stats.defense, 35, b.opponent.level, 1);
                b.playerPoke.currentHp = Math.max(0, (b.playerPoke.currentHp || b.playerPoke.stats.hp) - oppDamage);
                game.ui.log(`야생 ${b.opponent.name}의 공격! ${oppDamage}의 데미지!`);
                game.ui.updateBattleUI();
                if (b.playerPoke.currentHp <= 0) {
                    game.ui.log(`${b.playerPoke.nickname || b.playerPoke.name}이(가) 쓰러졌다...`);
                    setTimeout(() => this.endBattle(false), 1500);
                } else {
                    b.isPlayerTurn = true;
                    game.ui.renderMoveButtons();
                }
            }, 1000);
        },

        tryCatch() {
            const b = game.state.currentBattle;
            if (!b || !b.isPlayerTurn || b.type !== 'wild') return;
            b.isPlayerTurn = false;
            b.catchAttempts++;

            game.ui.log(`포켓볼을 던졌다!`);

            const hpRatio = b.opponent.currentHp / b.opponent.stats.hp;
            const catchRate = Math.max(0.1, (1 - hpRatio) * 0.6 + 0.15);
            const success = Math.random() < catchRate;

            const ballEl = document.getElementById('catch-ball-anim');
            if (ballEl) {
                ballEl.classList.remove('hidden');
                ballEl.style.animation = 'none';
                void ballEl.offsetWidth;
                ballEl.style.animation = 'pokeball-throw 0.6s ease-out forwards';
            }

            setTimeout(() => {
                if (ballEl) ballEl.classList.add('hidden');
                if (success) {
                    game.ui.log(`${b.opponent.name}을(를) 잡았다!`);
                    const caughtPoke = {
                        ...b.opponent,
                        nickname: b.opponent.name,
                        level: b.opponent.level,
                        currentHp: b.opponent.currentHp,
                    };
                    if (game.state.player.team.length < 6) {
                        game.state.player.team.push(caughtPoke);
                        game.ui.showToast(`${caughtPoke.nickname}이(가) 팀에 합류했다!`);
                    } else {
                        game.state.player.box = game.state.player.box || [];
                        game.state.player.box.push(caughtPoke);
                        game.ui.showToast(`${caughtPoke.nickname}은(는) 박스로 보내졌다.`);
                    }
                    game.db.savePlayerData(game.state.player);
                    setTimeout(() => this.endBattle(true), 1500);
                } else {
                    const wiggle = Math.floor(Math.random() * 3) + 1;
                    game.ui.log(`아쉽다! 볼이 흔들렸다(${wiggle}번)... ${b.opponent.name}이(가) 탈출했다!`);
                    setTimeout(() => {
                        const oppDamage = this.calculateDamage(b.opponent.stats.attack, b.playerPoke.stats.defense, 35, b.opponent.level, 1);
                        b.playerPoke.currentHp = Math.max(0, b.playerPoke.currentHp - oppDamage);
                        game.ui.log(`화가 난 ${b.opponent.name}의 공격! ${oppDamage}의 데미지!`);
                        game.ui.updateBattleUI();
                        if (b.playerPoke.currentHp <= 0) {
                            setTimeout(() => this.endBattle(false), 1500);
                        } else {
                            b.isPlayerTurn = true;
                            game.ui.renderMoveButtons();
                        }
                    }, 800);
                }
            }, 900);
        },

        tryRun() {
            const b = game.state.currentBattle;
            if (!b || !b.isPlayerTurn) return;
            const escapeChance = 0.6;
            if (Math.random() < escapeChance) {
                game.ui.log(`도망쳤다!`);
                setTimeout(() => this.endBattle(null), 1000);
            } else {
                b.isPlayerTurn = false;
                game.ui.log(`도망칠 수 없었다!`);
                setTimeout(() => {
                    const oppDamage = this.calculateDamage(b.opponent.stats.attack, b.playerPoke.stats.defense, 35, b.opponent.level, 1);
                    b.playerPoke.currentHp = Math.max(0, b.playerPoke.currentHp - oppDamage);
                    game.ui.log(`야생 ${b.opponent.name}의 공격! ${oppDamage}의 데미지!`);
                    game.ui.updateBattleUI();
                    if (b.playerPoke.currentHp <= 0) {
                        setTimeout(() => this.endBattle(false), 1500);
                    } else {
                        b.isPlayerTurn = true;
                        game.ui.renderMoveButtons();
                    }
                }, 1000);
            }
        },

        calculateDamage(atk, def, movePower, level, typeMod) {
            const random = 0.85 + Math.random() * 0.15;
            const levelMod = (level || 5) / 50;
            const safeDef = def || 1;
            return Math.max(1, Math.floor((atk / safeDef) * movePower * typeMod * random * (1 + levelMod)));
        },

        endBattle(isWin) {
            const b = game.state.currentBattle;
            game.state.currentBattle = null;
            game.ui.showBattleScene(false);
            if (game.state.player) {
                game.state.player.team.forEach(p => { if (!p.currentHp || p.currentHp <= 0) p.currentHp = p.stats.hp; });
                game.db.savePlayerData(game.state.player);
            }
            game.ui.renderActiveTab();
        }
    },

    network: {
        socket: null,
        connect(player) {
            try {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                this.socket = new WebSocket(`${protocol}//${window.location.host}`);
                this.socket.onopen = () => {
                    this.send({ type: 'join', playerId: player.id, playerName: player.name, team: player.team });
                };
                this.socket.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    if (data.type === 'sync_cache') game.state.pokeCache = data.cache;
                };
            } catch(e) { /* 서버 없음 - 오프라인 모드 */ }
        },
        send(data) {
            if (this.socket && this.socket.readyState === WebSocket.OPEN)
                this.socket.send(JSON.stringify(data));
        }
    },

    ui: {
        changeTab(tab) {
            game.state.activeTab = tab;
            document.querySelectorAll('#tab-bar button').forEach(b => b.classList.remove('active'));
            const idx = ['wild','pvp','team','pokedex','rank'].indexOf(tab);
            if (idx >= 0) document.querySelectorAll('#tab-bar button')[idx]?.classList.add('active');
            this.renderActiveTab();
        },

        renderActiveTab() {
            const vp = document.getElementById('view-port');
            if (!vp) return;
            const tab = game.state.activeTab;
            if (tab === 'wild') this.renderWildTab(vp);
            else if (tab === 'team') this.renderTeamTab(vp);
            else if (tab === 'pokedex') this.renderPokedexTab(vp);
            else if (tab === 'pvp') this.renderPvpTab(vp);
            else if (tab === 'rank') this.renderRankTab(vp);
        },

        renderWildTab(container) {
            const player = game.state.player;
            const team = player?.team || [];
            const leadPoke = team[0];

            container.innerHTML = `
                <div class="tab-content wild-tab">
                    <div class="wild-scene">
                        <div class="grass-bg">
                            <div class="grass-layer l1"></div>
                            <div class="grass-layer l2"></div>
                        </div>
                        <div class="scene-content">
                            <div class="player-poke-display">
                                ${leadPoke ? `
                                    <div class="lobby-poke-card">
                                        <div class="poke-aura type-${leadPoke.types?.[0] || 'normal'}"></div>
                                        <img class="lobby-sprite" src="${leadPoke.spriteUrl}" alt="${leadPoke.name}" />
                                        <div class="poke-info-bar">
                                            <span class="poke-nick">${leadPoke.nickname || leadPoke.name}</span>
                                            <span class="poke-lv">Lv.${leadPoke.level || 1}</span>
                                        </div>
                                        <div class="poke-hp-mini">
                                            <div class="hp-mini-fill" style="width:${Math.max(0, (leadPoke.currentHp / leadPoke.stats.hp) * 100)}%"></div>
                                        </div>
                                        ${team.length > 1 ? `
                                            <div class="team-mini-row">
                                                ${team.slice(1).map(p => `
                                                    <div class="team-mini-ball type-${p.types?.[0] || 'normal'}" title="${p.nickname || p.name}">
                                                        <img src="${p.spriteUrl}" alt="${p.name}" />
                                                    </div>
                                                `).join('')}
                                            </div>
                                        ` : ''}
                                    </div>
                                ` : `<div class="no-poke-msg">포켓몬이 없습니다!</div>`}
                            </div>
                            <div class="wild-actions">
                                <button class="btn-wild-battle pixel" onclick="game.battle.startWildBattle()">
                                    <span>🌿 야생 포켓몬 만나기</span>
                                </button>
                                <p class="wild-hint">151종의 1세대 포켓몬이 기다리고 있다!</p>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        },

        renderTeamTab(container) {
            const team = game.state.player?.team || [];
            container.innerHTML = `
                <div class="tab-content team-tab">
                    <h2 class="tab-title pixel">내 팀</h2>
                    <div class="team-grid">
                        ${team.length === 0 ? `<p class="empty-hint">아직 포켓몬이 없습니다.</p>` : ''}
                        ${team.map((p, i) => `
                            <div class="team-card type-bg-${p.types?.[0] || 'normal'}">
                                <div class="team-card-inner">
                                    <img class="team-sprite" src="${p.spriteUrl}" alt="${p.name}" />
                                    <div class="team-card-info">
                                        <div class="team-poke-name">${p.nickname || p.name}</div>
                                        <div class="team-poke-sub">${p.name} · Lv.${p.level || 1}</div>
                                        <div class="type-badges">
                                            ${p.types.map(t => `<span class="type-badge type-${t}">${t}</span>`).join('')}
                                        </div>
                                        <div class="stat-row">
                                            <span>HP</span>
                                            <div class="stat-bar-track"><div class="stat-bar-fill hp" style="width:${Math.min(100, p.stats.hp / 2)}%"></div></div>
                                        </div>
                                        <div class="stat-row">
                                            <span>공격</span>
                                            <div class="stat-bar-track"><div class="stat-bar-fill atk" style="width:${Math.min(100, p.stats.attack / 2)}%"></div></div>
                                        </div>
                                    </div>
                                </div>
                                ${i === 0 ? '<div class="team-leader-badge">선두</div>' : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        },

        renderPokedexTab(container) {
            const caught = new Set((game.state.player?.team || []).concat(game.state.player?.box || []).map(p => p.id));
            container.innerHTML = `
                <div class="tab-content pokedex-tab">
                    <h2 class="tab-title pixel">포켓도감</h2>
                    <p class="dex-count">발견: ${caught.size} / 151</p>
                    <div class="dex-grid">
                        ${Array.from({length: 151}, (_, i) => i + 1).map(id => {
                            const cached = game.state.pokeCache[id];
                            const isCaught = caught.has(id);
                            return `
                                <div class="dex-cell ${isCaught ? 'caught' : 'unseen'}" title="${cached?.name || '#' + id}">
                                    ${isCaught && cached ? `<img src="${cached.spriteUrl}" alt="${cached.name}" />` : `<span class="dex-num">${String(id).padStart(3,'0')}</span>`}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        },

        renderPvpTab(container) {
            container.innerHTML = `<div class="tab-content"><h2 class="tab-title pixel">대전</h2><p class="empty-hint">PvP 기능 준비 중!</p></div>`;
        },
        renderRankTab(container) {
            container.innerHTML = `<div class="tab-content"><h2 class="tab-title pixel">랭킹</h2><p class="empty-hint">랭킹 기능 준비 중!</p></div>`;
        },

        // ──────────────────────────────
        // 스타터 선택 (스프라이트 포함)
        // ──────────────────────────────
        async showStarterSelection() {
            const starterIds = [1, 4, 7];
            const overlay = document.createElement('div');
            overlay.id = 'starter-overlay';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal-content starter-modal">
                    <h2 class="pixel">파트너를 선택하세요!</h2>
                    <p class="starter-sub">세 마리 중 하나를 골라 모험을 시작하세요.</p>
                    <div class="starter-grid" id="starter-grid">
                        <div class="starter-loading">불러오는 중...</div>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const starters = await Promise.all(starterIds.map(id => game.fetchPokemon(id)));
            const grid = document.getElementById('starter-grid');
            if (!grid) return;

            grid.innerHTML = starters.map((p, i) => `
                <div class="starter-card type-bg-${p.types[0]}" onclick="game.ui._selectStarter(${i})">
                    <div class="starter-poke-aura type-${p.types[0]}"></div>
                    <img class="starter-sprite" src="${p.spriteUrl}" alt="${p.name}" />
                    <div class="starter-name pixel">${p.name}</div>
                    <div class="starter-type-row">
                        ${p.types.map(t => `<span class="type-badge type-${t}">${t}</span>`).join('')}
                    </div>
                    <div class="starter-stats">
                        <div class="s-stat"><span>HP</span><span>${p.stats.hp}</span></div>
                        <div class="s-stat"><span>공격</span><span>${p.stats.attack}</span></div>
                        <div class="s-stat"><span>방어</span><span>${p.stats.defense}</span></div>
                    </div>
                </div>
            `).join('');

            this._starterData = starters;
        },

        _starterData: null,
        _selectStarter(index) {
            const selected = this._starterData[index];
            if (!selected) return;
            const newPoke = { ...selected, nickname: selected.name, level: 5, currentHp: selected.stats.hp };
            game.state.player.team.push(newPoke);
            game.db.savePlayerData(game.state.player);

            const overlay = document.getElementById('starter-overlay');
            if (overlay) overlay.remove();

            this.showToast(`${newPoke.nickname}와(과) 함께 모험을 시작합니다!`);
            this.renderActiveTab();
        },

        // ──────────────────────────────
        // 전투 UI
        // ──────────────────────────────
        showBattleScene(show) {
            const scene = document.getElementById('battle-scene');
            if (scene) scene.classList.toggle('hidden', !show);
            if (show) {
                this.renderMoveButtons();
                const catchBtn = document.getElementById('btn-catch');
                const runBtn = document.getElementById('btn-run');
                if (catchBtn) catchBtn.onclick = () => game.battle.tryCatch();
                if (runBtn) runBtn.onclick = () => game.battle.tryRun();
            }
        },

        updateBattleUI() {
            const b = game.state.currentBattle;
            if (!b) return;
            const opp = b.opponent;
            const pp = b.playerPoke;

            document.getElementById('opp-name').textContent = opp.name;
            document.getElementById('opp-lv').textContent = `Lv.${opp.level}`;
            const oppHpPct = Math.max(0, (opp.currentHp / opp.stats.hp) * 100);
            document.getElementById('opp-hp-fill').style.width = oppHpPct + '%';
            document.getElementById('opp-hp-fill').style.background = oppHpPct > 50 ? '#4caf50' : oppHpPct > 20 ? '#ff9800' : '#f44336';

            document.getElementById('opp-sprite').src = opp.spriteUrl;

            document.getElementById('p-name').textContent = pp.nickname || pp.name;
            document.getElementById('p-lv').textContent = `Lv.${pp.level || 1}`;
            const ppHpPct = Math.max(0, ((pp.currentHp || pp.stats.hp) / pp.stats.hp) * 100);
            document.getElementById('p-hp-fill').style.width = ppHpPct + '%';
            document.getElementById('p-hp-fill').style.background = ppHpPct > 50 ? '#4caf50' : ppHpPct > 20 ? '#ff9800' : '#f44336';

            document.getElementById('player-sprite').src = pp.spriteUrl;
        },

        renderMoveButtons() {
            const b = game.state.currentBattle;
            const moveList = document.getElementById('move-list');
            if (!moveList || !b) return;
            const moves = b.playerPoke.moves || [];
            moveList.innerHTML = moves.map(m => `
                <button class="move-btn" onclick="game.battle.useMove('${m}')">${m}</button>
            `).join('');
        },

        log(msg) {
            const logBox = document.getElementById('battle-log');
            if (logBox) logBox.textContent = msg;
        },

        showToast(msg) {
            let toast = document.getElementById('toast-msg');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'toast-msg';
                document.body.appendChild(toast);
            }
            toast.textContent = msg;
            toast.classList.add('show');
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
        },

        renderTeam() {
            this.renderTeamTab(document.getElementById('view-port'));
        }
    },

    auth: {
        async login() {
            const id = document.getElementById('login-id').value.trim();
            const pw = document.getElementById('login-pw').value;
            if (!id) return;

            let player = game.db.getPlayerData();
            if (!player || player.name !== id) {
                player = {
                    id: crypto.randomUUID(),
                    name: id,
                    pw: pw,
                    team: [], box: [], pokedex: [], badges: [],
                    lastLogin: new Date().toISOString()
                };
                game.db.savePlayerData(player);
            }
            game.state.player = player;
            document.getElementById('auth-modal').classList.add('hidden');
            game.network.connect(player);

            if (player.team.length === 0) {
                game.ui.renderActiveTab();
                await game.ui.showStarterSelection();
            } else {
                game.ui.changeTab('wild');
            }
        }
    }
};
