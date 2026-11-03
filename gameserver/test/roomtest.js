/**
 * 房间流程测试（私有房）
 *
 * 覆盖：
 *   1. 创建房间 → 拿到 6 位房间号，创建者是房主
 *   2. 另外 3 人按房间号加入 → 满 4 人
 *   3. 第 5 个人拿同一房间号进 → 收到 ROOM_FULL「房间已满」
 *   4. 非房主发 startGame / dissolve → 被拒绝
 *   5. 房主退出 → 房主自动移交给剩下的人
 *   6. 新房主解散 → 其余人收到 roomClosed
 *   7. 新房间满 4 人后房主开局 → 四家都收到 roundStart
 *
 * 用法：先起服务器（默认 8090），再 node test/roomtest.js
 */
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://localhost:8090';

let pass = 0;
let fail = 0;

function ok(cond, msg) {
    if (cond) { pass++; console.log('  [OK] ' + msg); }
    else { fail++; console.log('  [FAIL] ' + msg); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBot(name) {
    const ws = new WebSocket(URL);
    const bot = { name, ws, msgs: [], userId: 0, seat: -1, code: '', ownerSeat: -1 };
    ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        bot.msgs.push(m);
        if (m.t === 'loginOk') bot.userId = m.userId;
        if (m.t === 'roomOk') {
            bot.seat = m.seat;
            bot.code = m.code;
            bot.ownerSeat = m.ownerSeat;
            bot.isPrivate = m.isPrivate;
        }
    });
    ws.on('error', (e) => console.log(`  [${name}] ws error: ${e.message}`));
    return new Promise((resolve) => {
        ws.on('open', () => {
            ws.send(JSON.stringify({ t: 'login', nickname: name, gender: 1 }));
            setTimeout(() => resolve(bot), 150);
        });
    });
}

const send = (bot, obj) => bot.ws.send(JSON.stringify(obj));
const clear = (bot) => { bot.msgs.length = 0; };

function last(bot, type) {
    for (let i = bot.msgs.length - 1; i >= 0; i--) if (bot.msgs[i].t === type) return bot.msgs[i];
    return null;
}

function allOf(bot, type) {
    return bot.msgs.filter((m) => m.t === type);
}

