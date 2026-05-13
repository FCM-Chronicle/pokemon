const game = {
    state: {
        player: null,
        activeTab: 'wild',
        currentBattle: null, // { opponent, type: 'wild' | 'pvp', isPlayerTurn: true }
    },

    // --- 1. 데이터 저장소 및 캐시 매니저 ---
    db: {
        getPokemonCache() {
            return JSON.parse(localStorage.getItem('poke_cache') || '{}');
        },
        savePokemonCache(data) {
            localStorage.setItem('poke_cache', JSON.stringify(data));
        },
        getPlayerData() {
            return JSON.parse(localStorage.getItem('player_data'));
        },
        savePlayerData(data) {
            localStorage.setItem('player_data', JSON.stringify(data)); // 로컬 스토리지에 저장
            // 서버에 팀 변경 사항 알림
            if (game.network.socket && game.network.socket.readyState === WebSocket.OPEN) game.network.send({ type: 'update_team', team: data.team });
        }
    },

    // --- 2. PokeAPI 호출 ---
    async fetchPokemon(id) {
        const cache = this.db.getPokemonCache();
        
        // 이미 호출한 정보가 있다면 캐시에서 반환 (스프라이트는 URL이므로 그대로 사용)
        if (cache[id]) return cache[id];

        // 없으면 API 호출
        try {
            const response = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
            const data = await response.json();
            
            // 캐시할 데이터 정제 (스프라이트 제외 요청하셨지만, URL 자체는 저장해야 렌더링 가능)
            const pokeData = {
                id: data.id,
                name: data.name,
                types: data.types.map(t => t.type.name),
                stats: data.stats.reduce((acc, s) => ({...acc, [s.stat.name]: s.base_stat}), {}),
                moves: data.moves.slice(0, 10).map(m => m.move.name), // 간단히 10개만
                spriteUrl: data.sprites.other['official-artwork'].front_default || data.sprites.front_default
            };

            cache[id] = pokeData;
            this.db.savePokemonCache(cache);
            return pokeData;
        } catch (e) {
            console.error("API 재시도 중...", e);
            // 최대 3회 재시도 로직 추가 가능
            return null;
        }
    },

    // --- 3. 전투 시스템 ---
    battle: {
        async startWildBattle() {
            const randomId = Math.floor(Math.random() * 151) + 1;
            const wildPoke = await game.fetchPokemon(randomId);
            if (!wildPoke) return;

            wildPoke.currentHp = wildPoke.stats.hp;
            wildPoke.level = Math.floor(Math.random() * 5) + 5;

            const playerPoke = game.state.player.team[0];
            if (!playerPoke) return alert("전투 가능한 포켓몬이 없습니다! 먼저 포켓몬을 얻으세요.");

            game.state.currentBattle = {
                type: 'wild',
                opponent: wildPoke,
                playerPoke: playerPoke,
                isPlayerTurn: true
            };

            game.ui.showBattleScene(true);
            game.ui.updateBattleUI();
        },

        async useMove(moveName) {
            const b = game.state.currentBattle;
            if (!b || !b.isPlayerTurn) return;

            // 플레이어 공격
            const damage = this.calculateDamage(b.playerPoke.stats.attack, b.opponent.stats.defense, 40, b.playerPoke.level, 1);
            b.opponent.currentHp = Math.max(0, b.opponent.currentHp - damage);
            game.ui.log(`${b.playerPoke.name}의 ${moveName}! ${damage}의 데미지!`);
            
            game.ui.updateBattleUI();

            if (b.opponent.currentHp <= 0) {
                game.ui.log(`${b.opponent.name}이(가) 쓰러졌다!`);
                setTimeout(() => this.endBattle(true), 1500);
                return;
            }

            // 적 공격 (간단한 AI)
            b.isPlayerTurn = false;
            setTimeout(() => {
                const oppDamage = this.calculateDamage(b.opponent.stats.attack, b.playerPoke.stats.defense, 40, b.opponent.level, 1);
                b.playerPoke.currentHp = Math.max(0, (b.playerPoke.currentHp || b.playerPoke.stats.hp) - oppDamage);
                game.ui.log(`적 ${b.opponent.name}의 공격! ${oppDamage}의 데미지!`);
                game.ui.updateBattleUI();
                
                if (b.playerPoke.currentHp <= 0) {
                    game.ui.log(`${b.playerPoke.name}이(가) 쓰러졌다...`);
                    setTimeout(() => this.endBattle(false), 1500);
                } else {
                    b.isPlayerTurn = true;
                }
            }, 1000);
        },

        calculateDamage(atk, def, movePower, level, typeMod) {
            const random = 0.85 + Math.random() * 0.15;
            const levelMod = level / 50;
            // 방어력이 0인 경우 방지
            const safeDef = def || 1;
            return Math.floor((atk / safeDef) * movePower * typeMod * random * (1 + levelMod));
        },
        
        checkEvolution(p) {
            if (p.level >= 40) {
                // 특정 레벨 도달 시 진화 로직 실행
                alert(`${p.nickname}이(가) 진화할 수 있습니다!`);
            }
        },

        endBattle(isWin) {
            game.state.currentBattle = null;
            game.ui.showBattleScene(false);
            if (game.state.player) game.db.savePlayerData(game.state.player); // 전투 후 플레이어 데이터 저장
            game.ui.renderActiveTab();
        }
    },

    // --- 4. 시스템 및 네트워크 ---
    auth: {
        login() {
            const id = document.getElementById('login-id').value;
            const pw = document.getElementById('login-pw').value;
            if(!id) return;

            let player = game.db.getPlayerData();
            if(!player || player.name !== id) {
                // 신규 생성
                player = {
                    id: crypto.randomUUID(),
                    name: id,
                    pw: pw, // MVP 수준 저장
                    team: [], box: [], pokedex: [], badges: [],
                    lastLogin: new Date().toISOString()
                };
                game.db.savePlayerData(player);
            }
            document.getElementById('auth-modal').classList.add('hidden');
            game.network.connect(player);
        }
    }
};
