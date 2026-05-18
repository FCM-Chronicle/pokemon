// script.js

var game = {
    state: {
        player: null,
        activeTab: 'wild',
        currentBattle: null,
        pokeCache: {},
        evoChainCache: {},   // evolution chain 캐시
        onlinePlayers: [],
        rankings: [],
        typeChart: {
            fire: { grass: 2, ice: 2, bug: 2, steel: 2, water: 0.5, fire: 0.5, rock: 0.5, dragon: 0.5 },
            water: { fire: 2, ground: 2, rock: 2, water: 0.5, grass: 0.5, dragon: 0.5 },
            grass: { water: 2, ground: 2, rock: 2, fire: 0.5, grass: 0.5, poison: 0.5, flying: 0.5, bug: 0.5, dragon: 0.5, steel: 0.5 },
            electric: { water: 2, flying: 2, electric: 0.5, grass: 0.5, dragon: 0.5, ground: 0 },
            ice: { grass: 2, ground: 2, flying: 2, dragon: 2, fire: 0.5, water: 0.5, ice: 0.5, steel: 0.5 },
            fighting: { normal: 2, ice: 2, rock: 2, dark: 2, steel: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, fairy: 0.5, ghost: 0 },
            poison: { grass: 2, fairy: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0 },
            ground: { fire: 2, electric: 2, poison: 2, rock: 2, steel: 2, grass: 0.5, bug: 0.5, flying: 0 },
            flying: { grass: 2, fighting: 2, bug: 2, electric: 0.5, rock: 0.5, steel: 0.5 },
            psychic: { fighting: 2, poison: 2, psychic: 0.5, steel: 0.5, dark: 0 },
            bug: { grass: 2, psychic: 2, dark: 2, fire: 0.5, fighting: 0.5, poison: 0.5, flying: 0.5, ghost: 0.5, steel: 0.5, fairy: 0.5 },
            rock: { fire: 2, ice: 2, flying: 2, bug: 2, fighting: 0.5, ground: 0.5, steel: 0.5 },
            ghost: { psychic: 2, ghost: 2, dark: 0.5, normal: 0 },
            dragon: { dragon: 2, steel: 0.5, fairy: 0 },
            dark: { psychic: 2, ghost: 2, fighting: 0.5, dark: 0.5, fairy: 0.5 },
            steel: { ice: 2, rock: 2, fairy: 2, fire: 0.5, water: 0.5, electric: 0.5, steel: 0.5 },
            fairy: { fighting: 2, dragon: 2, dark: 2, fire: 0.5, poison: 0.5, steel: 0.5 }
        },
        statusEffects: { // Define properties of status effects
            poison: { name: '독', color: 'purple', damagePerTurn: 0.0625 }, // 1/16 of max HP
            paralysis: { name: '마비', color: 'yellow', chanceToSkipTurn: 0.25, speedModifier: 0.5 }, // 25% chance to skip, speed halved
            sleep: { name: '수면', color: 'gray', minTurns: 2, maxTurns: 4 }, // Sleep for 2-4 turns
            burn: { name: '화상', color: 'orange', damagePerTurn: 0.0625, attackModifier: 0.5 }, // 1/16 of max HP, attack halved
            freeze: { name: '얼음', color: 'lightblue', chanceToThaw: 0.2 }, // 20% chance to thaw each turn
        }
    },

    db: {
    async getPlayerData(name) {
        try {
            const res = await fetch(`/api/players/${encodeURIComponent(name)}`);
            const json = await res.json();
            return json.player; // Returns null if not found, or player object
        } catch (e) {
            console.error('플레이어 데이터 불러오기 실패:', e);
            return null; // Explicitly return null on error
        }
    },
    async savePlayerData(data) {
        try {
            await fetch('/api/players', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } catch (e) {
            // 서버 저장 실패 시에도 클라이언트는 계속 진행 (데이터는 다음 로그인 시 동기화)
            console.error('서버 저장 실패:', e);
        }
        if (game.network.socket && game.network.socket.readyState === WebSocket.OPEN)
            game.network.send({ type: 'update_team', team: data.team });
    },
    savePokemonCacheToServer(data) {
        game.state.pokeCache = data;
        if (game.network.socket && game.network.socket.readyState === WebSocket.OPEN)
            game.network.send({ type: 'update_cache', cache: data });
    }
},

    getSpriteUrls(pokeId) {
        const js = 'https://cdn.jsdelivr.net/gh/PokeAPI/sprites/master/sprites/pokemon';
        const un = 'https://unpkg.com/pokeapi-sprites@2.0.2/sprites/pokemon';
        const gh = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
        
        return [
            `${js}/other/official-artwork/${pokeId}.png`, // JSDelivr (차단될 확률 매우 낮음)
            `${un}/other/official-artwork/${pokeId}.png`, // Unpkg (대체 CDN)
            `${gh}/other/official-artwork/${pokeId}.png`, // GitHub 원본
            `${js}/${pokeId}.png`,                        // 일반 스프라이트
        ];
    },

    async fetchPokemon(id) {
        if (this.state.pokeCache[id]) return this.state.pokeCache[id];
        try {
            const res  = await fetch(`/api/pokeapi/pokemon/${id}`);
            if (!res.ok) throw new Error('API 오류');
            const data = await res.json();

            let koName = data.name;
            try {
                const specRes  = await fetch(data.species.url.replace('https://pokeapi.co/api/v2', '/api/pokeapi'));
                const specData = await specRes.json();
                const koEntry  = specData.names.find(n => n.language.name === 'ko');
                if (koEntry) koName = koEntry.name;
            } catch (_) {}

            const allMoves    = data.moves.map(m => m.move.name);
            
            // 초기 포켓몬(스타터 등)은 초반용 기술(위력 55 이하) 위주로 무작위 선별
            const moveDetails = [];
            const shuffledMoves = allMoves.sort(() => Math.random() - 0.5);
            for (const name of shuffledMoves) {
                if (moveDetails.length >= 4) break;
                const detail = await this.fetchMoveDetail(name);
                // 위력이 55 이하이거나, 남은 기술이 적어 어쩔 수 없는 경우 선택
                if (detail.power <= 55 || moveDetails.length >= 3) {
                    moveDetails.push(detail);
                }
            }

            const spriteUrls  = this.getSpriteUrls(data.id);

            const baseStats = data.stats.reduce((acc, s) => ({ ...acc, [s.stat.name]: s.base_stat }), {});
            const maxHp = this.calculateMaxHP(baseStats.hp, 5); // 기본 5레벨 기준

            const pokeData = {
                id:          data.id,
                name:        koName,
                nameEn:      data.name,
                types:       data.types.map(t => t.type.name),
                stats:       { ...baseStats, hp: maxHp, baseHp: baseStats.hp },
                moves:       moveDetails,
                allMovePool: allMoves,
                status:      null, // Initial status
                statusTurns: 0, // Turns remaining for status like sleep
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

    async fetchMoveDetail(nameEn) {
        try {
            const res = await fetch(`/api/pokeapi/move/${nameEn}`);
            if (!res.ok) throw new Error();
            const data = await res.json();
            let koName = data.name;
            const koEntry = data.names.find(n => n.language.name === 'ko');
            if (koEntry) koName = koEntry.name;

            // Crit rate stages: 0 -> 6.25%, 1 -> 12.5%, 2 -> 25%, 3 -> 33.3%
            const critChance = [0.0625, 0.125, 0.25, 0.333][data.meta.crit_rate || 0] || 0.0625;
            return {
                name: koName,
                nameEn: data.name,
                power: data.power || 40,
                type: data.type.name,
                accuracy: data.accuracy || 100, // Default to 100 if not specified
                crit_chance: critChance,
                // For simplicity, we won't fetch ailment details for now, but this is where it would go
                // ailment: data.meta.ailment?.name,
                // ailment_chance: data.meta.ailment_chance,
            };
        } catch (e) {
            return { name: nameEn, nameEn: nameEn, power: 40, type: 'normal' };
        }
    },

    // ── 진화 체인 가져오기 ──────────────────────────────
    // 반환값: [base_id, stage1_id, stage2_id] (없으면 null)
    async fetchEvoChain(pokemonId) {
        if (this.state.evoChainCache[pokemonId]) return this.state.evoChainCache[pokemonId];
        try {
            const specRes  = await fetch(`/api/pokeapi/pokemon-species/${pokemonId}`);
            if (!specRes.ok) return null;
            const specData = await specRes.json();

            const chainRes  = await fetch(specData.evolution_chain.url.replace('https://pokeapi.co/api/v2', '/api/pokeapi'));
            if (!chainRes.ok) return null;
            const chainData = await chainRes.json();

            // 체인 파싱: 최대 3단계
            const chain = [];
            let node = chainData.chain;
            while (node) {
                const url = node.species.url;
                const id  = parseInt(url.split('/').filter(Boolean).pop(), 10);
                chain.push(id);
                node = node.evolves_to?.[0] || null;
            }
            // chain = [base, evo1, evo2] (길이 1~3)

            // 이 포켓몬이 속한 체인의 인덱스 찾아 캐시 (chain 전체에 적용)
            chain.forEach(id => { this.state.evoChainCache[id] = chain; });
            return chain;
        } catch (e) {
            return null;
        }
    },

    // 진화 가능 여부 체크 후 진화 실행
    // 15렙: 1진화, 30렙: 2진화
    async checkEvolution(pokemon) {
        const level = pokemon.level || 1;
        if (level < 15) return false; // 최소 진화 레벨 미만

        const chain = await game.fetchEvoChain(pokemon.id);
        if (!chain || chain.length < 2) return false;

        const currentIdx = chain.indexOf(pokemon.id);
        if (currentIdx < 0) return false;

        let targetIdx = -1;
        // 30렙 이상이고 아직 최종진화(2단계) 전이면
        if (level >= 30 && currentIdx <= 1 && chain.length >= 3) targetIdx = 2;
        // 15렙 이상이고 아직 진화 전(0단계)이면
        else if (level >= 15 && currentIdx === 0 && chain.length >= 2) targetIdx = 1;

        if (targetIdx < 0 || targetIdx === currentIdx) return false;

        const evoId   = chain[targetIdx];
        const evoData = await game.fetchPokemon(evoId);
        if (!evoData) return false;

        const prevName = pokemon.nickname || pokemon.name;

        // 스탯/이름/타입/스프라이트 업데이트, 닉네임·레벨·경험치·기술 유지
        const oldHpRatio = pokemon.currentHp / pokemon.stats.hp;
        pokemon.id        = evoData.id;
        pokemon.stats     = { ...evoData.stats, hp: this.calculateMaxHP(evoData.stats.baseHp, level) };
        pokemon.currentHp = Math.max(1, Math.floor(pokemon.stats.hp * oldHpRatio));
        pokemon.name      = evoData.name;
        pokemon.nameEn    = evoData.nameEn;
        pokemon.types     = evoData.types;
        pokemon.spriteUrls= evoData.spriteUrls;
        pokemon.spriteUrl = evoData.spriteUrls[0];

        // 기술 풀 업데이트 (기존 기술은 유지)
        const oldMoves     = pokemon.moves || [];
        pokemon.allMovePool= evoData.allMovePool;
        pokemon.moves      = oldMoves; // 기존 기술 그대로 유지

        game.ui.showEvolutionEffect(prevName, pokemon);
        return true;
    },

    // ── 야생 포켓몬 ID 선택 ──────────────────────────────
    // 팀 최고 레벨 기준으로 진화 단계 포켓몬 필터링
    getWildPokemonId(playerMaxLevel) {
        const lv = playerMaxLevel || 5;

        // 세대별 범위
        let maxId;
        if (lv < 15)       maxId = 50;
        else if (lv < 30)  maxId = 151;
        else if (lv < 50)  maxId = 251;
        else if (lv < 70)  maxId = 386;
        else               maxId = 493;

        return Math.floor(Math.random() * maxId) + 1;
    },

    // 팀 최고 레벨 반환
    getTeamMaxLevel() {
        const team = game.state.player?.team || [];
        if (team.length === 0) return 1;
        return Math.max(...team.map(p => p.level || 1));
    },

    async checkLevelUp(pokemon, expGain) {
        pokemon.exp = (pokemon.exp || 0) + expGain;
        let leveledUp = false;

        while (pokemon.exp >= (pokemon.level || 1) * 50) {
            const expNeeded = (pokemon.level || 1) * 50;
            pokemon.exp -= expNeeded;
            pokemon.level = (pokemon.level || 1) + 1;
            leveledUp = true;
            
            game.ui.log(`${pokemon.nickname || pokemon.name}이(가) 레벨 ${pokemon.level}이 되었다!`);

            if (pokemon.level % 10 === 0) await game.learnNewMove(pokemon);
            
            const evolved = await game.checkEvolution(pokemon);
            if (evolved) pokemon.currentHp = Math.max(1, pokemon.currentHp);
        }

        if (leveledUp) {
            game.db.savePlayerData(game.state.player);
            game.ui.renderActiveTab();
        }
        return leveledUp;
    },

    async learnNewMove(pokemon) {
        const pool = pokemon.allMovePool || [];
        if (pool.length === 0) return;

        const currentMoves = pokemon.moves || [];
        const available = pool.filter(mName => !currentMoves.some(cm => cm.nameEn === mName));
        if (available.length === 0) return;

        // 레벨에 따른 기술 위력 제한 (15렙 미만: 55, 30렙 미만: 80, 그 이상: 무제한)
        const maxPower = pokemon.level < 15 ? 55 : (pokemon.level < 30 ? 80 : 999);
        const shuffledAvailable = available.sort(() => Math.random() - 0.5);
        
        let newMove = null;
        for (const name of shuffledAvailable) {
            const detail = await this.fetchMoveDetail(name);
            if (detail.power <= maxPower) {
                newMove = detail;
                break;
            }
        }
        // 적절한 위력의 기술을 못 찾았다면 가장 첫 번째 기술이라도 배움
        if (!newMove) newMove = await this.fetchMoveDetail(shuffledAvailable[0]);

        if (currentMoves.length < 4) {
            pokemon.moves.push(newMove);
            game.ui.showToast(`${pokemon.nickname || pokemon.name}이(가) ${newMove.name}을(를) 배웠다!`);
            game.ui.log(`새 기술 [${newMove.name}] 습득!`);
        } else {
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

            const teamMaxLv = game.getTeamMaxLevel();
            const wildId    = game.getWildPokemonId(teamMaxLv);
            const wildPoke  = await game.fetchPokemon(wildId);
            if (!wildPoke) return;

            const wildPokeCopy = { ...wildPoke, moves: [...(wildPoke.moves || [])] };

            // 팀 최고렙 기준 진화 단계 조정
            // 15렙 이상이면 1진화 포켓몬도 나올 수 있음 (50% 확률)
            // 30렙 이상이면 2진화 포켓몬도 나올 수 있음 (30% 확률)
            if (teamMaxLv >= 30 && Math.random() < 0.30) {
                const chain = await game.fetchEvoChain(wildId);
                if (chain && chain.length >= 3) {
                    const evo2Data = await game.fetchPokemon(chain[2]);
                    if (evo2Data) Object.assign(wildPokeCopy, { ...evo2Data, moves: [...(evo2Data.moves || [])] });
                }
            } else if (teamMaxLv >= 15 && Math.random() < 0.50) {
                const chain = await game.fetchEvoChain(wildId);
                if (chain && chain.length >= 2) {
                    const evo1Data = await game.fetchPokemon(chain[1]);
                    if (evo1Data) Object.assign(wildPokeCopy, { ...evo1Data, moves: [...(evo1Data.moves || [])] });
                }
            }

            wildPokeCopy.stats.hp = this.calculateMaxHP(wildPokeCopy.stats.baseHp, wildPokeCopy.level);
            wildPokeCopy.currentHp = wildPokeCopy.stats.hp;
            wildPokeCopy.status = null;
            wildPokeCopy.statusTurns = 0;

            const pLv    = playerPoke.level || 5;
            const minLv  = Math.max(2, pLv - 3);
            const maxLv  = pLv + 3;
            wildPokeCopy.level = Math.floor(Math.random() * (maxLv - minLv + 1)) + minLv;

            // 사용자의 요청: 무조건 플레이어 선공
            let firstTurnPlayer = true;

            playerPoke.status = null; // Clear player's status at start of new battle
            playerPoke.statusTurns = 0;

            if (!playerPoke.currentHp || playerPoke.currentHp <= 0) {
                playerPoke.currentHp = playerPoke.stats.hp;
            }

            game.state.currentBattle = {
                type: 'wild',
                opponent: wildPokeCopy,
                playerPoke: playerPoke,
                participants: new Set([playerPoke]),
                isPlayerTurn: firstTurnPlayer,
                catchAttempts: 0,
            };

            game.ui.showBattleScene(true);
            game.ui.updateBattleUI();
            game.ui.log(`야생 ${wildPokeCopy.name}이(가) 나타났다!`);
        },

        async startPvpBattle(opponentId, opponentName, opponentTeam, isChallenger) {
            const playerPoke = game.state.player?.team[0];
            if (!playerPoke) {
                game.ui.showToast("전투 가능한 포켓몬이 없습니다!");
                return;
            }

            game.state.currentBattle = {
                type: 'pvp',
                opponentId: opponentId,
                opponentPlayerName: opponentName,
                opponent: { ...opponentTeam[0], currentHp: opponentTeam[0].stats.hp },
                playerPoke: playerPoke,
                participants: new Set([playerPoke]),
                isPlayerTurn: isChallenger,
            };
            game.ui.showBattleScene(true);
            game.ui.updateBattleUI();
            game.ui.log(`${opponentName} 트레이너와 대전 시작!`);
        },

        async useMove(moveName) {
            const b = game.state.currentBattle;
            if (!b || !b.isPlayerTurn) return;
            b.isPlayerTurn = false;

            const move = b.playerPoke.moves.find(m => (m.name || m) === moveName);
            if (!move) { b.isPlayerTurn = true; return; }

            const movePower = move.power || 40;
            const moveType = move.type || 'normal';
            const typeMod = this.getTypeMultiplier(moveType, b.opponent.types);

            const damage = this.calculateDamage(b.playerPoke.stats.attack, b.opponent.stats.defense, movePower, b.playerPoke.level || 5, typeMod);
            b.opponent.currentHp = Math.max(0, b.opponent.currentHp - damage);
            
            let logMsg = `${b.playerPoke.nickname || b.playerPoke.name}의 ${moveName}! ${damage}의 데미지!`;
            // 상성 로그 추가
            if (typeMod >= 2) logMsg += " 효과가 굉장했다!!";
            else if (typeMod > 0 && typeMod < 1) logMsg += " 효과가 별로인 듯하다...";
            else if (typeMod === 0) logMsg += " 효과가 없는 것 같다...";
            
            game.ui.log(logMsg);
            game.ui.updateBattleUI();
            
            if (b.type === 'pvp') {
                // PvP일 경우 상대방에게 액션 전송
                game.network.send({ type: 'turn_action', opponentId: b.opponentId, action: { type: 'attack', move: moveName, damage: damage } });
                game.ui.renderMoveButtons(); // 버튼 비활성화 (순서 대기)
                
                if (b.opponent.currentHp <= 0) {
                    game.ui.log("대전에서 승리했습니다!");
                    game.network.send({ type: 'battle_result', winnerId: game.state.player.id, loserId: b.opponentId, winnerName: game.state.player.name, loserName: b.opponentPlayerName });
                    setTimeout(() => this.endBattle(true), 1500);
                }
                return;
            }

            if (b.opponent.currentHp <= 0) {
                const spAtk = b.opponent.stats['special-attack'] || b.opponent.stats['attack'] || 50;
                const expGain = Math.floor(spAtk * b.opponent.level / 7);
                game.ui.log(`야생 ${b.opponent.name}이(가) 쓰러졌다! 경험치 ${expGain} 획득!`);

                // checkLevelUp 내부에서 savePlayerData를 한 번만 호출하도록 함
                await game.checkLevelUp(b.playerPoke, expGain);

                setTimeout(() => this.endBattle(true), 1500);
                return;
            }

            setTimeout(() => this.opponentTurn(), 1000);
        },

        opponentTurn() {
            const b = game.state.currentBattle;
            if (!b) return;

            // 기술 목록이 없을 경우 대비
            const moves = (b.opponent.moves && b.opponent.moves.length > 0) ? b.opponent.moves : ['tackle'];
            const oppMove = moves[Math.floor(Math.random() * moves.length)];
            
            const oppMoveName = oppMove.name || oppMove;
            const oppMovePower = oppMove.power || 35;
            const oppMoveType = oppMove.type || 'normal';
            const oppTypeMod = this.getTypeMultiplier(oppMoveType, b.playerPoke.types);
            const oppDamage = this.calculateDamage(b.opponent.stats.attack, b.playerPoke.stats.defense, oppMovePower, b.opponent.level, oppTypeMod);
            
            b.playerPoke.currentHp = Math.max(0, (b.playerPoke.currentHp || b.playerPoke.stats.hp) - oppDamage);
            
            let logMsg = `야생 ${b.opponent.name}의 ${oppMoveName}! ${oppDamage}의 데미지!`;
            if (oppTypeMod >= 2) logMsg += " 효과가 굉장했다!!";
            else if (oppTypeMod > 0 && oppTypeMod < 1) logMsg += " 효과가 별로인 듯하다...";
            
            game.ui.log(logMsg);
            game.ui.updateBattleUI();

            if (b.playerPoke.currentHp <= 0) {
                game.ui.log(`${b.playerPoke.nickname || b.playerPoke.name}이(가) 쓰러졌다...`);
                const aliveIndex = game.state.player.team.findIndex(p => p !== b.playerPoke && (p.currentHp || p.stats.hp) > 0);
                if (aliveIndex >= 0) setTimeout(() => game.ui.showForcedSwitch(), 800);
                else setTimeout(() => this.endBattle(false), 1500);
            } else {
                b.isPlayerTurn = true;
                game.ui.renderMoveButtons();
            }
        },

        tryCatch() {
            const b = game.state.currentBattle;
            if (!b || !b.isPlayerTurn || b.type !== 'wild') return;
            b.isPlayerTurn = false;
            b.catchAttempts++;

            game.ui.log(`포켓볼을 던졌다!`);

            const hpRatio    = b.opponent.currentHp / b.opponent.stats.hp;
            const baseCatch  = 0.25 + (1 - hpRatio) * 0.5;
            const attemptBonus = Math.min(0.1, b.catchAttempts * 0.02);
            const catchRate  = Math.min(0.75, baseCatch + attemptBonus);
            const success    = Math.random() < catchRate;

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
                    setTimeout(() => this.opponentTurn(), 800);
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
                setTimeout(() => this.opponentTurn(), 1000);
            }
        },

        // 상대방의 액션 처리
        async handleOpponentAction(action) {
            const b = game.state.currentBattle;
            if (!b || b.type !== 'pvp') return;

            if (action.type === 'attack') {
                // This is where the opponent's action (from server) is processed
                // The server sends the damage, so we just apply it and update UI
                const damage = action.damage || 0;
                const playerPoke = b.playerPoke;
                playerPoke.currentHp = Math.max(0, (playerPoke.currentHp || playerPoke.stats.hp) - damage);

                let logMsg = `상대 ${b.opponent.name}의 ${action.move}! ${damage}의 데미지!`;
                if (action.isCrit) logMsg += " 치명타!";
                if (action.typeMod > 1) logMsg += " 효과가 굉장했다!";
                if (action.typeMod < 1 && action.typeMod > 0) logMsg += " 효과가 별로인 듯하다...";
                if (action.typeMod === 0) logMsg += " 효과가 없는 것 같다...";
                game.ui.log(logMsg);
                game.ui.updateBattleUI();

                if (action.statusApplied && !playerPoke.status) {
                    playerPoke.status = action.statusApplied;
                    if (playerPoke.status === 'sleep') {
                        playerPoke.statusTurns = Math.floor(Math.random() * (game.state.statusEffects.sleep.maxTurns - game.state.statusEffects.sleep.minTurns + 1)) + game.state.statusEffects.sleep.minTurns;
                    }
                    game.ui.log(`${playerPoke.nickname || playerPoke.name}은(는) ${game.state.statusEffects[playerPoke.status].name}에 걸렸다!`);
                }

                if (playerPoke.currentHp <= 0) {
                    game.ui.log("패배했습니다...");
                    setTimeout(() => this.endBattle(false), 1500);
                } else {
                    b.isPlayerTurn = true;
                    game.ui.renderMoveButtons();
                }
            }
        },

        applyStatusDamage(pokemon) {
            if (!pokemon.status) return;
            const effect = game.state.statusEffects[pokemon.status];
            if (effect && effect.damagePerTurn) {
                const dmg = Math.floor(pokemon.stats.hp * effect.damagePerTurn);
                if (dmg > 0) {
                    pokemon.currentHp = Math.max(0, pokemon.currentHp - dmg);
                    game.ui.log(`${pokemon.nickname || pokemon.name}은(는) ${effect.name} 데미지를 입었다!`);
                }
            }
        },

        checkStatusBeforeTurn(pokemon) {
            if (!pokemon.status) return false;
            const effect = game.state.statusEffects[pokemon.status];
            
            if (pokemon.status === 'sleep') {
                pokemon.statusTurns--;
                if (pokemon.statusTurns <= 0) {
                    pokemon.status = null;
                    game.ui.log(`${pokemon.nickname || pokemon.name}은(는) 잠에서 깨어났다!`);
                    return false;
                }
                game.ui.log(`${pokemon.nickname || pokemon.name}은(는) 깊은 잠에 빠져 있다...`);
                return true;
            }
            if (pokemon.status === 'paralysis' && Math.random() < effect.chanceToSkipTurn) {
                game.ui.log(`${pokemon.nickname || pokemon.name}은(는) 몸이 저려 움직일 수 없다!`);
                return true;
            }
            if (pokemon.status === 'freeze') {
                if (Math.random() < effect.chanceToThaw) {
                    pokemon.status = null;
                    game.ui.log(`${pokemon.nickname || pokemon.name}의 얼음이 녹았다!`);
                    return false;
                }
                game.ui.log(`${pokemon.nickname || pokemon.name}은(는) 얼어붙어 움직일 수 없다!`);
                return true;
            }
            return false;
        },

        getTypeMultiplier(moveType, targetTypes) {
            let multiplier = 1;
            targetTypes.forEach(tType => {
                const mod = game.state.typeChart[moveType]?.[tType];
                if (mod !== undefined) multiplier *= mod;
            });
            return multiplier;
        },

        calculateDamage(atk, def, movePower, level, typeMod, isSTAB, isCrit, attackerStatus) {
            const random  = 0.85 + Math.random() * 0.15;
            const levelMod = (level || 5) / 50;
            const safeDef  = def || 1;

            let finalAtk = atk;
            if (attackerStatus === 'burn' && game.state.statusEffects.burn.attackModifier) {
                finalAtk *= game.state.statusEffects.burn.attackModifier;
            }

            let damage = Math.max(1, Math.floor((finalAtk / safeDef) * movePower * typeMod * random * (1 + levelMod)));

            if (isSTAB) damage = Math.floor(damage * 1.5); // STAB bonus
            if (isCrit) damage = Math.floor(damage * 1.5); // Critical hit bonus (standard is 1.5x in modern games)

            return damage;
        },

        endBattle(isWin) {
            const b = game.state.currentBattle;
            if (!b) return;
            
            // 즉시 턴을 잠궈서 중복 클릭 방지
            b.isPlayerTurn = false;

            if (isWin !== null && game.state.player && isWin !== undefined) {
                // 판수 증가
                game.state.player.totalGames = (game.state.player.totalGames || 0) + 1;
                
                // PvP 승리 시에만 돈 지급 (야생 포켓몬 제외)
                if (isWin && b.type === 'pvp') {
                    const reward = 200 + Math.floor(Math.random() * 201);
                    game.state.player.money = (game.state.player.money || 0) + reward;
                    game.ui.showToast(`PvP 승리! ${reward}$ 획득!`);
                }

                // 출전한 포켓몬 중 메가진화 상태인 것들의 남은 게임 수 차감
                if (b.participants) {
                    b.participants.forEach(p => {
                        if (p.isMega) {
                            p.megaGames = (p.megaGames || 0) + 1;
                            if (p.megaGames >= 10) {
                                this._revertMega(p);
                            }
                        }
                    });
                }
            }

            game.state.currentBattle = null;
            if (game.state.player) {
                game.state.player.team.forEach(p => { if (!p.currentHp || p.currentHp <= 0) p.currentHp = p.stats.hp; });
                game.db.savePlayerData(game.state.player); // 비동기 저장 시작
            }
            game.ui.showBattleScene(false);
            game.ui.renderActiveTab();
        },

        async _revertMega(p) {
            const originalData = await game.fetchPokemon(p.originalId);
            if (!originalData) return;
            
            p.id = originalData.id;
            p.name = p.originalName || originalData.name;
            p.nameEn = originalData.nameEn;
            p.stats = originalData.stats;
            p.spriteUrls = originalData.spriteUrls;
            p.spriteUrl = originalData.spriteUrls[0];
            
            p.isMega = false;
            delete p.megaGames;
            delete p.originalId;
            delete p.originalName;
            
            game.ui.showToast(`${p.name}의 메가진화가 해제되었습니다.`);
        },
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
                    if (data.type === 'player_list') {
                        game.state.onlinePlayers = data.players;
                        if (game.state.activeTab === 'pvp') game.ui.renderActiveTab();
                    }
                    if (data.type === 'challenged') {
                        game.ui.showChallengeModal(data.challengerId, data.challengerName, data.challengerTeam);
                    }
                    if (data.type === 'accepted') {
                        game.battle.startPvpBattle(data.opponentId, data.opponentName, data.opponentTeam, true);
                    }
                    if (data.type === 'turn_action') {
                        game.battle.handleOpponentAction(data.action);
                    }
                    if (data.type === 'ranking_update') {
                        game.state.rankings = data.ranking;
                        if (game.state.activeTab === 'rank') game.ui.renderActiveTab();
                    }
                    if (data.type === 'opponent_disconnected') {
                        game.ui.log("상대방의 연결이 끊겼습니다. 승리 처리됩니다!");
                        const b = game.state.currentBattle;
                        if (b) {
                            game.network.send({ 
                                type: 'battle_result', winnerId: game.state.player.id, loserId: b.opponentId, 
                                winnerName: game.state.player.name, loserName: b.opponentPlayerName 
                            });
                            setTimeout(() => game.battle.endBattle(true), 2000);
                        }
                    }
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
            const idx = ['wild','pvp','team','pokedex','rank','box'].indexOf(tab);
            if (idx >= 0) document.querySelectorAll('#tab-bar button')[idx]?.classList.add('active');
            this.renderActiveTab();
        },

        renderActiveTab() {
            const vp = document.getElementById('view-port');
            if (!vp) return;
            const tab = game.state.activeTab;
            if (tab === 'wild')         this.renderWildTab(vp);
            else if (tab === 'team')    this.renderTeamTab(vp);
            else if (tab === 'pokedex') this.renderPokedexTab(vp);
            else if (tab === 'pvp')     this.renderPvpTab(vp);
            else if (tab === 'rank')    this.renderRankTab(vp);
            else if (tab === 'box')     this.renderBoxTab(vp);
        },

        getSpriteHtml(poke, className) {
            return `<img class="${className}" alt="${poke.name}" data-poke-id="${poke.id}" data-poke-type="official" style="visibility:hidden">`;
        },

        applySprites(container) {
            const imgs = (container || document).querySelectorAll('img[data-poke-id]');
            imgs.forEach(img => {
                const id     = parseInt(img.dataset.pokeId, 10);
                const cached = game.state.pokeCache[id];
                const urls   = (cached && cached.spriteUrls) || game.getSpriteUrls(id);
                game.ui.loadSprite(img, urls);
            });
        },

        renderWildTab(container) {
            const player  = game.state.player;
            const team    = player?.team || [];
            const leadPoke= team[0];
            const pLv     = leadPoke?.level || 5;

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
                            <div class="player-stats-bar">
                                <div class="stat-item">💰 <strong>${player.money || 0}</strong></div>
                                <div class="stat-item">🎮 <strong>${player.totalGames || 0}</strong> Games</div>
                            </div>
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
                            <div class="team-card type-bg-${p.types?.[0] || 'normal'}" onclick="game.ui.showPokeDetail(${i})">
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
                                            ${p.status ? `
                                                <span class="status-badge type-${p.status}">${game.state.statusEffects[p.status].name}</span>
                                            ` : ''}
                                            ${(p.moves || []).map(m => {
                                                const name = m.name || m;
                                                const type = m.type || 'normal';
                                                return `<span class="move-chip type-${type}">${name}</span>`;
                                            }).join('')}
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
            const allPokes = (game.state.player?.team || []).concat(game.state.player?.box || []);
            const caught   = new Set(allPokes.map(p => p.id));
            container.innerHTML = `
                <div class="tab-content pokedex-tab">
                    <h2 class="tab-title pixel">포켓도감</h2>
                    <p class="dex-count">발견: ${caught.size} / 493</p>
                    <div class="dex-grid">
                        ${Array.from({length: 493}, (_, i) => i + 1).map(id => {
                            const cached   = game.state.pokeCache[id];
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

        renderBoxTab(container) {
            const box = game.state.player?.box || [];
            container.innerHTML = `
                <div class="tab-content box-tab">
                    <h2 class="tab-title pixel">포켓몬 박스</h2>
                    <p class="box-count">보관 중: ${box.length}마리</p>
                    <div class="box-grid">
                        ${box.length === 0 ? '<p class="empty-hint">박스가 비어있습니다.</p>' : ''}
                        ${box.map((p, i) => `
                            <div class="box-item type-bg-${p.types?.[0] || 'normal'}" onclick="game.ui._showBoxSwapMenu(${i})">
                                ${this.getSpriteHtml(p, 'box-mini-sprite')}
                                <div class="box-item-info">
                                    <span class="box-item-name">${p.nickname || p.name}</span>
                                    <span class="box-item-lv">Lv.${p.level || 1}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            game.ui.applySprites(container);
        },

        _showBoxSwapMenu(boxIndex) {
            const boxPoke = game.state.player.box[boxIndex];
            const team = game.state.player.team;
            
            const existing = document.getElementById('box-swap-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'box-swap-overlay';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal-content box-swap-modal">
                    <h3 class="pixel">박스 관리</h3>
                    <div class="selected-box-poke">
                        <img data-poke-id="${boxPoke.id}" style="width:64px;height:64px">
                        <p><strong>${boxPoke.nickname || boxPoke.name}</strong> (Lv.${boxPoke.level})</p>
                    </div>
                    
                    <div class="swap-options">
                        <p class="swap-label">팀으로 데려오기:</p>
                        ${team.length < 6 ? `
                            <button class="swap-btn add-to-team" onclick="game.ui._doBoxSwap(${boxIndex}, -1)">빈 자리에 추가</button>
                        ` : ''}
                        <div class="team-swap-list">
                            ${team.map((p, i) => `
                                <button class="swap-btn" onclick="game.ui._doBoxSwap(${boxIndex}, ${i})">
                                    ${p.nickname || p.name} (Lv.${p.level})와 교체
                                </button>
                            `).join('')}
                        </div>
                    </div>
                    <button class="modal-close-btn" onclick="document.getElementById('box-swap-overlay').remove()">취소</button>
                </div>
            `;
            document.body.appendChild(overlay);
            game.ui.applySprites(overlay);
        },

        _doBoxSwap(boxIndex, teamIndex) {
            const player = game.state.player;
            const boxPoke = player.box[boxIndex];
            
            if (teamIndex === -1) {
                // 빈 자리 추가 (팀이 6마리 미만일 때)
                player.team.push(boxPoke);
                player.box.splice(boxIndex, 1);
            } else {
                // 기존 팀원과 교체
                const teamPoke = player.team[teamIndex];
                player.team[teamIndex] = boxPoke;
                player.box[boxIndex] = teamPoke;
            }

            game.db.savePlayerData(player);
            document.getElementById('box-swap-overlay').remove();
            game.ui.showToast('팀 구성이 변경되었습니다!');
            this.renderActiveTab();
        },

        renderPvpTab(container) {
            const players = game.state.onlinePlayers || [];
            const me = game.state.player;
            container.innerHTML = `
                <div class="tab-content pvp-tab">
                    <h2 class="tab-title pixel">트레이너 대전</h2>
                    <div class="player-list">
                        ${players.filter(p => p.id !== me.id).map(p => `
                            <div class="player-item">
                                <div class="p-info">
                                    <span class="p-name">${p.name}</span>
                                    <span class="p-status ${p.status}">${p.status === 'online' ? '대기 중' : '전투 중'}</span>
                                </div>
                                <button class="btn-challenge pixel" ${p.status !== 'online' ? 'disabled' : ''} 
                                    onclick="game.network.send({type:'challenge', targetId:'${p.id}'})">도전장 발송</button>
                            </div>
                        `).join('')}
                        ${players.length <= 1 ? '<p class="empty-hint">현재 접속 중인 다른 트레이너가 없습니다.</p>' : ''}
                    </div>
                </div>
            `;
        },

        renderRankTab(container) {
            const ranks = game.state.rankings || [];
            container.innerHTML = `
                <div class="tab-content rank-tab">
                    <h2 class="tab-title pixel">명예의 전당</h2>
                    <div class="rank-list">
                        <div class="rank-header">
                            <span>순위</span><span>이름</span><span>승/패</span><span>승률</span>
                        </div>
                        ${ranks.map((r, i) => `
                            <div class="rank-item ${i < 3 ? 'top-rank' : ''}">
                                <span class="r-pos">${i + 1}</span>
                                <span class="r-name">${r.playerName}</span>
                                <span class="r-record">${r.win}승 ${r.lose}패</span>
                                <span class="r-rate">${r.winRate}%</span>
                            </div>
                        `).join('')}
                        ${ranks.length === 0 ? '<p class="empty-hint">아직 랭킹 정보가 없습니다.</p>' : ''}
                    </div>
                </div>
            `;
        },

        showChallengeModal(challengerId, challengerName, challengerTeam) {
            const existing = document.getElementById('challenge-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'challenge-overlay';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal-content challenge-modal">
                    <h3 class="pixel">${challengerName} 트레이너가 대전을 신청했습니다!</h3>
                    <div class="challenger-preview">
                        <img data-poke-id="${challengerTeam[0].id}" style="width:64px;height:64px">
                        <p>${challengerTeam[0].nickname || challengerTeam[0].name} (Lv.${challengerTeam[0].level})</p>
                    </div>
                    <div class="modal-btns">
                        <button class="pixel accept" onclick="game.ui._acceptChallenge('${challengerId}', '${challengerName}', ${JSON.stringify(challengerTeam).replace(/"/g, '&quot;')})">수락</button>
                        <button class="pixel decline" onclick="document.getElementById('challenge-overlay').remove()">거절</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            game.ui.applySprites(overlay);
        },

        _acceptChallenge(challengerId, challengerName, challengerTeam) {
            document.getElementById('challenge-overlay').remove();
            game.network.send({ type: 'accept', challengerId });
            game.battle.startPvpBattle(challengerId, challengerName, challengerTeam, false);
        },

        // ── 진화 연출 ──────────────────────────────
        showEvolutionEffect(prevName, pokemon) {
            const existing = document.getElementById('evo-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'evo-overlay';
            overlay.className = 'modal-overlay evo-overlay';
            overlay.innerHTML = `
                <div class="evo-content">
                    <div class="evo-flash"></div>
                    <div class="evo-title pixel">진화!</div>
                    <div class="evo-names">${prevName} → ${pokemon.name}</div>
                    <img class="evo-sprite" alt="${pokemon.name}" data-poke-id="${pokemon.id}" style="visibility:hidden" />
                    <div class="evo-types">
                        ${pokemon.types.map(t => `<span class="type-badge type-${t}">${t}</span>`).join('')}
                    </div>
                    <button class="evo-close-btn pixel" onclick="document.getElementById('evo-overlay').remove()">확인</button>
                </div>
            `;
            document.body.appendChild(overlay);
            game.ui.applySprites(overlay);
            game.ui.showToast(`${prevName}이(가) ${pokemon.name}(으)로 진화했다!`);

            // 배틀 중이면 UI 업데이트
            if (game.state.currentBattle) {
                game.ui.updateBattleUI();
                game.ui.renderMoveButtons();
            }
        },

        _showMoveLearnPrompt(pokemon, newMove) {
            const existing = document.getElementById('move-learn-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'move-learn-overlay';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal-content move-learn-modal">
                    <h3 class="pixel">${pokemon.nickname || pokemon.name}이(가) 새 기술을 배우려 한다!</h3>
                    <p class="new-move-name">✨ <strong>${newMove.name}</strong> (타입: ${newMove.type.toUpperCase()} / 위력: ${newMove.power})</p>
                    <p class="move-learn-sub">기술을 4개 이상 배울 수 없다. 잊을 기술을 선택하거나 포기하세요.</p>
                    <div class="move-forget-list">
                        ${(pokemon.moves || []).map((m) => `
                            <button class="move-forget-btn type-${m.type || 'normal'}" onclick="game.ui._confirmForgetMove('${m.name}', '${newMove.name}', '${pokemon.nickname || pokemon.name}')">
                                [${m.type.toUpperCase()}] ${m.name} 을(를) 잊기
                            </button>
                        `).join('')}
                        <button class="move-forget-btn cancel" onclick="document.getElementById('move-learn-overlay').remove()">
                            ${newMove.name} 배우지 않기
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
                status: null,
                statusTurns: 0,
            };
            game.state.player.team.push(newPoke);
            game.db.savePlayerData(game.state.player);

            const overlay = document.getElementById('starter-overlay');
            if (overlay) overlay.remove();

            this.showToast(`${newPoke.nickname}와(과) 함께 모험을 시작합니다!`);
            this.renderActiveTab();
        },

        showBattleScene(show) {
            const scene = document.getElementById('battle-scene');
            if (scene) scene.classList.toggle('hidden', !show);
            if (show) {
                this.renderMoveButtons();
                const catchBtn = document.getElementById('btn-catch');
                const runBtn   = document.getElementById('btn-run');
                if (catchBtn) catchBtn.onclick = () => game.battle.tryCatch();
                if (runBtn)   runBtn.onclick   = () => game.battle.tryRun();
            }
        },

        showPokeDetail(index) {
            const p = game.state.player.team[index];
            if (!p) return;

            const existing = document.getElementById('detail-overlay');
            if (existing) existing.remove();

            const hpPct = (p.currentHp / p.stats.hp) * 100;
            const isMega = p.nameEn.includes('-mega');
            const canMega = (game.state.player.totalGames >= 5) && !isMega;
            const megaCost = 2000;
            
            const overlay = document.createElement('div');
            overlay.id = 'detail-overlay';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal-content detail-modal type-bg-${p.types[0]}">
                    <div class="detail-header">
                        <div class="detail-id">#${String(p.id).padStart(3, '0')}</div>
                        ${this.getSpriteHtml(p, 'detail-sprite')}
                        <div class="detail-main-info">
                            <span class="detail-name">${p.nickname || p.name} ${isMega ? '<span class="mega-tag">MEGA</span>' : ''}</span>
                            ${isMega ? `<div class="mega-remaining">해제까지: ${10 - (p.megaGames || 0)}게임</div>` : ''}
                            <div class="type-badges" style="justify-content: center; margin-top: 5px;">
                                ${p.types.map(t => `<span class="type-badge type-${t}">${t}</span>`).join('')}
                            </div>
                        </div>
                    </div>

                    <div class="detail-section-title">BASE STATS</div>
                    <div class="detail-stats-grid">
                        ${Object.entries(p.stats).map(([sName, sVal]) => `
                            <div class="stat-row">
                                <span style="width: 80px; text-transform: uppercase;">${sName.replace('-', ' ')}</span>
                                <div class="stat-bar-track">
                                    <div class="stat-bar-fill" style="width: ${Math.min(100, sVal / 2)}%; background: ${sName === 'hp' ? '#4caf50' : '#e94560'}"></div>
                                </div>
                                <span style="width: 30px; text-align: right;">${sVal}</span>
                            </div>
                        `).join('')}
                    </div>

                    <div class="detail-section-title">MOVES</div>
                    <div class="detail-move-grid">
                        ${(p.moves || []).map(m => `
                            <div class="detail-move-item">
                                <span class="m-name">${m.name || m}</span>
                                <span class="m-info">${m.type?.toUpperCase() || 'NORMAL'} / P:${m.power || 40}</span>
                            </div>
                        `).join('')}
                    </div>

                    ${canMega ? `
                        <button class="mega-evolve-btn" 
                            ${game.state.player.money < megaCost ? 'disabled' : ''} 
                            onclick="game.ui._doMegaEvolution(${index})">
                            ${game.state.player.money < megaCost ? `금액 부족 (${megaCost}$ 필요)` : '메가진화의 돌 구매 (2000$)'}
                        </button>
                    ` : ''}

                    <button class="switch-cancel-btn" style="margin-top: 20px;" onclick="document.getElementById('detail-overlay').remove()">닫기</button>
                </div>
            `;
            document.body.appendChild(overlay);
            this.applySprites(overlay);
        },

        async _doMegaEvolution(index) {
            const player = game.state.player;
            const p = player.team[index];
            const megaCost = 2000;

            if (player.money < megaCost) return;

            game.ui.showToast('메가진화 시퀀스 가동...');
            
            // 메가진화 데이터 가져오기 (이름 뒤에 -mega를 붙여 시도)
            const megaData = await game.fetchPokemon(`${p.nameEn}-mega`);
            if (!megaData) {
                game.ui.showToast('이 포켓몬은 메가진화가 불가능합니다.');
                return;
            }

            player.money -= megaCost;
            p.originalId = p.id;
            p.originalName = p.name;
            p.id = megaData.id;
            p.name = "메가" + p.name;
            p.nameEn = megaData.nameEn;
            p.stats = megaData.stats;
            p.spriteUrls = megaData.spriteUrls;
            p.spriteUrl = megaData.spriteUrls[0];
            p.isMega = true;
            p.megaGames = 0;

            game.db.savePlayerData(player);
            document.getElementById('detail-overlay').remove();
            game.ui.showEvolutionEffect(p.nickname, p);
        },

        updateBattleUI() {
            const b = game.state.currentBattle;
            if (!b) return;
            const opp = b.opponent;
            const pp  = b.playerPoke;

            document.getElementById('opp-name').textContent = opp.name;
            document.getElementById('opp-lv').textContent   = `Lv.${opp.level}`;
            const oppHpPct = Math.max(0, (opp.currentHp / opp.stats.hp) * 100);
            const oppStatus = opp.status ? `<span class="status-text type-${opp.status}">${game.state.statusEffects[opp.status].name}</span>` : '';
            document.getElementById('opp-name').innerHTML = `${opp.name} ${oppStatus}`;

            document.getElementById('opp-hp-fill').style.width      = oppHpPct + '%';
            document.getElementById('opp-hp-fill').style.background = oppHpPct > 50 ? '#4caf50' : oppHpPct > 20 ? '#ff9800' : '#f44336';
            game.ui.loadSprite(document.getElementById('opp-sprite'), opp.spriteUrls || game.getSpriteUrls(opp.id));

            document.getElementById('p-name').textContent = pp.nickname || pp.name;
            document.getElementById('p-lv').textContent   = `Lv.${pp.level || 1}`;
            const ppHpPct = Math.max(0, ((pp.currentHp || pp.stats.hp) / pp.stats.hp) * 100);
            const playerStatus = pp.status ? `<span class="status-text type-${pp.status}">${game.state.statusEffects[pp.status].name}</span>` : '';
            document.getElementById('p-name').innerHTML = `${pp.nickname || pp.name} ${playerStatus}`;

            document.getElementById('p-hp-fill').style.width      = ppHpPct + '%';
            document.getElementById('p-hp-fill').style.background = ppHpPct > 50 ? '#4caf50' : ppHpPct > 20 ? '#ff9800' : '#f44336';
            game.ui.loadSprite(document.getElementById('player-sprite'), pp.spriteUrls || game.getSpriteUrls(pp.id));
        },

        loadSprite(imgEl, urls) {
            if (!imgEl || !urls || !urls.length) return;
            
            let currentIdx = 0;
            imgEl.style.visibility = 'hidden'; // 로딩 전엔 숨김
            
            imgEl.onerror = () => {
                currentIdx++;
                if (currentIdx < urls.length) {
                    imgEl.src = urls[currentIdx];
                }
            };
            imgEl.onload = () => {
                imgEl.style.visibility = 'visible';
            };
            
            imgEl.src = urls[currentIdx];
        },

        renderMoveButtons() {
            const b = game.state.currentBattle;
            const moveList = document.getElementById('move-list');
            if (!moveList || !b) return;
            const moves = b.playerPoke.moves || [];
            moveList.innerHTML = moves.map(m => {
                const name = m.name || m;
                const type = m.type || 'normal';
                const pwr  = m.power || 40;
                return `<button class="move-btn type-${type}" ${!b.isPlayerTurn ? 'disabled' : ''} onclick="game.battle.useMove('${name}')" title="정확도: ${m.accuracy || 100}%">
                    <span class="m-name">${name}</span>
                    <span class="m-info">${type.toUpperCase()} / P:${pwr}</span>
                </button>`;
            }).join('');

            const subMenu = document.getElementById('sub-menu');
            if (subMenu && !document.getElementById('btn-switch')) {
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
        },

        showSwitchMenu() {
            const b = game.state.currentBattle;
            if (!b) return;
            const team  = game.state.player.team;
            const alive = team.filter(p => p !== b.playerPoke && (p.currentHp || p.stats.hp) > 0);
            if (alive.length === 0) {
                game.ui.showToast('교체할 포켓몬이 없습니다!');
                b.isPlayerTurn = true;
                game.ui.renderMoveButtons();
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
                            const hp       = p.currentHp ?? p.stats.hp;
                            const maxHp    = p.stats.hp;
                            const isCurrent= p === b.playerPoke;
                            const isDead   = hp <= 0;
                            const hpPct    = Math.max(0, (hp / maxHp) * 100);
                            const hpColor  = hpPct > 50 ? '#4caf50' : hpPct > 20 ? '#ff9800' : '#f44336';
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
                    <button class="switch-cancel-btn" onclick="document.getElementById('switch-overlay').remove(); game.state.currentBattle.isPlayerTurn=true; game.ui.renderMoveButtons();">
                        취소
                    </button>
                </div>
            `;
            document.body.appendChild(overlay);
            game.ui.applySprites(overlay);
        },

        showForcedSwitch() {
            const b = game.state.currentBattle;
            if (!b) return;
            const team = game.state.player.team;

            const hasAlive = team.some(p => p !== b.playerPoke && (p.currentHp ?? p.stats.hp) > 0);
            if (!hasAlive) {
                setTimeout(() => game.battle.endBattle(false), 500);
                return;
            }
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
                            const hp       = p.currentHp ?? p.stats.hp;
                            const maxHp    = p.stats.hp;
                            const isDead   = hp <= 0;
                            const hpPct    = Math.max(0, (hp / maxHp) * 100);
                            const hpColor  = hpPct > 50 ? '#4caf50' : hpPct > 20 ? '#ff9800' : '#f44336';
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

        _doSwitch(teamIndex, isForced) {
            const b = game.state.currentBattle;
            if (!b) return;
            const overlay = document.getElementById('switch-overlay');
            if (overlay) overlay.remove();

            const newPoke = game.state.player.team[teamIndex];
            if (!newPoke) {
                game.ui.log("교체할 포켓몬을 찾을 수 없습니다."); return;
            }

            b.playerPoke = newPoke;
            if (b.participants) b.participants.add(newPoke);
            game.ui.log(`${newPoke.nickname || newPoke.name}! 가랏!`);
            game.ui.updateBattleUI();
            game.ui.renderMoveButtons();

            if (!isForced) {
                b.isPlayerTurn = false;
                setTimeout(() => {
                    // Opponent's turn after player switches
                    this.opponentTurn();
                }, 1000);
            } else {
                b.isPlayerTurn = true;
            }
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

    // ★ 서버에서 불러오기 (비동기)
    let player = await game.db.getPlayerData(id);
    if (!player) { // If player doesn't exist, it's a new registration
        player = {
            id: crypto.randomUUID(),
            name: id,
            pw: pw, // Storing password directly as per user's instruction to ignore security
                team: [], box: [], pokedex: [], badges: [],
                money: 0,
                totalGames: 0,
            lastLogin: new Date().toISOString()
        };
        game.ui.showToast(`${id}님, 새로운 계정이 생성되었습니다!`);
    } else {
        if (player.pw !== pw) {
            game.ui.showToast("비밀번호가 일치하지 않습니다.");
            return;
        }
        player.lastLogin = new Date().toISOString();
        game.ui.showToast(`${id}님, 환영합니다!`);
    }

    // 로그인 정보 로컬 스토리지 저장 (자동 로그인용)
    localStorage.setItem('pokesave_user', id);
    localStorage.setItem('pokesave_pw', pw);

    await game.db.savePlayerData(player);
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

// 페이지 로드 시 자동 로그인 확인
window.addEventListener('DOMContentLoaded', () => {
    const savedId = localStorage.getItem('pokesave_user');
    const savedPw = localStorage.getItem('pokesave_pw');
    
    if (savedId && savedPw) {
        const idInput = document.getElementById('login-id');
        const pwInput = document.getElementById('login-pw');
        if (idInput && pwInput) {
            idInput.value = savedId;
            pwInput.value = savedPw;
            // 지맘대로 로그인되는 것 방지: 
            // 사용자가 등록/로그인 버튼을 직접 누르도록 호출부 제거
            // setTimeout(() => game.auth.login(), 500); 
        }
    }
});

// ── game 객체 밖 ──────────────────────────────
function pokeFallback(img) {
    const id = img.dataset.id;
    const fb = parseInt(img.dataset.fb || '0', 10);
    if (!id) { img.style.display = 'none'; return; }
    const base = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
    if (fb === 0) {
        img.dataset.fb = '1';
        img.src = `${base}/${id}.png`;
    } else if (fb === 1) {
        img.dataset.fb = '2';
        img.src = `${base}/other/showdown/${id}.gif`;
    } else {
        img.style.display = 'none';
    }
}
