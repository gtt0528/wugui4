/**
 * 乌龟4 联机对战服入口
 *   ws://localhost:8090
 *
 * 协议（JSON）：
 *   客户端 → 服务器：
 *     {t:'login', nickname, gender?, avatar?, userId?, token?}
 *         登录。首次登录由**服务器签发** userId + token；重连时带上这两个值即可坐回原位。
 *         客户端传来的 userId 不会被直接采信（旧版可以伪造 userId 顶掉别人座位）。
 *     {t:'join'}                         快速匹配（房间号房间不参与）
 *     {t:'create', nickname?}            开一个带房间号的私有房
 *     {t:'joinCode', code}               用房间号进房
 *     {t:'ready'}                        准备（快速匹配房：人齐且全员 ready 自动开局）
 *     {t:'startGame'}                    房主手动开局（私有房：满 4 人后由房主点「开始游戏」）
 *     {t:'dissolve'}                     房主解散房间（广播 roomClosed，其他人回主菜单）
 *     {t:'act', kind:'auto'|'play'|'pass', cards?: number[]}
 *     {t:'next'}                         一局结束后「再来一局」（需全员）
 *     {t:'sync'}                         要一份当前牌局快照（重连/进场景）
 *     {t:'ping'}                         应用层心跳（可选）
 *   服务器 → 客户端：
 *     {t:'loginOk', userId, token, nickname}
 *     {t:'roomOk', roomId, code, isPrivate, ownerSeat, seat, members}
 *          members 每项含 {seat, userId, nickname, gender, avatar, connected, owner}，
 *          空位是 {seat, empty:true}。客户端据此画房间等待页。
 *     {t:'roomClosed', msg}              房间解散（房主解散 / 有人退出 / 房主离开）
 *     {t:'error', code?, msg}            code 用于机器判断：ROOM_FULL / NO_ROOM / BAD_CODE
 *     {t:'roundStart' | 'hand' | 'turn' | 'played' | 'state' | 'roundEnd' | 'tip' | ...}
 *
 * 稳定性：
 *   - 服务器每 20 秒 ws.ping()，两轮没回 pong 就 terminate（移动网络下"假活"连接会被清掉）
 *   - 牌局中掉线不解散房间，座位保留，超时托管继续打（见 room.ts）
 *   - 快速匹配等 30 秒还没满 4 人 → AI 补位开局
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Room } from './room';
import { Phase } from '../../assets/scripts/core/GameEngine';

const PORT = Number(process.env.PORT || 8090);
/** 快速匹配最多等多久（毫秒），超时用 AI 补位 */
const MATCH_WAIT_MS = Number(process.env.MATCH_WAIT_MS || 30000);
/** 心跳间隔：两轮（40 秒）没有 pong 视为死连接 */
const HEARTBEAT_MS = 20000;
/** 单条消息上限（字节），超了直接断开，防内存攻击 */
const MAX_MSG_BYTES = 16 * 1024;

const wss = new WebSocketServer({ port: PORT });
const rooms: Room[] = [];
/** 所有在线连接的状态表：房间解散时要逐一解绑 */
const clients = new Map<WebSocket, ClientState>();
/** 服务器签发的身份：userId → token。进程重启会失效（客户端会重新游客登录） */
const tokens = new Map<number, string>();
/** 心跳存活标记 */
const alive = new Map<WebSocket, boolean>();

interface ClientState {
    userId: number;
    playerId: string;               // 客户端持久设备号（跨重启稳定，落盘用）
    nickname: string;
    gender: number;                 // 0 未知 1 男 2 女
    avatar: string;
    room: Room | null;
    seat: number;
    /** 本秒内的消息计数（简易限流） */
    msgWindow: number;
    msgWindowAt: number;
}

// ============ 玩家档案落盘：playerId → 稳定 userId ============
// 目的：userId 不再进程内自增（重启归零 → 跨天留存全断）。
// 客户端首次进游戏生成 playerId 并持久保存，登录时带上；
// 服务器把 playerId → userId 的映射写进 data/players.json，重启不丢。
// 匿名连接（测试脚本等没带 playerId 的）从 90 万段发临时号，绝不和落盘玩家撞号。

interface PlayerProfile {
    userId: number;
    nickname: string;
    firstSeen: number;
    lastSeen: number;
}

const PLAYERS_FILE = process.env.WUGUI_PLAYERS_FILE || path.join(process.cwd(), 'data', 'players.json');
const players = new Map<string, PlayerProfile>();
let nextUserId = 100001;

