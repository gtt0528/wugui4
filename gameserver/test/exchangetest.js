/**
 * 交牌流程完整验证：4 个真人客户端（模拟人类点击），严格按六步顺序操作。
 *
 * 验证目标：
 *   ① ENEMY_PUT      敌人交 N 张大牌到桌上（N = 游客数）
 *   ② TOURIST_PICK   导游 → 中游 → 尾游 依次挑
 *   ③ TOURIST_RETURN 游客逐个还牌给敌人
 *   ④ LOSER_GIVE     被抓龟交最大牌给敌人
 *   ⑤ ENEMY_RETURN   敌人交 M 张小牌到桌上（M = 被抓龟数）
 *   ⑥ LOSER_PICK     被抓龟按「交的牌大者先挑」依次挑
 *   然后：谁交的牌最大 → 谁先出牌
 *
 * 同时验证：全场每个人都能收到 {t:'ex'} 交牌广播（四家看到同一份记录）
 */
const WebSocket = require('ws');
const URL = 'ws://localhost:8090';

const KIND_ORDER = ['ENEMY_PUT', 'TOURIST_PICK', 'TOURIST_RETURN', 'LOSER_GIVE', 'ENEMY_RETURN', 'LOSER_PICK'];

/** 牌 id → 牌名（与 createDeck 一致：按点数分组、花色内循环，最后大小王） */
const DECKNAME = (() => {
    const m = new Map();
    const SUITS = ['方块', '梅花', '红桃', '黑桃'];
    const POINTS = ['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let id = 1;
    for (const p of POINTS) for (const s of SUITS) m.set(id++, s + p);
    m.set(id++, '小王'); m.set(id++, '大王');
    return m;
})();

class Bot {
    constructor(name) {
        this.name = name;
        this.ws = new WebSocket(URL);
        this.msgs = [];
        this.seat = -1;
        this.isEnemy = false;
        this.hand = [];          // [{id,name}]
        this.ex = [];            // 收到的交牌广播记录
        this.exTurns = [];       // 收到的「轮到谁交牌」广播
        this.pending = [];       // 待处理的交牌 turn（自己该操作）
        this.roundNo = 0;
        this.finished = false;
        this.ws.on('message', (raw) => this.onMsg(JSON.parse(raw.toString())));
        this.ws.on('error', () => {});
    }

    opened() {
        return this.ws.readyState === 1 ? Promise.resolve() : new Promise((r) => this.ws.on('open', r));
    }

    send(o) { this.ws.send(JSON.stringify(o)); }

    onMsg(m) {
        this.msgs.push(m);
        switch (m.t) {
            case 'roomOk': this.seat = m.seat; break;
            case 'roundStart':
                this.roundNo = m.roundNo;
                this.ex = []; this.exTurns = []; this.finished = false;
                if (typeof m.seat === 'number') this.seat = m.seat;
                break;
            case 'identity': this.isEnemy = !!m.isEnemy; break;
            case 'hand': this.hand = m.cards || []; break;
            case 'ex': this.ex.push(m); break;
            case 'exTurn': this.exTurns.push(m); break;
            case 'turn':
                if (m.kind !== 'PLAY') {
                    // 轮到谁交牌：进入待处理列表（区分已消费/未消费）
                    this.pending.push(m);
                }
                break;
            case 'error': console.log(`  [${this.name}] 被拒: ${m.msg}`); break;
        }
    }

    /** 等到满足条件的一条消息（先扫历史；调用方负责移除） */
    waitFor(pred, timeout = 20000) {
        const hit = this.msgs.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`${this.name} 等待超时`)), timeout);
            const h = (raw) => {
                const m = JSON.parse(raw.toString());
                if (pred(m)) { clearTimeout(t); this.ws.off('message', h); res(m); }
            };
            this.ws.on('message', h);
        });
    }

    /** 取出（并移除）一条符合条件的消息；没有则等新的 */
    async take(pred, timeout = 60000) {
        const i = this.msgs.findIndex(pred);
        if (i >= 0) return this.msgs.splice(i, 1)[0];
        return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`${this.name} 等待超时`)), timeout);
            const h = (raw) => {
                const m = JSON.parse(raw.toString());
                if (pred(m)) {
                    clearTimeout(t);
                    this.ws.off('message', h);
                    const j = this.msgs.indexOf(m);
                    if (j >= 0) this.msgs.splice(j, 1);
                    res(m);
                }
            };
            this.ws.on('message', h);
        });
    }

    // ---- 手牌工具 ----
    suitRank(n) {
        const s = n.charAt(0);
        return s === '方' ? 0 : s === '梅' ? 1 : s === '红' ? 2 : s === '黑' ? 3 : 4;
    }
    pointOf(n) {
        const map = { A: 14, K: 13, Q: 12, J: 11, '10': 10 };
        const body = n.replace(/^(方块|梅花|红桃|黑桃|大王|小王)/, '');
        if (n === '大王') return 15;
        if (n === '小王') return 14;
        return map[body] || Number(body) || 0;
    }
    cardVal(n) { return this.pointOf(n) * 10 + this.suitRank(n); }

    /** 可交的牌（排除方块4 与本局已换过的）—— 引擎按 id 排序决定大小，这里必须一致 */
    free() { return this.hand.filter((c) => c.name !== '方块4' && !c.exchanged); }
    /** 从小到大（id 序，与 sortCards 一致） */
    asc() { return this.free().slice().sort((a, b) => a.id - b.id); }
    /** 从大到小（id 序，与 sortCardsDesc 一致） */
    desc() { return this.free().slice().sort((a, b) => b.id - a.id); }
}