(async () => {
    console.log('=== 房间流程测试 ===\n');

    const A = await makeBot('甲');
    const B = await makeBot('乙');
    const C = await makeBot('丙');
    const D = await makeBot('丁');
    const E = await makeBot('戊');
    await wait(200);

    // ---------- 1. 创建房间 ----------
    console.log('--- ① 创建房间 ---');
    send(A, { t: 'create' });
    await wait(450);
    const aRoom = last(A, 'roomOk');
    ok(!!aRoom, '创建房间成功');
    ok(!!aRoom && aRoom.isPrivate === true, '是私有房（不参与快速匹配）');
    ok(!!aRoom && aRoom.ownerSeat === aRoom.seat, '创建者就是房主');
    ok(!!aRoom && /^\d{6}$/.test(String(aRoom.code)), `房间号是 6 位：${aRoom && aRoom.code}`);
    const code = aRoom && aRoom.code;

    // ---------- 2. 三人按房间号加入 ----------
    console.log('\n--- ② 按房间号加入 ---');
    send(B, { t: 'joinCode', code });
    await wait(220);
    send(C, { t: 'joinCode', code });
    await wait(220);
    send(D, { t: 'joinCode', code });
    await wait(400);
    ok(!!last(B, 'roomOk'), `乙进房（${last(B, 'roomOk') && last(B, 'roomOk').seat + 1} 号位）`);
    ok(!!last(C, 'roomOk'), '丙进房');
    ok(!!last(D, 'roomOk'), '丁进房');
    const aFull = last(A, 'memberUpdate');
    const fullCount = aFull ? aFull.members.filter((m) => !m.empty).length : 0;
    ok(fullCount === 4, `房主看到 ${fullCount}/4 人`);

    // ---------- 3. 第 5 人满员被拒 ----------
    console.log('\n--- ③ 第 5 人进房 ---');
    send(E, { t: 'joinCode', code });
    await wait(400);
    const eErr = last(E, 'error');
    ok(!!eErr && eErr.code === 'ROOM_FULL', `被拒绝并提示「${eErr && eErr.msg}」`);

    // ---------- 4. 非房主没有开局/解散权限 ----------
    console.log('\n--- ④ 非房主权限 ---');
    send(B, { t: 'startGame' });
    await wait(250);
    const bErr = last(B, 'error');
    ok(!!bErr && /房主/.test(bErr.msg || ''), `非房主开局被拒：${bErr && bErr.msg}`);

    send(B, { t: 'dissolve' });
    await wait(250);
    const bErr2 = last(B, 'error');
    ok(!!bErr2 && /房主/.test(bErr2.msg || ''), `非房主解散被拒：${bErr2 && bErr2.msg}`);

    // ---------- 5. 房主退出 → 移交 ----------
    console.log('\n--- ⑤ 房主退出，房主移交 ---');
    clear(B); clear(C); clear(D);
    send(A, { t: 'leave' });
    await wait(600);
    const bUpd = last(B, 'memberUpdate');
    const newOwner = bUpd && bUpd.members.find((m) => m.owner);
    ok(!!newOwner, `出现新房主：${newOwner && newOwner.nickname}`);
    ok(!!newOwner && newOwner.nickname !== '甲', '新房主不是已退出的甲');
    ok(!!last(B, 'memberUpdate') && last(B, 'memberUpdate').members.filter((m) => !m.empty).length === 3,
        '剩 3 人，房间没解散');

    // ---------- 6. 新房主解散 ----------
    console.log('\n--- ⑥ 新房主解散房间 ---');
    const ownerBot = [B, C, D].find((x) => x.name === (newOwner && newOwner.nickname));
    clear(B); clear(C); clear(D);
    if (ownerBot) send(ownerBot, { t: 'dissolve' });
    await wait(500);
    const closedCount = [B, C, D].filter((x) => !!last(x, 'roomClosed')).length;
    ok(closedCount >= 2, `其余 ${closedCount} 人都收到 roomClosed`);

    // ---------- 7. 满员后房主开局 ----------
    console.log('\n--- ⑦ 房主手动开局 ---');
    const A2 = await makeBot('甲二');
    const B2 = await makeBot('乙二');
    const C2 = await makeBot('丙二');
    const D2 = await makeBot('丁二');
    await wait(200);
    send(A2, { t: 'create' });
    await wait(400);
    const code2 = last(A2, 'roomOk') && last(A2, 'roomOk').code;
    ok(!!code2, `新房间号 ${code2}`);

    // 人没满就想开局 → 应被拒绝
    send(A2, { t: 'startGame' });
    await wait(250);
    const notEnough = last(A2, 'error');
    ok(!!notEnough && /还差/.test(notEnough.msg || ''), `人没满开局被拒：${notEnough && notEnough.msg}`);

    send(B2, { t: 'joinCode', code: code2 });
    await wait(180);
    send(C2, { t: 'joinCode', code: code2 });
    await wait(180);
    send(D2, { t: 'joinCode', code: code2 });
    await wait(350);

    clear(A2); clear(B2); clear(C2); clear(D2);
    send(A2, { t: 'startGame' });
    await wait(900);
    const started = [A2, B2, C2, D2].filter((x) => !!last(x, 'roundStart')).length;
    ok(started === 4, `四家都收到 roundStart（${started}/4）`);

    // ---------- 收尾 ----------
    for (const b of [A, B, C, D, E, A2, B2, C2, D2]) {
        try { b.ws.close(); } catch (e) { /* 忽略 */ }
    }

    console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('测试异常:', err);
    process.exit(1);
});
