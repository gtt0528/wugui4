/**
 * 超时托管测试：
 *   4 个客户端进房——1 个完全不出手（模拟挂机），其余 3 个正常托管。
 *   预期：挂机那位每次都被服务器自动托管，对局能一路打到结算。
 */
const WebSocket = require('ws');
const URL = process.env.WS_URL || 'ws://localhost:8090';
const clients = [];

function makeClient(name, idle) {
    const c = { name, idle, seat: -1, autoTip: 0, gotTimer: false, roundEnd: null, done: false };
    clients.push(c);
    const ws = new WebSocket(URL);
    c.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'login', nickname: name, gender: 1 })));
    ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        try {
            switch (m.t) {
                case 'loginOk': ws.send(JSON.stringify({ t: 'join' })); break;
                case 'roomOk': c.seat = m.seat; ws.send(JSON.stringify({ t: 'ready' })); break;
                case 'timer': c.gotTimer = true; break;
                case 'tip': c.autoTip++; break;
                case 'turn':
                    if (!idle) ws.send(JSON.stringify({ t: 'act', kind: 'auto' }));
                    break;
                case 'roundEnd':
                    if (!c.roundEnd) {
                        c.roundEnd = m.result;
                        c.done = true;
                    }
                    break;
                case 'error':
                    c.errors = (c.errors || 0) + 1;
                    if (c.errors <= 3) console.log(`[${name}] 服务器错误: ${m.msg}`);
                    break;
                default: break;
            }
        } catch (e) {
            console.log(`[${name}] 处理消息出错 ${m.t}:`, e.message);
        }
    });
    ws.on('close', (code) => console.log(`[${name}] 连接关闭 code=${code}`));
    ws.on('error', (e) => console.log(`[${name}] ws 错误:`, e.message));
    return c;
}

(async () => {
    const list = [
        makeClient('挂机会员', true),
        makeClient('bot1', false),
        makeClient('bot2', false),
        makeClient('bot3', false),
    ];
    console.log('等待一局打完（挂机者应被自动托管）…');

    const start = Date.now();
    while (Date.now() - start < 240000) {
        if (list.every((c) => c.done)) break;
        await new Promise((r) => setTimeout(r, 500));
    }

    const idle = list[0];
    console.log('挂机者收到倒计时消息:', idle.gotTimer);
    console.log('挂机者被自动托管次数:', idle.autoTip);
    console.log('结算:', JSON.stringify(idle.roundEnd || null).slice(0, 220));
    if (idle.roundEnd && idle.autoTip > 0) {
        console.log('✅ 超时托管生效，对局正常打完');
    } else {
        console.log('❌ 未达标');
    }
    process.exit(0);
})();
