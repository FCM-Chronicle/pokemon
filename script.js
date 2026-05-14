// script.js

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

    // ──────────────────────────────
    // 스프라이트 URL 목록 (우선순위 순)
    // 1순위: assets.pokemon.com (학교망에서도 접근 가능)
    // 2순위: raw.githubusercontent.com (폴백)
    // ──────────────────────────────
    getSpriteUrls(pokeId) {
        const padId = String(pokeId).padStart(3, '0');
        const gh = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
        return [
            `https://assets.pokemon.com/assets/cms2/img/pokedex/full/${padId}.png`,
            `${gh}/other/official-artwork/${pokeId}.png`,
            `${gh}/${pokeId}.png`,
        ];
    },

    // ──────────────────────────────
    // 포켓몬 API 패치 + 한국어 이름
    // ──────────────────────────────
    async fetchPokemon(id) {
        if (this.state.pokeCache[id]) return this.state.pokeCache[id];
        try {
            const res  = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
            if (!res.ok) throw new Error('API 오류');
            const data = await res.json();

            // 한국어 이름 가져오기
            let koName = data.name;
            try {
                const specRes  = await fetch(data.species.url);
                const specData = await specRes.json();
                const koEntry  = specData.names.find(n => n.language.name === 'ko');
                if (koEntry) koName = koEntry.name;
            } catch (_) {}

            // 기술 4개 랜덤
            const allMoves    = data.moves.map(m => m.move.name);
            const pickedMoves = allMoves.sort(() => Math.random() - 0.5).slice(0, 4);

            const spriteUrls = this.getSpriteUrls(data.id);

            const pokeData = {
                id:          data.id,
                name:        koName,
                nameEn:      data.name,
                types:       data.types.map(t => t.type.name),
                stats:       data.stats.reduce((acc, s) => ({ ...acc, [s.stat.name]: s.base_stat }), {}),
                moves:       pickedMoves,
                allMovePool: allMoves,
                spriteUrls:  spriteUrls,
                spriteUrl:   spriteUrls[0],
            };
            this.state.pokeCache[id] = pokeData;
            this.db.savePokemonCacheToServer(this.state.pokeCache);
            return pokeData;
        } catch (e) {
            console.error('API 오류:', e);
            return null;
        }
    },

    // ──────────────────────────────
    // 레벨에 따른 야생 포켓몬 ID 범위
    // 4세대(493종)까지 확장, 초반은 쉬운 포켓몬
    // ──────────────────────────────
    getWildPokemonId(playerMaxLevel) {
        // 플레이어 리드 포켓몬 레벨 기준으로 구역 결정
        const lv = playerMaxLevel || 5;
        if (lv < 15) {
            // 1세대 초반 (1~50)
            return Math.floor(Math.random() * 50) + 1;
        } else if (lv < 30) {
            // 1세대 전체 (1~151)
            return Math.floor(Math.random() * 151) + 1;
        } else if (lv < 50) {
            // 1~2세대 (1~251)
            return Math.floor(Math.random() * 251) + 1;
        } else if (lv < 70) {
            // 1~3세대 (1~386)
            return Math.floor(Math.random() * 386) + 1;
        } else {
            // 1~4세대 (1~493)
            return Math.floor(Math.random() * 493) + 1;
        }
    },

    // ──────────────────────────────
    // 레벨업 & 기술 습득 시스템
    // ──────────────────────────────
    async checkLevelUp(pokemon, expGain) {
        const prevLevel = pokemon.level || 1;
        // 간단한 경험치 공식: 레벨업에 필요한 경험치 = 레벨 * 50
        pokemon.exp = (pokemon.exp || 0) + expGain;
        const expNeeded = prevLevel * 50;

        if (pokemon.exp >= expNeeded) {
            pokemon.exp -= expNeeded;
            pokemon.level = prevLevel + 1;
            game.ui.log(`${pokemon.nickname || pokemon.name}이(가) 레벨 ${pokemon.level}이 되었다!`);

            // 10레벨마다 새 기술 습득 시도
            if (pokemon.level % 10 === 0) {
                await game.learnNewMove(pokemon);
            }
            return true;
        }
        return false;
    },

    async learnNewMove(pokemon) {
        const pool = pokemon.allMovePool || [];
        if (pool.length === 0) return;

        // 현재 기술에 없는 새 기술 랜덤 선택
        const currentMoves = pokemon.moves || [];
        const available = pool.filter(m => !currentMoves.includes(m));
        if (available.length === 0) return;

        const newMove = available[Math.floor(Math.random() * available.length)];

        if (currentMoves.length < 4) {
            // 빈 슬롯이 있으면 그냥 습득
            pokemon.moves.push(newMove);
            game.ui.showToast(`${pokemon.nickname || pokemon.name}이(가) ${newMove}을(를) 배웠다!`);
            game.ui.log(`새 기술 [${newMove}] 습득!`);
        } else {
            // 4개가 꽉 찼으면 플레이어에게 선택 요청
            game.ui._showMoveLearnPrompt(pokemon, newMove);
        }
    },

    _pendingMoveLearn: null,

    battle: {
        async startWildBattle() {
            if (game.state.currentBattle) return;

            const playerPoke = game.state.player?.team[0];
            if (!playerPoke) {
                game.ui.showToast("전투 가능한 포켓몬이 없습니다!");
                return;
            }

            // 플레이어 레벨 기준으로 야생 포켓몬 ID 결정
            const wildId = game.getWildPokemonId(playerPoke.level);
            const wildPoke = await game.fetchPokemon(wildId);
            if (!wildPoke) return;

            const wildPokeCopy = { ...wildPoke, moves: [...(wildPoke.moves || [])] };
            wildPokeCopy.currentHp = wildPokeCopy.stats.hp;

            // 야생 포켓몬 레벨: 플레이어 레벨 ±3 범위 (최소 2)
            const pLv = playerPoke.level || 5;
            const minLv = Math.max(2, pLv - 3);
            const maxLv = pLv + 3;
            wildPokeCopy.level = Math.floor(Math.random() * (maxLv - minLv + 1)) + minLv;

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
        const expGain = Math.floor(b.opponent.stats['special-attack'] * b.opponent.level / 7);
        game.ui.log(`야생 ${b.opponent.name}이(가) 쓰러졌다! 경험치 ${expGain} 획득!`);
        const leveled = await game.checkLevelUp(b.playerPoke, expGain);
        if (leveled) game.db.savePlayerData(game.state.player);
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
            // 살아있는 포켓몬 확인
            const aliveIndex = game.state.player.team.findIndex(
                p => p !== b.playerPoke && (p.currentHp || p.stats.hp) > 0
            );
            if (aliveIndex >= 0) {
                setTimeout(() => game.ui.showForcedSwitch(), 800);
            } else {
                setTimeout(() => this.endBattle(false), 1500);
            }
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
    const baseCatch = 0.25 + (1 - hpRatio) * 0.5;
    const attemptBonus = Math.min(0.1, b.catchAttempts * 0.02);
    const catchRate = Math.min(0.75, baseCatch + attemptBonus);
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
                exp: 0,
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
                    game.ui.log(`${b.playerPoke.nickname || b.playerPoke.name}이(가) 쓰러졌다...`);
                    const aliveIndex = game.state.player.team.findIndex(
                        p => p !== b.playerPoke && (p.currentHp || p.stats.hp) > 0
                    );
                    if (aliveIndex >= 0) {
                        setTimeout(() => game.ui.showForcedSwitch(), 800);
                    } else {
                        setTimeout(() => this.endBattle(false), 1500);
                    }
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
                game.ui.log(`${b.playerPoke.nickname || b.playerPoke.name}이(가) 쓰러졌다...`);
                const aliveIndex = game.state.player.team.findIndex(
                    p => p !== b.playerPoke && (p.currentHp || p.stats.hp) > 0
                );
                if (aliveIndex >= 0) {
                    setTimeout(() => game.ui.showForcedSwitch(), 800);
                } else {
                    setTimeout(() => this.endBattle(false), 1500);
                }
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

        // img 태그 생성 - src는 비워두고 data-poke-id만 저장
        // innerHTML 삽입 후 game.ui.applySprites()를 호출해서 실제 로드
        getSpriteHtml(poke, className) {
            return `<img class="${className}" alt="${poke.name}" data-poke-id="${poke.id}" data-poke-type="official" style="visibility:hidden">`;
        },

        // DOM에 삽입된 [data-poke-id] img들을 찾아서 loadSprite 적용
        applySprites(container) {
            const imgs = (container || document).querySelectorAll('img[data-poke-id]');
            imgs.forEach(img => {
                const id = parseInt(img.dataset.pokeId, 10);
                const cached = game.state.pokeCache[id];
                // 캐시에 spriteUrls 있으면 사용, 없으면 getSpriteUrls로 생성
                const urls = (cached && cached.spriteUrls) || game.getSpriteUrls(id);
                game.ui.loadSprite(img, urls);
            });
        },

        renderWildTab(container) {
            const player = game.state.player;
            const team = player?.team || [];
            const leadPoke = team[0];
            const pLv = leadPoke?.level || 5;

            // 현재 구역 표시
            let zoneText = '초원 (1세대)';
            if (pLv >= 15 && pLv < 30) zoneText = '숲 (1세대 전체)';
            else if (pLv >= 30 && pLv < 50) zoneText = '산악 (2세대)';
            else if (pLv >= 50 && pLv < 70) zoneText = '동굴 (3세대)';
            else if (pLv >= 70) zoneText = '심층 (4세대)';

            container.innerHTML = `
                <div class="tab-content wild-tab">
                    <div class="wild-scene">
                        <div class="grass-bg">
                            <div class="grass-layer l1"></div>
                            <div class="grass-layer l2"></div>
                        </div>
                        <div class="scene-content">
                            <div class="zone-badge">📍 ${zoneText}</div>
                            <div class="player-poke-display">
                                ${leadPoke ? `
                                    <div class="lobby-poke-card">
                                        <div class="poke-aura type-${leadPoke.types?.[0] || 'normal'}"></div>
                                        ${this.getSpriteHtml(leadPoke, 'lobby-sprite')}
                                        <div class="poke-info-bar">
                                            <span class="poke-nick">${leadPoke.nickname || leadPoke.name}</span>
                                            <span class="poke-lv">Lv.${leadPoke.level || 1}</span>
                                        </div>
                                        <div class="poke-hp-mini">
                                            <div class="hp-mini-fill" style="width:${Math.max(0, (leadPoke.currentHp / leadPoke.stats.hp) * 100)}%"></div>
                                        </div>
                                        <div class="poke-exp-mini">
                                            <div class="exp-mini-fill" style="width:${Math.min(100, ((leadPoke.exp || 0) / ((leadPoke.level || 1) * 50)) * 100)}%"></div>
                                        </div>
                                        ${team.length > 1 ? `
                                            <div class="team-mini-row">
                                                ${team.slice(1).map(p => `
                                                    <div class="team-mini-ball type-${p.types?.[0] || 'normal'}" title="${p.nickname || p.name}">
                                                        <img alt="${p.name}" data-poke-id="${p.id}" data-poke-type="mini" style="visibility:hidden" />
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
                                <p class="wild-hint">4세대 493종의 포켓몬이 기다리고 있다!</p>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            game.ui.applySprites(container);
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
                                    ${game.ui.getSpriteHtml(p, 'team-sprite')}
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
                                        <div class="exp-bar-wrap">
                                            <span class="exp-label">EXP</span>
                                            <div class="stat-bar-track"><div class="stat-bar-fill exp" style="width:${Math.min(100, ((p.exp || 0) / ((p.level || 1) * 50)) * 100)}%"></div></div>
                                        </div>
                                        <div class="move-list-mini">
                                            ${(p.moves || []).map(m => `<span class="move-chip">${m}</span>`).join('')}
                                        </div>
                                    </div>
                                </div>
                                ${i === 0 ? '<div class="team-leader-badge">선두</div>' : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            game.ui.applySprites(container);
        },

        renderPokedexTab(container) {
            // 4세대까지 493종
            const allPokes = (game.state.player?.team || []).concat(game.state.player?.box || []);
            const caught = new Set(allPokes.map(p => p.id));
            container.innerHTML = `
                <div class="tab-content pokedex-tab">
                    <h2 class="tab-title pixel">포켓도감</h2>
                    <p class="dex-count">발견: ${caught.size} / 493</p>
                    <div class="dex-grid">
                        ${Array.from({length: 493}, (_, i) => i + 1).map(id => {
                            const cached = game.state.pokeCache[id];
                            const isCaught = caught.has(id);
                            return `
                                <div class="dex-cell ${isCaught ? 'caught' : 'unseen'}" title="${cached?.name || '#' + id}">
                                    ${isCaught ? 
                                        `<img alt="${cached?.name || id}" data-poke-id="${id}" data-poke-type="mini" style="visibility:hidden" />` 
                                        : `<span class="dex-num">${String(id).padStart(3,'0')}</span>`}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
            game.ui.applySprites(container);
        },

        renderPvpTab(container) {
            container.innerHTML = `<div class="tab-content"><h2 class="tab-title pixel">대전</h2><p class="empty-hint">PvP 기능 준비 중!</p></div>`;
        },
        renderRankTab(container) {
            container.innerHTML = `<div class="tab-content"><h2 class="tab-title pixel">랭킹</h2><p class="empty-hint">랭킹 기능 준비 중!</p></div>`;
        },

        // ──────────────────────────────
        // 기술 습득 선택 UI (10레벨마다)
        // ──────────────────────────────
        _showMoveLearnPrompt(pokemon, newMove) {
            // 전투 중이면 잠시 후 표시
            const existing = document.getElementById('move-learn-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'move-learn-overlay';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal-content move-learn-modal">
                    <h3 class="pixel">${pokemon.nickname || pokemon.name}이(가) 새 기술을 배우려 한다!</h3>
                    <p class="new-move-name">✨ <strong>${newMove}</strong></p>
                    <p class="move-learn-sub">기술을 4개 이상 배울 수 없다. 잊을 기술을 선택하거나 포기하세요.</p>
                    <div class="move-forget-list">
                        ${(pokemon.moves || []).map((m, i) => `
                            <button class="move-forget-btn" onclick="game.ui._confirmForgetMove('${m}', '${newMove}', '${pokemon.nickname || pokemon.name}')">
                                ${m} 을(를) 잊고 ${newMove} 배우기
                            </button>
                        `).join('')}
                        <button class="move-forget-btn cancel" onclick="document.getElementById('move-learn-overlay').remove()">
                            ${newMove} 배우지 않기
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            game._pendingMoveLearn = { pokemon, newMove };
        },

        _confirmForgetMove(oldMove, newMove, pokeName) {
            const data = game._pendingMoveLearn;
            if (!data) return;
            const { pokemon } = data;
            const idx = pokemon.moves.indexOf(oldMove);
            if (idx >= 0) {
                pokemon.moves[idx] = newMove;
                game.ui.showToast(`${pokeName}이(가) ${oldMove}을(를) 잊고 ${newMove}을(를) 배웠다!`);
            }
            game.db.savePlayerData(game.state.player);
            game._pendingMoveLearn = null;
            const overlay = document.getElementById('move-learn-overlay');
            if (overlay) overlay.remove();
        },

        // ──────────────────────────────
        // 스타터 선택
        // ──────────────────────────────
        async showStarterSelection() {
            const starterIds = [1, 4, 7]; // 불꽃, 물, 풀 (1세대)
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
                    <img class="starter-sprite" alt="${p.name}" data-poke-id="${p.id}" data-poke-type="official" style="visibility:hidden" />
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

            game.ui.applySprites(grid);
            this._starterData = starters;
        },

        _starterData: null,
        _selectStarter(index) {
            const selected = this._starterData[index];
            if (!selected) return;
            const newPoke = { 
                ...selected, 
                nickname: selected.name, 
                level: 5, 
                currentHp: selected.stats.hp,
                exp: 0,
                moves: [...(selected.moves || [])],
                allMovePool: [...(selected.allMovePool || [])],
            };
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

            // 스프라이트 로딩: assets.pokemon.com → github 순으로 시도
            game.ui.loadSprite(document.getElementById('opp-sprite'), opp.spriteUrls || game.getSpriteUrls(opp.id));

            document.getElementById('p-name').textContent = pp.nickname || pp.name;
            document.getElementById('p-lv').textContent = `Lv.${pp.level || 1}`;
            const ppHpPct = Math.max(0, ((pp.currentHp || pp.stats.hp) / pp.stats.hp) * 100);
            document.getElementById('p-hp-fill').style.width = ppHpPct + '%';
            document.getElementById('p-hp-fill').style.background = ppHpPct > 50 ? '#4caf50' : ppHpPct > 20 ? '#ff9800' : '#f44336';

            game.ui.loadSprite(document.getElementById('player-sprite'), pp.spriteUrls || game.getSpriteUrls(pp.id));
        },

        // URL 목록을 순서대로 시도해서 처음 성공한 것을 img에 적용
        loadSprite(imgEl, urls) {
            if (!imgEl || !urls.length) return;
            imgEl.style.visibility = 'hidden';

            const tryNext = (idx) => {
                if (idx >= urls.length) {
                    // 모든 URL 실패
                    console.warn('모든 스프라이트 URL 실패:', urls);
                    return;
                }
                const tester = new Image();
                tester.onload = () => {
                    imgEl.src = urls[idx];
                    imgEl.style.visibility = 'visible';
                };
                tester.onerror = () => tryNext(idx + 1);
                tester.src = urls[idx];
            };
            tryNext(0);
        },

        renderMoveButtons() {
    const b = game.state.currentBattle;
    const moveList = document.getElementById('move-list');
    if (!moveList || !b) return;
    const moves = b.playerPoke.moves || [];
    moveList.innerHTML = moves.map(m => `
        <button class="move-btn" onclick="game.battle.useMove('${m}')">${m}</button>
    `).join('');

    // 교체 버튼 추가
    const subMenu = document.getElementById('sub-menu');
    if (subMenu) {
        const existingSwitch = document.getElementById('btn-switch');
        if (!existingSwitch) {
            const switchBtn = document.createElement('button');
            switchBtn.id = 'btn-switch';
            switchBtn.textContent = '🔄 교체';
            switchBtn.onclick = () => {
                if (game.state.currentBattle?.isPlayerTurn) {
                    game.state.currentBattle.isPlayerTurn = false;
                    game.ui.showSwitchMenu();
                }
            };
            subMenu.insertBefore(switchBtn, document.getElementById('btn-catch'));
        }
    }
},

// 포켓몬 교체 UI (전투 중 자유 교체 - 상대 공격 받음)
showSwitchMenu() {
    const b = game.state.currentBattle;
    if (!b) return;
    const team = game.state.player.team;
    const alive = team.filter(p => p !== b.playerPoke && (p.currentHp || p.stats.hp) > 0);
    if (alive.length === 0) {
        game.ui.showToast('교체할 포켓몬이 없습니다!');
        return;
    }

    const existing = document.getElementById('switch-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'switch-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content switch-modal">
            <h3 class="pixel">포켓몬 교체</h3>
            <p class="switch-sub">어떤 포켓몬과 교체할까요?</p>
            <div class="switch-list">
                ${team.map((p, i) => {
                    const hp = p.currentHp ?? p.stats.hp;
                    const maxHp = p.stats.hp;
                    const isCurrent = p === b.playerPoke;
                    const isDead = hp <= 0;
                    const hpPct = Math.max(0, (hp / maxHp) * 100);
                    const hpColor = hpPct > 50 ? '#4caf50' : hpPct > 20 ? '#ff9800' : '#f44336';
                    return `
                        <button class="switch-btn ${isCurrent ? 'current' : ''} ${isDead ? 'fainted' : ''}"
                            ${(isCurrent || isDead) ? 'disabled' : `onclick="game.ui._doSwitch(${i}, false)"`}>
                            <img alt="${p.name}" data-poke-id="${p.id}" style="visibility:hidden;width:48px;height:48px">
                            <div class="switch-info">
                                <span class="switch-name">${p.nickname || p.name}</span>
                                <span class="switch-lv">Lv.${p.level || 1}</span>
                                <div class="switch-hp-track">
                                    <div class="switch-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div>
                                </div>
                                <span class="switch-hp-txt">${hp}/${maxHp}</span>
                            </div>
                            ${isCurrent ? '<span class="switch-tag">출전 중</span>' : ''}
                            ${isDead ? '<span class="switch-tag fainted-tag">기절</span>' : ''}
                        </button>
                    `;
                }).join('')}
            </div>
            <button class="switch-cancel-btn" onclick="document.getElementById('switch-overlay').remove(); 
                const b=game.state.currentBattle; if(b){b.isPlayerTurn=true; game.ui.renderMoveButtons();}">
                취소
            </button>
        </div>
    `;
    document.body.appendChild(overlay);
    game.ui.applySprites(overlay);
},

// 강제 교체 UI (기절했을 때 - 취소 없음)
showForcedSwitch() {
    const b = game.state.currentBattle;
    if (!b) return;
    const team = game.state.player.team;

    const existing = document.getElementById('switch-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'switch-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content switch-modal">
            <h3 class="pixel">포켓몬을 선택하세요!</h3>
            <p class="switch-sub">${b.playerPoke.nickname || b.playerPoke.name}이(가) 쓰러졌습니다!</p>
            <div class="switch-list">
                ${team.map((p, i) => {
                    const hp = p.currentHp ?? p.stats.hp;
                    const maxHp = p.stats.hp;
                    const isCurrent = p === b.playerPoke;
                    const isDead = hp <= 0 || isCurrent;
                    const hpPct = Math.max(0, (hp / maxHp) * 100);
                    const hpColor = hpPct > 50 ? '#4caf50' : hpPct > 20 ? '#ff9800' : '#f44336';
                    return `
                        <button class="switch-btn ${isDead ? 'fainted' : ''}"
                            ${isDead ? 'disabled' : `onclick="game.ui._doSwitch(${i}, true)"`}>
                            <img alt="${p.name}" data-poke-id="${p.id}" style="visibility:hidden;width:48px;height:48px">
                            <div class="switch-info">
                                <span class="switch-name">${p.nickname || p.name}</span>
                                <span class="switch-lv">Lv.${p.level || 1}</span>
                                <div class="switch-hp-track">
                                    <div class="switch-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div>
                                </div>
                                <span class="switch-hp-txt">${hp}/${maxHp}</span>
                            </div>
                            ${isDead ? '<span class="switch-tag fainted-tag">기절</span>' : ''}
                        </button>
                    `;
                }).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    game.ui.applySprites(overlay);
},

// 실제 교체 실행
_doSwitch(teamIndex, isForced) {
    const b = game.state.currentBattle;
    if (!b) return;
    const overlay = document.getElementById('switch-overlay');
    if (overlay) overlay.remove();

    const newPoke = game.state.player.team[teamIndex];
    if (!newPoke) return;

    b.playerPoke = newPoke;
    game.ui.log(`${newPoke.nickname || newPoke.name}! 가랏!`);
    game.ui.updateBattleUI();
    game.ui.renderMoveButtons();

    // 자유 교체면 상대가 한 번 공격
    if (!isForced) {
        b.isPlayerTurn = false;
        setTimeout(() => {
            const oppDamage = game.battle.calculateDamage(
                b.opponent.stats.attack, b.playerPoke.stats.defense, 35, b.opponent.level, 1
            );
            b.playerPoke.currentHp = Math.max(0, (b.playerPoke.currentHp ?? b.playerPoke.stats.hp) - oppDamage);
            game.ui.log(`야생 ${b.opponent.name}의 공격! ${oppDamage}의 데미지!`);
            game.ui.updateBattleUI();
            if (b.playerPoke.currentHp <= 0) {
                game.ui.log(`${b.playerPoke.nickname || b.playerPoke.name}이(가) 쓰러졌다...`);
                const aliveIndex = game.state.player.team.findIndex(
                    p => p !== b.playerPoke && (p.currentHp || p.stats.hp) > 0
                );
                if (aliveIndex >= 0) {
                    setTimeout(() => game.ui.showForcedSwitch(), 800);
                } else {
                    setTimeout(() => game.battle.endBattle(false), 1500);
                }
            } else {
                b.isPlayerTurn = true;
                game.ui.renderMoveButtons();
            }
        }, 1000);
    } else {
        b.isPlayerTurn = true;
    }
},

// ──────────────────────────────
// 전역 스프라이트 폴백 함수
// onerror 인라인에서 따옴표 충돌 없이 호출 가능
//
// 폴백 순서:
//   0 (최초): official-artwork PNG 시도 중 실패
//          → static front_default PNG 로 교체 (data-fb="1")
//   1: static도 실패
//          → 완전히 숨김 처리 (broken image 방지)
// ──────────────────────────────
// ──────────────────────────────
// 구버전 캐시 자동 초기화
// spriteUrls 없는 캐시는 이미지가 안 나오므로 삭제
// ──────────────────────────────
(function migrateCacheIfNeeded() {
    try {
        const raw = localStorage.getItem('player_data');
        if (!raw) return;
        const player = JSON.parse(raw);
        // team/box 포켓몬에 spriteUrls 없으면 캐시 초기화 신호
        const allPokes = (player.team || []).concat(player.box || []);
        const needsMigration = allPokes.some(p => !p.spriteUrls);
        if (needsMigration) {
            // pokeCache만 삭제 (팀/박스 데이터는 유지)
            allPokes.forEach(p => {
                if (!p.spriteUrls) {
                    p.spriteUrls = game.getSpriteUrls(p.id);
                    p.spriteUrl  = p.spriteUrls[0];
                }
            });
            localStorage.setItem('player_data', JSON.stringify(player));
            console.log('[마이그레이션] 스프라이트 URL 업데이트 완료');
        }
    } catch(e) {}
})();

function pokeFallback(img) {
    const id = img.dataset.id;
    const fb = parseInt(img.dataset.fb || '0', 10);

    if (!id) { img.style.display = 'none'; return; }

    const base = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

    if (fb === 0) {
        // 1차 폴백: 소형 static PNG
        img.dataset.fb = '1';
        img.src = `${base}/${id}.png`;
    } else if (fb === 1) {
        // 2차 폴백: showdown GIF
        img.dataset.fb = '2';
        img.src = `${base}/other/showdown/${id}.gif`;
    } else {
        // 모든 폴백 실패 → 숨김
        img.style.display = 'none';
    }
}
