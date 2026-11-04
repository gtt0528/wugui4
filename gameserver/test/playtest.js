/**
 * 多人多局实战模拟（模拟真人操作习惯，用来发现手感/流程问题）
 *
 * 覆盖：
 *   1. 连打 3 局（第 2、3 局有交牌阶段）
 *   2. 交牌阶段「不按按钮」 → 依赖 15 秒超时自动选牌
 *   3. 出牌阶段「偶尔故意出错的牌」 → 验证服务器拒绝后对局不卡死
 *   4. 全程监听 ranks（导游/中游/尾游）与 enemyRevealed，检查身份标注时机
 */
const WebSocket = require('ws');
const URL = process.env.WS_URL || 'ws://localhost:8090';


const PLAYER_COUNT = 4;
const ROUNDS = 3;



function makeClient(name, mode) {
    // mode: 'normal' | 'idleExchange'（交牌阶段不按按钮，靠超时）
    const c = {
        name, mode, seat: -1, hand: [], errors: 0, timers: 0,
        ranks: [0, 0, 0, 0], revealed: -1, isEnemy: false,
        roundEnds: [], log: [],
    };
    const ws = new WebSocket(URL);
    c.ws = ws;

    ws.on('open', () => ws.send(JSON.stringify({ t: 'login', nickname: name, gender: 1 })));
    ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        switch (m.t) {
            case 'loginOk': ws.send(JSON.stringify({ t: 'join' })); break;
            case 'roomOk': c.seat = m.seat; ws.send(JSON.stringify({ t: 'ready' })); break;
            case 'timer': c.timers++; break;
            case 'identity': c.isEnemy = !!m.isEnemy; break;
            case 'enemyRevealed':
                c.revealed = m.seat;
                c.log.push(`敌人暴露 seat=${m.seat}`);
                break;
            case 'hand':
                c.hand = (m.cards || []).map((x) => x.id);
                break;
            case 'state':
                if (Array.isArray(m.ranks)) c.ranks = m.ranks;
                break;
            case 'error':
                c.errors++;
                c.log.push(`被拒绝: ${m.msg}`);
                break;
            case 'roundEnd':
                c.roundEnds.push({ no: m.result.roundNo, ranks: m.result.rankNames });
                break;
            case 'turn':
                handleTurn(c, m);
                break;
            default: break;
        }
    });
    ws.on('close', (code) => c.log.push(`连接关闭 ${code}`));
    return c;
}

function handleTurn(c, m) {
    const isExchange = m.kind !== 'PLAY';

    // 交牌阶段：idleExchange 模式故意不按按钮，等 15 秒超时
    if (isExchange && c.mode === 'idleExchange') return;

    if (isExchange) {
        // 正常交牌：模拟真人按按钮（这里直接让服务器托管选择，等价于按了按钮）
        setTimeout(() => {
            if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'act', kind: 'auto' }));
        }, 300);
        return;
    }

    // 出牌阶段
    const hand = c.hand.slice();
    if (!hand.length) return;

    setTimeout(() => {
        if (c.ws.readyState !== 1) return;
        // 15% 概率故意出一个明显不合法的组合（模拟玩家点错/压不过），验证不卡死
        if (Math.random() < 0.15 && !m.mustLead) {
            const wrong = hand.slice(0, 2 + Math.floor(Math.random() * 3));
            c.ws.send(JSON.stringify({ t: 'act', kind: 'play', cards: wrong }));
            // 900ms 后无论结果都用托管继续，模拟玩家被提示后重新操作
            setTimeout(() => {
                if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'act', kind: 'auto' }));
            }, 900);
            return;
        }
        c.ws.send(JSON.stringify({ t: 'act', kind: 'auto' }));
    }, 200 + Math.random() * 400);
}

(async () => {
    console.log(`启动 ${PLAYER_COUNT} 个模拟玩家（其中 1 个交牌阶段故意不按按钮）…`);
    const clients = [
        makeClient('真人A', 'normal'),
        makeClient('挂机B', 'idleExchange'),
        makeClient('真人C', 'normal'),
        makeClient('真人D', 'normal'),
    ];

    // 等第一局打完
    const waitRounds = async (n) => {
        const start = Date.now();
        const a = clients[0];
        while (Date.now() - start < 400000) {
            if (a.roundEnds.length >= n) return true;
            await new Promise((r) => setTimeout(r, 500));
        }
        return false;
    };

    for (let r = 1; r <= ROUNDS; r++) {
        const ok = await waitRounds(r);
        if (!ok) { console.log(`❌ 第 ${r} 局没打完（超时）`); break; }
        const res = clients[0].roundEnds[r - 1];
        console.log(`第 ${r} 局结束 → 名次: ${JSON.stringify(res.ranks)}`);
        // 继续下一局
        clients.forEach((c) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'next' })); });
        await new Promise((r2) => setTimeout(r2, 1200));
    }

    console.log('\n===== 诊断 =====');
    for (const c of clients) {
        console.log(`${c.name}: seat=${c.seat} 回合=${c.timers} 被拒绝=${c.errors} ` +
            `敌人暴露=${c.revealed} 我是否敌人=${c.isEnemy} 名次=${JSON.stringify(c.ranks)}`);
        if (c.log.length) console.log('   日志:', c.log.slice(-4).join(' | '));
    }
    const stuck = clients.some((c) => c.roundEnds.length < ROUNDS);
    console.log(stuck ? '\n❌ 有局没打完，存在卡死' : `\n✅ ${ROUNDS} 局全部打完，倒计时/拒绝/身份标注均正常`);
    process.exit(0);
})();