function loadPlayers(): void {
    try {
        if (fs.existsSync(PLAYERS_FILE)) {
            const obj = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
            const map = obj && typeof obj === 'object' ? obj.map : null;
            if (map && typeof map === 'object') {
                for (const k of Object.keys(map)) {
                    const v = map[k];
                    if (v && typeof v.userId === 'number') players.set(k, v as PlayerProfile);
                }
            }
            if (typeof obj.nextUserId === 'number' && obj.nextUserId > nextUserId) {
                nextUserId = obj.nextUserId;
            }
        }
    } catch (err) {
        console.error('[玩家档案] 读取失败，按空表启动:', err);
    }
}

function savePlayers(): void {
    try {
        const dir = path.dirname(PLAYERS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const map: Record<string, PlayerProfile> = {};
        for (const [k, v] of players) map[k] = v;
        fs.writeFileSync(PLAYERS_FILE, JSON.stringify({ nextUserId, map }), 'utf8');
    } catch (err) {
        console.error('[玩家档案] 写入失败:', err);
    }
}
loadPlayers();

/** 匿名连接的临时编号（900001 起，与落盘玩家号段隔离） */
let anonSeq = 900001;

wss.on('connection', (ws: WebSocket) => {
    const st: ClientState = {
        userId: 0, playerId: '', nickname: '', gender: 0, avatar: '',
        room: null, seat: -1, msgWindow: 0, msgWindowAt: Date.now(),
    };
    clients.set(ws, st);
    alive.set(ws, true);

    ws.on('pong', () => alive.set(ws, true));

    ws.on('message', (raw: Buffer) => {
        // 限流：单连接每秒最多 40 条（正常操作远低于此）
        const now = Date.now();
        if (now - st.msgWindowAt > 1000) { st.msgWindowAt = now; st.msgWindow = 0; }
        if (++st.msgWindow > 40) return;

        if (raw.length > MAX_MSG_BYTES) {
            ws.send(JSON.stringify({ t: 'error', msg: '消息过大' }));
            ws.close();
            return;
        }

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
        alive.delete(ws);
        if (!st.room || st.seat < 0) return;
        const room = st.room;
        const seat = st.seat;
        st.room = null;
        st.seat = -1;
        // 未开局（或本局已结束）→ 真正退房并广播成员变化；牌局进行中 → 只标离线，座位保留
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

// 心跳：两轮没回 pong 说明连接已死（手机切后台、地铁断网常见），主动回收座位
setInterval(() => {
    for (const ws of wss.clients) {
        if (alive.get(ws) === false) {
            console.log('[心跳] 连接无响应，断开回收');
            try { ws.terminate(); } catch { /* 忽略 */ }
            continue;
        }
        alive.set(ws, false);
        try { ws.ping(); } catch { /* 忽略 */ }
    }
}, HEARTBEAT_MS);

// 匹配超时 → AI 补位，别让玩家永远停在 1/4 人
setInterval(() => {
    for (const r of rooms.slice()) {
        if (r.closed || r.isPrivate || r.full()) continue;
        if (r.realCount() === 0) continue;
        const p = r.engine.phase;
        if (p === Phase.EXCHANGE || p === Phase.PLAYING) continue;
        if (Date.now() - r.waitSince >= MATCH_WAIT_MS) {
            console.log(`[房间${r.id}] 匹配超时，AI 补位`);
            r.fillWithAI();
        }
    }
}, 2000);

function handle(ws: WebSocket, st: ClientState, msg: Record<string, unknown>): void {
    switch (msg.t) {
        case 'login': {
            const rawNick = String(msg.nickname || '玩家').slice(0, 16);
            const wantId = typeof msg.userId === 'number' ? msg.userId : 0;
            const wantToken = typeof msg.token === 'string' ? msg.token : '';
            // 客户端持久设备号：跨服务重启认人用（只作档案键，不能用于顶别人座位）
            const playerId = typeof msg.playerId === 'string' ? msg.playerId.trim().slice(0, 64) : '';

            // 只接受服务器自己签发过的身份；客户端瞎传的 userId 一律不认
            const valid = wantId > 0 && wantToken.length > 0 && tokens.get(wantId) === wantToken;

            let userId: number;
            if (valid) {
                userId = wantId;
            } else if (playerId) {
                // 老玩家：playerId 已落盘 → 拿回原来的 userId（重启也不变）
                const prof = players.get(playerId);
                if (prof) {
                    userId = prof.userId;
                    prof.nickname = rawNick;
                    prof.lastSeen = Date.now();
                } else {
                    userId = nextUserId++;
                    players.set(playerId, { userId, nickname: rawNick, firstSeen: Date.now(), lastSeen: Date.now() });
                }
                savePlayers();
            } else {
                // 匿名连接（测试脚本 / 老客户端）：发临时号，不落盘
                userId = anonSeq++;
            }

            const token = randomBytes(16).toString('hex');
            tokens.set(userId, token);

            st.nickname = rawNick;
            st.userId = userId;
            st.playerId = playerId;
            st.gender = typeof msg.gender === 'number' ? msg.gender : 0;
            st.avatar = typeof msg.avatar === 'string' ? msg.avatar.slice(0, 512) : '';
            ws.send(JSON.stringify({
                t: 'loginOk', userId, token, nickname: st.nickname, playerId,
            }));
            return;
        }
        case 'join': {
            if (!st.userId) { ws.send(JSON.stringify({ t: 'error', msg: '请先 login' })); return; }
            if (st.room) { ws.send(JSON.stringify({ t: 'error', msg: '你已在房间里' })); return; }
            // 优先挤进「人数最多但还没满」的公开房，避免零散玩家各开一张新桌永远凑不齐
            const candidates = rooms
                .filter((r) => !r.full() && !r.isPrivate)
                .sort((a, b) => b.realCount() - a.realCount());
            let room = candidates[0];
            if (!room) {
                room = new Room(false);
                rooms.push(room);
            }
            enterRoom(ws, st, room);
            return;
        }
        case 'create': {
            if (!st.userId) { ws.send(JSON.stringify({ t: 'error', msg: '请先 login' })); return; }
            if (st.room) { ws.send(JSON.stringify({ t: 'error', msg: '你已在房间里' })); return; }
            const room = new Room(true);
            rooms.push(room);
            enterRoom(ws, st, room);
            return;
        }
        case 'joinCode': {
            if (!st.userId) { ws.send(JSON.stringify({ t: 'error', msg: '请先 login' })); return; }
            if (st.room) { ws.send(JSON.stringify({ t: 'error', msg: '你已在房间里' })); return; }
            const code = String(msg.code || '').trim();
            if (!/^\d{6}$/.test(code)) {
                ws.send(JSON.stringify({ t: 'error', code: 'BAD_CODE', msg: '房间号是 6 位数字' }));
                return;
            }
            const room = rooms.find((r) => r.code === code && !r.closed);
            if (!room) {
                ws.send(JSON.stringify({ t: 'error', code: 'NO_ROOM', msg: '房间号不存在或已解散' }));
                return;
            }
            if (room.full()) {
                ws.send(JSON.stringify({ t: 'error', code: 'ROOM_FULL', msg: '房间已满' }));
                return;
            }
            enterRoom(ws, st, room);
            return;
        }
        case 'startGame': {
            if (!st.room) { ws.send(JSON.stringify({ t: 'error', msg: '你不在任何房间里' })); return; }
            st.room.startGame(st.seat);
            return;
        }
        case 'dissolve': {
            if (!st.room) { ws.send(JSON.stringify({ t: 'error', msg: '你不在任何房间里' })); return; }
            const room = st.room;
            room.dissolveBy(st.seat);
            destroyIfDone(room);
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
        case 'leave': {
            // 主动退出：座位立刻释放、房间按规则解散。掉线（ws 断开但没发 leave）不走这里。
            if (!st.room) return;
            const room = st.room;
            const seat = st.seat;
            st.room = null;
            st.seat = -1;
            room.forceLeave(seat);
            destroyIfDone(room);
            try { ws.close(); } catch { /* 忽略 */ }
            return;
        }
        case 'ping': {
            ws.send(JSON.stringify({ t: 'pong' }));
            return;
        }
        default:
            ws.send(JSON.stringify({ t: 'error', msg: '未知消息类型: ' + msg.t }));
    }
}

/** 进房 + 下发 roomOk + 广播成员变化（join / create / joinCode 共用） */
function enterRoom(ws: WebSocket, st: ClientState, room: Room): void {
    const seat = room.join(st.userId, st.nickname, ws, st.gender, st.avatar, st.playerId);
    if (seat === null) {
        ws.send(JSON.stringify({ t: 'error', code: 'ROOM_FULL', msg: '房间已满' }));
        return;
    }
    st.room = room;
    st.seat = seat;
    ws.send(JSON.stringify({
        t: 'roomOk',
        roomId: room.id,
        code: room.code,
        isPrivate: room.isPrivate,
        ownerSeat: room.ownerSeat,
        seat,
        members: room.membersView(),
    }));
    room.broadcast({ t: 'memberUpdate', members: room.membersView() });
}

console.log(`[乌龟4 对战服] 已启动 ws://localhost:${PORT}`);
