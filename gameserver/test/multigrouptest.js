/**
 * 多人匹配压力测试：分别用 4 / 8 / 12 个真人客户端进场，
 * 验证分房（1/2/3 桌）、每桌 4 个玩家都能轮到点按钮、四家画面完全一致、
 * 连续打多局、不点按钮绝不自动换牌。
 *
 * 每个 Bot 都模拟一个真人：只在收到自己的 turn 时才「点牌 + 点按钮」提交。
 * 出牌阶段用 auto 托管加速（交牌之外的出牌不是本次验证重点）。
 */
const WebSocket = require('ws');
const URL = process.env.WS_URL || 'ws://localhost:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
    constructor(name) {
        this.name = name;
        this.ws = new WebSocket(URL);
        this.msgs = [];
        this.pending = [];
        this.seat = -1;
        this.roomId = '';
        this.hand = [];
        this.ex = [];          // 收到的交牌广播（四家应完全一致）
        this.exTurns = [];     // 收到的「轮到谁」广播
        this.states = [];      // state 里的桌面牌/手牌数
        this.myExchangeTurns = 0;  // 我轮到过几次交牌（应 > 0）
        this.roundEnds = 0;
        this.errors = [];
        this.ws.on('message', (raw) => {
            const m = JSON.parse(raw.toString());
            this.msgs.push(m);
            this.pending.push(m);
            if (m.t === 'roomOk') { this.roomId = m.roomId; this.seat = m.seat; }
            if (m.t === 'hand' && m.cards) this.hand = m.cards;
            if (m.t === 'ex') this.ex.push(m);
            if (m.t === 'exTurn') this.exTurns.push(m);
            if (m.t === 'state') this.states.push(m);
            if (m.t === 'roundEnd') this.roundEnds++;
            if (m.t === 'error') this.errors.push(m.msg);
        });
        this.ws.on('error', () => {});
    }
    opened() { return this.ws.readyState === 1 ? Promise.resolve() : new Promise((r) => this.ws.on('open', r)); }
    send(o) { this.ws.send(JSON.stringify(o)); }
    take(pred) { const i = this.pending.findIndex(pred); return i >= 0 ? this.pending.splice(i, 1)[0] : null; }
    count(t) { return this.msgs.filter((m) => m.t === t).length; }
}

/** 按引擎规则模拟真人「点牌」：id 升序 = 从小到大（与 sortCards 一致） */
function chooseCards(bot, turn) {
    const k = turn.kind;
    const free = bot.hand.filter((c) => c.name !== '方块4' && !c.exchanged);
    const asc = free.slice().sort((a, b) => a.id - b.id);
    const desc = free.slice().sort((a, b) => b.id - a.id);
    const table = (turn.tableCards || []).slice().sort((a, b) => b - a);
    switch (k) {
        case 'ENEMY_PUT': return desc.slice(0, turn.count).map((c) => c.id);
        case 'ENEMY_RETURN': return asc.slice(0, turn.count).map((c) => c.id);
        case 'TOURIST_RETURN': return asc.length ? [asc[0].id] : [];
        case 'LOSER_GIVE': return desc.length ? [desc[0].id] : [];
        case 'TOURIST_PICK':
        case 'LOSER_PICK': return table.length ? [table[0]] : [];
        default: return [];
    }
}

/** 同时驱动多个房间的所有真人，直到每个房间都打完 rounds 局 */
async function play(bots, rounds, timeout = 120000) {
    const t0 = Date.now();
    const doneRooms = new Set();
    while (Date.now() - t0 < timeout) {
        // 每个真人独立处理自己收到的消息（模拟不停切换网页去点）
        for (const b of bots) {
            // 轮到我交牌：点牌 + 点按钮
            let turn;
            while ((turn = b.take((m) => m.t === 'turn' && m.kind !== 'PLAY'))) {
                b.myExchangeTurns++;
                const cards = chooseCards(b, turn);
                if (cards.length) b.send({ t: 'act', kind: 'play', cards });
                else b.send({ t: 'act', kind: 'play', cards: [-1] });
            }
            // 轮到我出牌：托管加速
            let pt;
            while ((pt = b.take((m) => m.t === 'turn' && m.kind === 'PLAY'))) {
                b.send({ t: 'act', kind: 'auto' });
            }
            // 局结束：点「再来一局」（全员投票）
            const re = b.take((m) => m.t === 'roundEnd');
            if (re) b.send({ t: 'next' });
        }
        // 判断每个房间是否都已「真正打完」rounds 局（不是刚开局就算数）
        const byRoom = {};
        for (const b of bots) (byRoom[b.roomId] = byRoom[b.roomId] || []).push(b);
        for (const [rid, grp] of Object.entries(byRoom)) {
            if (grp.every((b) => b.roundEnds >= rounds)) doneRooms.add(rid);
        }
        if (Object.keys(byRoom).every((rid) => doneRooms.has(rid))) return byRoom;
        await sleep(30);
    }
    throw new Error(`${rounds} 局超时未完成`);
}

