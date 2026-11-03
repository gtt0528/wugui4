/**
 * 乌龟4 联机对战服入口
 *   ws://localhost:8090
 *
 * 协议（JSON）：
 *   客户端 → 服务器：
 *     {t:'login', nickname, userId?}     登录（userId 可选：有 token 体系后由 JWT 换）
 *     {t:'join'}                         快速加入一个有空位的房间（没有就开新桌）
 *     {t:'ready'}                        房间坐满后任意一人发即可开局
 *     {t:'act', kind:'auto'|'play'|'pass', cards?: number[]}
 *     {t:'next'}                         一局结束后开下一局
 *   服务器 → 客户端：
 *     {t:'loginOk', userId}
 *     {t:'roomOk', roomId, seat, members}
 *     {t:'roundStart', roundNo, enemySeat}
 *     {t:'hand', cards:[{id,name}]}      私密：只发给你自己的手牌
 *     {t:'turn', kind, hint, count}      轮到你行动
 *     {t:'played', seat, cards|pass}     广播：某人出了什么/跳过
 *     {t:'state', phase, lastPlaySeat}
 *     {t:'roundEnd', result}             本局结算
 *     {t:'error', msg}
 */
import { WebSocketServer, WebSocket } from 'ws';
import { Room } from './room';

const PORT = Number(process.env.PORT || 8090);

const wss = new WebSocketServer({ port: PORT });
const rooms: Room[] = [];
/** 所有在线连接的状态表：房间解散时要逐一解绑 */
const clients = new Map<WebSocket, ClientState>();

interface ClientState {
    userId: number;
    nickname: string;
    gender: number;                 // 0 未知 1 男 2 女
    avatar: string;
    room: Room | null;
    seat: number;
}

let guestSeq = 1;

wss.on('connection', (ws: WebSocket) => {
    const st: ClientState = { userId: 0, nickname: '', gender: 0, avatar: '', room: null, seat: -1 };
    clients.set(ws, st);

    ws.on('message', (raw: Buffer) => {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            ws.send(JSON.stringify({ t: 'error', msg: '消息不是合法 JSON' }));
            return;
        }
        try {
            handle(ws, st, msg);
        } catch (err) {
            console.error('[服务器] 处理消息出错:', err);
            ws.send(JSON.stringify({ t: 'error', msg: '服务器内部错误，动作未生效' }));
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        if (!st.room || st.seat < 0) return;
        const room = st.room;
        const seat = st.seat;
        st.room = null;
        st.seat = -1;
        // 未开局（或本局已结束）→ 真正退房并广播成员变化；牌局进行中 → 仅离线
        room.removeIfIdle(seat);
        destroyIfDone(room);
    });
});

/** 房间解散 / 空了 → 解绑所有成员并从房间列表移除（close 回调与定时清扫共用） */
function destroyIfDone(room: Room): void {
    if (!room.closed && !room.isEmpty()) return;
    for (const c of Array.from(clients.values())) {
        if (c.room === room) { c.room = null; c.seat = -1; }
    }
    room.dispose();
    const i = rooms.indexOf(room);
    if (i >= 0) rooms.splice(i, 1);
    console.log(`[房间${room.id}] ${room.closed ? '已解散' : '已空，销毁'}`);
}

// 兜底清扫：局结束清理（purgeOffline/dissolve）也可能关掉房间，每秒查一次
setInterval(() => {
    for (const r of rooms.slice()) destroyIfDone(r);
}, 1000);

function handle(ws: WebSocket, st: ClientState, msg: Record<string, unknown>): void {
    switch (msg.t) {
        case 'login': {
            st.nickname = String(msg.nickname || ('玩家' + guestSeq));
            st.userId = typeof msg.userId === 'number' ? msg.userId : 100000 + guestSeq++;
            st.gender = typeof msg.gender === 'number' ? msg.gender : 0;
            st.avatar = typeof msg.avatar === 'string' ? msg.avatar : '';
            ws.send(JSON.stringify({ t: 'loginOk', userId: st.userId, nickname: st.nickname }));
            return;
        }
        case 'join': {
            if (!st.userId) { ws.send(JSON.stringify({ t: 'error', msg: '请先 login' })); return; }
            if (st.room) { ws.send(JSON.stringify({ t: 'error', msg: '你已在房间里' })); return; }
            // 优先挤进「人数最多但还没满」的房间，避免零散玩家各开一张新桌永远凑不齐
            const candidates = rooms
                .filter((r) => !r.full())
                .sort((a, b) => b.humanCount() - a.humanCount());
            let room = candidates[0];
            if (!room) {
                room = new Room();
                rooms.push(room);
            }
            const seat = room.join(st.userId, st.nickname, ws, st.gender, st.avatar);
            if (seat === null) { ws.send(JSON.stringify({ t: 'error', msg: '房间满了' })); return; }
            st.room = room;
            st.seat = seat;
            ws.send(JSON.stringify({ t: 'roomOk', roomId: room.id, seat, members: room.membersView() }));
            room.broadcast({ t: 'memberUpdate', members: room.membersView() });
            return;
        }
        case 'ready': {
            if (!st.room) { ws.send(JSON.stringify({ t: 'error', msg: '请先 join' })); return; }
            st.room.markReady(st.seat);   // ready 随到随记，坐满且全员 ready 自动开局
            return;
        }
        case 'sync': {
            // 进场景 / 断线重连后要一份当前状态快照
            if (!st.room) { ws.send(JSON.stringify({ t: 'error', msg: '你不在任何房间里' })); return; }
            st.room.resync(st.seat);
            return;
        }
        case 'act': {
            if (!st.room) { ws.send(JSON.stringify({ t: 'error', msg: '你不在任何房间里' })); return; }
            st.room.handleAct(st.seat, {
                kind: typeof msg.kind === 'string' ? msg.kind : 'auto',
                cards: Array.isArray(msg.cards) ? (msg.cards as number[]) : undefined,
            });
            return;
        }
        case 'next': {
            if (!st.room) return;
            // 必须所有人都点了「再来一局」才开局；一个人点不会拉别人进场
            st.room.requestNext(st.seat);
            return;
        }
        default:
            ws.send(JSON.stringify({ t: 'error', msg: '未知消息类型: ' + msg.t }));
    }
}

console.log(`[乌龟4 对战服] 已启动 ws://localhost:${PORT}`);
