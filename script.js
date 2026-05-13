const game = {
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
            localStorage.setItem('player_data', JSON.stringify(data));
        }
    },

    // --- 2. PokeAPI 호출 (캐시 우선 방식) ---
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

    // --- 3. 전투 시스템 (데미지 계산기) ---
    battle: {
        calculateDamage(atk, def, movePower, level, typeMod) {
            // 공식: floor((공/방) * 위력 * 상성 * 랜덤 * 레벨보정)
            const random = 0.85 + Math.random() * 0.15;
            const levelMod = level / 50;
            return Math.floor((atk / def) * movePower * typeMod * random * levelMod);
        },
        
        checkEvolution(p) {
            if (p.level >= 40) {
                // 특정 레벨 도달 시 진화 로직 실행
                alert(`${p.nickname}이(가) 진화할 수 있습니다!`);
            }
        }
    },

    // --- 4. 로그인 및 인증 ---
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
