/** 验证：B 取消匹配（断开）后，A 应收到 memberUpdate（1/4），C 再进来应为 2/4 */
const WebSocket = require('ws');
const URL = 'ws://localhost:8090';

function client(name) {
    const ws = new WebSocket(URL);
    const c = { name, ws, msgs: [] };
    ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        c.msgs.push(m);
        console.log(`  [${name}] <<`, m.t);
    });
    /** 先扫已收到的消息，没有再等新的 */
    c.wait = (t, pred, timeout = 5000) => {
        const hit = c.msgs.find((m) => m.t === t && (!pred || pred(m)));
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`${name} 等待 ${t} 超时`)), timeout);
            const h = (raw) => {
                const m = JSON.parse(raw.toString());
                if (m.t === t && (!pred || pred(m))) { clearTimeout(timer); ws.off('message', h); res(m); }
            };
            ws.on('message', h);
        });
    };
    return c;
}

const count = (m) => (m.members || []).filter((x) => !x.empty).length;

(async () => {
    const A = client('A'), B = client('B'), C = client('C');
    const opened = (c) => c.ws.readyState === 1
        ? Promise.resolve()
        : new Promise((r) => c.ws.on('open', r));
    await opened(A);
    A.ws.send(JSON.stringify({ t: 'login', nickname: '玩家A' }));
    await A.wait('loginOk');
    A.ws.send(JSON.stringify({ t: 'join' }));
    const roomA = await A.wait('roomOk');
    console.log(`A 进房 ${roomA.roomId} 座位${roomA.seat}`);

    await opened(B);
    B.ws.send(JSON.stringify({ t: 'login', nickname: '玩家B' }));
    await B.wait('loginOk');
    B.ws.send(JSON.stringify({ t: 'join' }));
    await B.wait('roomOk');
    await A.wait('memberUpdate', (m) => count(m) === 2);
    console.log('✔ A 看到 2/4');

    // B 取消匹配 = 直接断开连接
    B.ws.close();
    const mu2 = await A.wait('memberUpdate', (m) => count(m) === 1);
    console.log('✔ B 取消后 A 收到 memberUpdate → 1/4，成员:', JSON.stringify(mu2.members));

    // C 再进来 → 2/4
    await opened(C);
    C.ws.send(JSON.stringify({ t: 'login', nickname: '玩家C' }));
    await C.wait('loginOk');
    C.ws.send(JSON.stringify({ t: 'join' }));
    await A.wait('memberUpdate', (m) => count(m) === 2);
    console.log('✔ C 进房后 A 收到 memberUpdate → 2/4');

    console.log('\n✅ 人数同步全部符合预期');
    A.ws.close(); C.ws.close();
    setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
