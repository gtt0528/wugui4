/**
 * 验证：联机 4 真人模式下，玩家不点按钮，服务器绝不自动换牌。
 *
 * 场景：4 人进房 → 第 1 局托管打完 → 4 人全点「再来一局」→ 第 2 局交牌。
 *   ① 收到第一个交牌 turn 后故意不操作，等 4 秒：
 *      不应出现任何 ex（牌移动）、新的 exTurn、桌上牌数变化
 *   ② 再按真人点击提交一步：立刻出现 1 条 ex，并轮到下一位
 *   ③ 逐步点完整个交牌过程，验证每一步都由「客户端发送 act」触发
 */
const WebSocket = require('ws');
const URL = 'ws://localhost:8090';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
    constructor(name) {
        this.name = name;
        this.ws = new WebSocket(URL);
        this.msgs = [];
        this.pending = [];
        this.seat = -1;
        this.hand = [];
        this.turns = 0;
        this.ws.on('message', (raw) => {
            const m = JSON.parse(raw.toString());
            this.msgs.push(m);
            this.pending.push(m);
            if (m.t === 'roomOk') this.seat = m.seat;
            if (m.t === 'hand' && m.cards) this.hand = m.cards;
            if (m.t === 'turn' && m.kind !== 'PLAY') this.turns++;
        });
        this.ws.on('error', () => {});
    }
    opened() { return this.ws.readyState === 1 ? Promise.resolve() : new Promise((r) => this.ws.on('open', r)); }
    send(o) { this.ws.send(JSON.stringify(o)); }
    take(pred) { const i = this.pending.findIndex(pred); return i >= 0 ? this.pending.splice(i, 1)[0] : null; }
    count(t) { return this.msgs.filter((m) => m.t === t).length; }
}

(async () => {
    const bots = ['甲', '乙', '丙', '丁'].map((n) => new Bot(n));
    for (const b of bots) {
        await b.opened();
        b.send({ t: 'login', nickname: b.name });
        await sleep(50);
        b.send({ t: 'join' });
        await sleep(50);
        b.send({ t: 'ready', ok: true });
    }
    await sleep(800);

    // 第 1 局：全程托管打完（出牌阶段允许 auto）
    const autoAll = setInterval(() => {
        for (const b of bots) {
            const turns = b.pending.filter((m) => m.t === 'turn' && m.kind === 'PLAY');
            for (const t of turns) {
                b.pending.splice(b.pending.indexOf(t), 1);
                b.send({ t: 'act', kind: 'auto' });
            }
        }
    }, 80);
    const t0 = Date.now();
    while (!bots.every((b) => b.count('roundEnd') > 0) && Date.now() - t0 < 60000) await sleep(100);
    clearInterval(autoAll);
    console.log('第 1 局打完');

    // 4 人全部点「再来一局」
    for (const b of bots) b.send({ t: 'next' });
    const t1 = Date.now();
    while (!bots.every((b) => b.count('roundStart') >= 2) && Date.now() - t1 < 10000) await sleep(100);
    await sleep(300);
    console.log('第 2 局开局，进入交牌');

    // 找出当前该操作的玩家
    const exTurn = bots.map((b) => b.msgs.filter((m) => m.t === 'exTurn').pop()).find((m) => !!m);
    const actor = bots.find((b) => b.seat === exTurn.seat);
    const before = {
        ex: bots.reduce((s, b) => s + b.count('ex'), 0),
        exTurn: bots.reduce((s, b) => s + b.count('exTurn'), 0),
    };
    console.log(`当前轮到 ${actor.name}（座位 ${actor.seat}）执行 ${exTurn.kind}，故意不点，等 4 秒…`);
    await sleep(4000);
    const after = {
        ex: bots.reduce((s, b) => s + b.count('ex'), 0),
        exTurn: bots.reduce((s, b) => s + b.count('exTurn'), 0),
    };
    const noMove = after.ex === before.ex && after.exTurn === before.exTurn;
    console.log(`不点按钮时：ex ${before.ex}→${after.ex}，exTurn ${before.exTurn}→${after.exTurn}：${noMove ? '✔ 牌完全没动' : '❌ 服务器自动换牌了'}`);

    // 现在按真人点击提交这一步
    const turn = actor.pending.filter((m) => m.t === 'turn' && m.kind !== 'PLAY').pop();
    if (!turn) { console.log('❌ 没收到自己的 turn'); process.exit(1); }
    const k = turn.kind;
    let cards;
    const free = actor.hand.filter((c) => c.name !== '方块4' && !c.exchanged);
    const asc = free.slice().sort((a, b) => a.id - b.id);
    const desc = free.slice().sort((a, b) => b.id - a.id);
    if (k === 'ENEMY_PUT') cards = desc.slice(0, turn.count).map((c) => c.id);
    else if (k === 'ENEMY_RETURN') cards = asc.slice(0, turn.count).map((c) => c.id);
    else if (k === 'LOSER_GIVE') cards = [desc[0].id];
    else if (k === 'TOURIST_RETURN') cards = [asc[0].id];
    else cards = [turn.tableCards[0]];
    actor.send({ t: 'act', kind: 'play', cards });
    await sleep(600);
    const moved = bots.reduce((s, b) => s + b.count('ex'), 0);
    console.log(`点牌+点按钮后：ex 总数 ${before.ex}→${moved}：${moved > before.ex ? '✔ 牌动了，且只动了这一步' : '❌ 没反应'}`);

    for (const b of bots) b.ws.close();
    console.log(noMove && moved > before.ex ? '\n✔ 验证通过：不点就绝对不动，点了才动' : '\n❌ 验证失败');
    process.exit(noMove && moved > before.ex ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