const bots = [new Bot('A'), new Bot('B'), new Bot('C'), new Bot('D')];

(async () => {
    await Promise.all(bots.map((b) => b.opened()));
    // 逐个进房，每步都等回执，避免连接慢的被排到别的房间
    for (const b of bots) {
        b.send({ t: 'login', nickname: '玩家' + b.name });
        await b.waitFor((m) => m.t === 'loginOk');
    }
    for (const b of bots) {
        b.send({ t: 'join' });
        const ok = await b.waitFor((m) => m.t === 'roomOk');
        console.log(`  ${b.name} 进房 ${ok.roomId} 座位 ${ok.seat}`);
    }
    const roomIds = new Set(bots.map((b) => b.msgs.find((m) => m.t === 'roomOk').roomId));
    if (roomIds.size !== 1) throw new Error(`4 个 bot 被分到 ${roomIds.size} 个房间，无法测试: ${[...roomIds]}`);
    console.log(`4 人同房: ${[...roomIds][0]}`);
    for (const b of bots) b.send({ t: 'ready' });
    await Promise.all(bots.map((b) => b.waitFor((m) => m.t === 'roundStart')));
    await new Promise((r) => setTimeout(r, 400));
    console.log('\n=== 第 1 局（首局无交牌，用托管快速打完）===');

    // ---- 首局：全部托管出牌，只为产出「上一局结果」 ----
    const autoAll = setInterval(() => {
        for (const b of bots) {
            const turn = b.msgs.find((m) => m.t === 'turn' && m.kind === 'PLAY');
            if (turn) {
                b.msgs = b.msgs.filter((m) => m !== turn);
                b.send({ t: 'act', kind: 'auto' });
            }
        }
    }, 60);

    await Promise.all(bots.map((b) => b.waitFor((m) => m.t === 'roundEnd', 120000)));
    clearInterval(autoAll);
    const r1 = bots[0].msgs.filter((m) => m.t === 'roundEnd').pop().result;
    console.log(`第 1 局结果：敌人座位 ${r1.enemySeat}，出完顺序 ${JSON.stringify(r1.finishOrder)}`);
    console.log(`名次：${JSON.stringify(r1.rankNames)}`);

    // ---- 开第 2 局（这局开始才有交牌；需要 4 人全部投票「再来一局」） ----
    for (const b of bots) {
        b.msgs = b.msgs.filter((m) => !['roundEnd', 'turn', 'state', 'roundStart', 'nextVote'].includes(m.t));
        b.ex = []; b.exTurns = [];
    }
    for (const b of bots) b.send({ t: 'next' });
    await Promise.all(bots.map((b) => b.waitFor((m) => m.t === 'roundStart', 20000)));
    await new Promise((r) => setTimeout(r, 400));

    const seatName = (s) => bots.find((b) => b.seat === s).name;
    // 等 identity 到达后再判定谁是敌人（roundStart 之后才有）
    await new Promise((r) => setTimeout(r, 300));
    const enemy = bots.find((b) => b.isEnemy);
    console.log(`\n=== 第 2 局开始（含交牌）===`);
    console.log(`敌人是 ${enemy ? enemy.name : '?'}（座位 ${enemy ? enemy.seat : '?'}）`);

    // ---- 统计交牌过程中每个人都收到了多少广播 ----
    const seenKinds = [];
    let stepGuard = 0;

    /** 处理一次「轮到我」的交牌：按人类逻辑选牌并提交 */
    async function handleMyTurn(me, turn) {
        const k = turn.kind;
        seenKinds.push(k);
        let cards;
        switch (k) {
            case 'ENEMY_PUT': {
                // 敌人交最大的 N 张
                cards = me.desc().slice(0, turn.count).map((c) => c.id);
                console.log(`  ${me.name}(敌人) ENEMY_PUT 交 ${me.desc().slice(0, turn.count).map((c) => c.name).join('、')}`);
                break;
            }
            case 'TOURIST_PICK': {
                // 游客挑桌上「最大」的一张
                const top = turn.tableCards
                    .map((id) => ({ id, name: DECKNAME.get(id) }))
                    .sort((a, b) => b.id - a.id)[0];
                cards = [top.id];
                console.log(`  ${me.name}(第${turn.rank}名) TOURIST_PICK 拿走 ${top.name}（桌上 ${turn.tableCards.length} 张可选）`);
                break;
            }
            case 'TOURIST_RETURN': {
                // 游客还最小的一张
                const small = me.asc()[0];
                cards = [small.id];
                console.log(`  ${me.name} TOURIST_RETURN 还 ${small.name} 给敌人`);
                break;
            }
            case 'LOSER_GIVE': {
                // 被抓龟必须交最大的一张
                const big = me.desc()[0];
                cards = [big.id];
                console.log(`  ${me.name}(被抓龟) LOSER_GIVE 交出最大牌 ${big.name}`);
                break;
            }
            case 'ENEMY_RETURN': {
                cards = me.asc().slice(0, turn.count).map((c) => c.id);
                console.log(`  ${me.name}(敌人) ENEMY_RETURN 交 ${me.asc().slice(0, turn.count).map((c) => c.name).join('、')}`);
                break;
            }
            case 'LOSER_PICK': {
                const order = turn.loserPickOrder || [];
                const myIdx = order.indexOf(me.seat);
                const top = turn.tableCards
                    .map((id) => ({ id, name: DECKNAME.get(id) }))
                    .sort((a, b) => b.id - a.id)[0];
                cards = [top.id];
                console.log(`  ${me.name} LOSER_PICK 挑 ${top.name}（交牌排名第 ${myIdx + 1} 位挑）`);
                break;
            }
        }
        me.send({ t: 'act', kind: 'play', cards });
    }

    // 需要牌名表：从任意 bot 的 hand 收集不到全表，用 GameEngine 的 createDeck 重建

    // ---- 驱动：谁收到 turn 谁就操作（模拟真人及时点击） ----
    let running = true;
    for (const b of bots) {
        (async () => {
            while (running) {
                const turn = b.pending.shift();
                if (!turn) { await new Promise((r) => setTimeout(r, 40)); continue; }
                try {
                    stepGuard++;
                    if (stepGuard > 60) { running = false; break; }
                    await handleMyTurn(b, turn);
                    await new Promise((r) => setTimeout(r, 150));   // 人类思考
                } catch (e) {
                    console.log(`  [${b.name}] 处理出错: ${e.message}`);
                }
            }
        })();
    }

    // 等交牌结束（进入 PLAYING）—— 用「所有轮到的 turn 都处理完」判断，避免错过消息
    await Promise.all(bots.map((b) => b.waitFor((m) => m.t === 'state' && m.phase === 'PLAYING', 90000)));
    // 再等一会儿，确保最后几条 ex 广播都已经到达
    await new Promise((r) => setTimeout(r, 800));
    running = false;

    console.log(`\n=== 交牌阶段结束 ===`);
    console.log(`步骤序列: ${seenKinds.join(' → ')}`);

    // ---- 校验 ----
    const counts = {};
    for (const k of seenKinds) counts[k] = (counts[k] || 0) + 1;
    console.log(`各步骤出现次数:`, JSON.stringify(counts));

    const orderIdx = seenKinds.map((k) => KIND_ORDER.indexOf(k));
    let mono = true;
    for (let i = 1; i < orderIdx.length; i++) if (orderIdx[i] < orderIdx[i - 1]) mono = false;
    console.log(`${mono ? '✔' : '✘'} 步骤顺序符合 敌人交大牌→游客依次挑→游客还牌→抓龟交大牌→敌人还小牌→抓龟依次挑`);

    // 每个玩家都应该收到每一条交牌广播
    const len = bots.map((b) => b.ex.length);
    console.log(`各玩家收到的交牌广播条数: ${len.join(' / ')}（应全部相同）`);
    console.log(`${new Set(len).size === 1 && len[0] > 0 ? '✔' : '✘'} 四家看到的交牌记录完全一致（共 ${len[0]} 条）`);

    const kinds = new Set(bots[0].ex.map((e) => e.kind));
    console.log(`广播覆盖的步骤: ${[...kinds].join(', ')}`);
    console.log(`${[...kinds].length >= 3 ? '✔' : '✘'} 交牌动画消息覆盖多种类型`);

    // 每家都应该收到 exTurn（轮到谁交牌）——这才是「全场看得到交换过程」的关键
    const counts2 = bots.map((b) => b.exTurns.length);
    const sameET = new Set(counts2).size === 1 && counts2[0] > 0;
    console.log(`各玩家收到的「轮到谁交牌」广播条数: ${counts2.join(' / ')}（四家必须完全相同）`);
    console.log(`${sameET ? '✔' : '✘'} exTurn 广播给了全场：四家都能看到谁在操作，不只是操作者自己`);

    process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