async function run(totalPlayers, rounds = 2) {
    console.log(`\n========== ${totalPlayers} 人匹配（预期 ${totalPlayers / 4} 桌，每桌 4 人）==========`);
    const bots = [];
    for (let i = 0; i < totalPlayers; i++) bots.push(new Bot(`P${i + 1}`));
    for (const b of bots) {
        await b.opened();
        b.send({ t: 'login', nickname: b.name });
        await sleep(25);
        b.send({ t: 'join' });
        await sleep(25);
        b.send({ t: 'ready', ok: true });
    }
    await sleep(500);

    const byRoom = {};
    for (const b of bots) (byRoom[b.roomId] = byRoom[b.roomId] || []).push(b);
    const rooms = Object.entries(byRoom);
    const seatOk = rooms.every(([, grp]) => grp.length === 4
        && new Set(grp.map((b) => b.seat)).size === 4
        && grp.every((b) => b.seat >= 0 && b.seat < 4));
    console.log(`分房：${rooms.length} 桌 ${rooms.map(([r, g]) => `${r}(${g.length}人)`).join(' ')}：${rooms.length === totalPlayers / 4 && seatOk ? '✔' : '❌'}`);

    let allOk = seatOk && rooms.length === totalPlayers / 4;
    try {
        await play(bots, rounds);
    } catch (e) {
        console.log(`❌ ${e.message}`);
        allOk = false;
    }

    for (const [rid, grp] of rooms) {
        // 每个真人是否都轮到过交牌（都有按钮可点）
        const turns = grp.map((b) => b.myExchangeTurns);
        const everyoneCanClick = turns.every((n) => n > 0);
        // 四家看到的交牌广播 / 轮到谁 / 桌面状态是否完全一致
        const sig = (arr) => JSON.stringify(arr);
        const exSig = grp.map((b) => sig(b.ex.map((m) => [m.index, m.kind, m.from, m.to, m.card && m.card.id])));
        const turnSig = grp.map((b) => sig(b.exTurns.map((m) => [m.seat, m.kind, m.count])));
        const stateSig = grp.map((b) => sig(b.states.map((m) => [m.phase, (m.tableCards || []).join(','), (m.handCounts || []).join(',')])));
        const sameEx = new Set(exSig).size === 1;
        const sameTurn = new Set(turnSig).size === 1;
        const sameState = new Set(stateSig).size === 1;
        const sameEnd = new Set(grp.map((b) => b.roundEnds)).size === 1;
        const errs = grp.reduce((s, b) => s + b.errors.length, 0);
        // 桌上曾同时摆着几张牌（敌人交 N 张大牌时应为 N，且逐个被真人点走，不能被自动拿光）
        const maxTable = Math.max(0, ...grp[0].states.map((m) => (m.tableCards || []).length));
        const kinds = grp[0].exTurns.map((m) => m.kind);
        const picks = kinds.filter((k) => k === 'TOURIST_PICK' || k === 'LOSER_PICK').length;
        const puts = grp[0].ex.filter((m) => m.kind === 'ENEMY_PUT' || m.kind === 'ENEMY_RETURN').length;
        const tableOk = puts === 0 || (maxTable >= 2 && picks >= 2);
        console.log(`  ${rid}: 各人交牌操作次数 [${turns.join(',')}] ${everyoneCanClick ? '✔ 人人有按钮' : '❌ 有玩家没轮到'}`);
        console.log(`        四家一致 ex=${sameEx ? '✔' : '❌'} exTurn=${sameTurn ? '✔' : '❌'} state=${sameState ? '✔' : '❌'} roundEnd=${sameEnd ? '✔' : '❌'}  广播条数 ${grp[0].ex.length}  错误=${errs}`);
        console.log(`        桌面峰值 ${maxTable} 张 / 摆牌 ${puts} 次 / 真人挑选 ${picks} 次：${tableOk ? '✔ 牌摆在桌上等人挑，没被自动拿光' : '❌ 桌面牌异常'}`);
        allOk = allOk && everyoneCanClick && sameEx && sameTurn && sameState && sameEnd && errs === 0 && tableOk;
    }
    for (const b of bots) b.ws.close();
    console.log(`${totalPlayers} 人：${allOk ? '✔ 全部通过' : '❌ 存在问题'}`);
    await sleep(300);
    return allOk;
}

(async () => {
    let ok = true;
    for (const n of [4, 8, 12]) ok = (await run(n, 2)) && ok;
    console.log(`\n总体结论：${ok ? '✔ 4/8/12 人匹配、多桌并行、多局连续、四家画面一致全部通过' : '❌ 有失败项，见上'}`);
    process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
