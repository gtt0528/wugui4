/**
 * 冒烟测试：4 个假客户端连上对战服，托管打完一整局。
 * 前置：npm run build && npm start（另开终端），或 PORT 环境变量指定端口。
 */
const WebSocket = require('ws');

const PORT = process.env.PORT || 8090;
const URL = `ws://localhost:${PORT}`;

function makeBot(nickname) {
    const ws = new WebSocket(URL);
    const bot = { ws, nickname, seat: -1, hand: [], turns: 0, errors: [], last: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'login', nickname })));
    ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        bot.last.push(m.t + (m.kind ? ':' + m.kind : ''));
        if (bot.last.length > 5) bot.last.shift();
        switch (m.t) {
            case 'loginOk':
                ws.send(JSON.stringify({ t: 'join' }));
                break;
            case 'roomOk':
                bot.seat = m.seat;
                ws.send(JSON.stringify({ t: 'ready' }));
                break;
            case 'hand':
                bot.hand = m.cards;
                break;
            case 'turn':
                bot.turns++;
                ws.send(JSON.stringify({ t: 'act', kind: 'auto' }));
                break;
            case 'error':
                bot.errors.push(m.msg);
                break;
            default:
                break;
        }
    });
    return bot;
}

async function main() {
    console.log('连接', URL, '…');
    const bots = [1, 2, 3, 4].map((i) => makeBot('bot' + i));

    const end = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            for (const b of bots) {
                console.error(`  [诊断] ${b.nickname} seat=${b.seat} turns=${b.turns} 最近消息=${b.last.join(' | ')} 错误=${b.errors.join(';') || '无'}`);
            }
            reject(new Error('60 秒内没打完一局'));
        }, 60000);
        bots[0].ws.on('message', (raw) => {
            const m = JSON.parse(raw.toString());
            if (m.t === 'roundEnd') {
                clearTimeout(timer);
                resolve(m.result);
            }
        });
    });

    console.log('✅ 一局打完，结算：', JSON.stringify(end));
    await new Promise((r) => setTimeout(r, 300));   // 等 bot 收完消息再退出
    for (const b of bots) {
        console.log(`  ${b.nickname}: 座位=${b.seat} 行动次数=${b.turns} 错误=${b.errors.length ? b.errors.join(';') : '无'}`);
        b.ws.close();
    }
    process.exit(0);
}

main().catch((e) => { console.error('❌ 冒烟测试失败:', e.message); process.exit(1); });
