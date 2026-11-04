/**
 * 乌龟4 —— 联机客户端（WebSocket 封装）
 *
 * 职责：连接对战服、收发 JSON 消息、把消息分发给当前界面。
 * 纯通道层，不含任何玩法逻辑——能不能出牌、出得合不合法，全部由服务器判定。
 *
 * 相比旧版的三个改动：
 *   1. 地址不再写死：走 Config.ts（微信小游戏 → wss 备案域名；浏览器 → 当前局域网 IP）
 *   2. 心跳：每 15 秒 ping 一次，45 秒收不到任何消息就判定断线（移动网络"假活"连接）
 *   3. 自动重连：断线后带「服务器签发的 userId + token」重连，由服务器把人放回原座位，
 *      再 sync 拉一份牌局快照——手机上切后台回来不用重新匹配。
 *
 * 协议见 gameserver/src/server.ts 顶部注释。
 */
import { serverCfg } from './Config';

/** 服务器消息的最小类型描述（只声明客户端关心的字段） */
export interface ServerMsg {
    t: string;
    [key: string]: any;
}

export type MsgHandler = (msg: ServerMsg) => void;

/** 身份（服务器签发）存档 key */
const ID_KEY = 'wugui4.identity.v1';
/** 玩家持久设备号存档 key（跨服务重启不变，用来算跨天留存） */
const PLAYER_ID_KEY = 'wugui4.playerId.v1';

/**
 * 身份存在哪 —— 这里决定了「一台电脑能开几个玩家」。
 *
 * localStorage 是**同源全局共享**的：同一浏览器的 4 个标签页会读到同一个 userId+token，
 * 服务器认为这 4 条连接是同一个人重连，只给一个座位 —— 想开 4 个网页自测是永远凑不齐的。
 * sessionStorage 按标签页隔离、刷新保留、关标签即清，正好符合"每个网页一个玩家"。
 * 微信小游戏没有 sessionStorage（一台设备就是一个玩家），退回 localStorage。
 */
export function identityStore(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
    try {
        if (typeof sessionStorage !== 'undefined' && sessionStorage) {
            return sessionStorage as unknown as { getItem(k: string): string | null; setItem(k: string, v: string): void };
        }
    } catch (e) { /* 隐私模式下访问可能抛错，退回 localStorage */ }
    return cc.sys.localStorage as unknown as { getItem(k: string): string | null; setItem(k: string, v: string): void };
}
/** 心跳间隔与判定断线的静默时长（ms） */
const HB_INTERVAL = 15000;
const HB_SILENCE = 45000;
/** 最多自动重连几次（每次间隔递增） */
const MAX_RETRY = 5;

interface Identity { userId: number; token: string; }

export class NetClient {

    private static _inst: NetClient | null = null;
    static get inst(): NetClient {
        if (!NetClient._inst) NetClient._inst = new NetClient();
        return NetClient._inst;
    }

    ws: WebSocket | null = null;
    connected = false;
    userId = 0;
    token = '';
    nickname = '';
    gender = 0;
    avatar = '';
    mySeat = -1;
    roomId = '';
    roomCode = '';

    /** 当前界面的消息回调（换场景时由新界面接管） */
    onMsg: MsgHandler | null = null;
    /** 连接彻底失败（重连若干次仍不行）时通知界面 */
    onClosed: (() => void) | null = null;
    /** 正在重连（界面可显示"网络不稳，正在重连 2/5"） */
    onReconnecting: ((tries: number) => void) | null = null;

    private url = '';
    private hbTimer: any = null;
    private lastRecvAt = 0;
    private manualClose = false;
    private reconnecting = false;
    private reconnectTries = 0;
    private reconnectTimer: any = null;

    // ================= 身份 =================

    private loadIdentity(): Identity | null {
        try {
            const raw = identityStore().getItem(ID_KEY);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (obj && typeof obj.userId === 'number' && typeof obj.token === 'string') return obj;
        } catch (e) { /* 忽略 */ }
        return null;
    }

    private saveIdentity(id: Identity): void {
        this.userId = id.userId;
        this.token = id.token;
        try { identityStore().setItem(ID_KEY, JSON.stringify(id)); } catch (e) { /* 忽略 */ }
    }

    /**
     * 持久设备号：首次进入生成一次，之后一直沿用。
     *
     * 为什么需要它：服务器的 userId 是服务器发的，早期的实现存在内存里、重启就从头
     * 编号——同一个真人第二天再来会变成另一个人，跨天留存算不出来。这个号存在玩家
     * 设备上，重启服务、换进程都不影响，服务端据此把老玩家认回来。
     *
     * 存在同一个 store 里：微信小游戏 = localStorage（一台设备一个玩家）；
     * 浏览器 = sessionStorage（一个标签页一个玩家，方便一台电脑开 4 个网页自测）。
     */
    playerId = '';

    private ensurePlayerId(): string {
        if (this.playerId) return this.playerId;
        try {
            const saved = identityStore().getItem(PLAYER_ID_KEY);
            if (saved && saved.length >= 8) { this.playerId = saved; return saved; }
        } catch (e) { /* 忽略 */ }
        // 不依赖 crypto.randomUUID（老 webview / 微信基础库不一定有），自己拼一个够用的
        const rand = () => Math.random().toString(36).slice(2, 10);
        const id = 'p' + Date.now().toString(36) + '-' + rand() + rand();
        this.playerId = id;
        try { identityStore().setItem(PLAYER_ID_KEY, id); } catch (e) { /* 忽略 */ }
        return id;
    }

    // ================= 连接 =================

    /**
     * 建立连接。已连着就直接成功（重复点「开始匹配」不会开第二条连接）。
     */
    connect(url?: string): Promise<void> {
        if (this.connected && this.ws) return Promise.resolve();
        const target = url || serverCfg().ws;
        this.url = target;
        this.manualClose = false;

        return new Promise((resolve, reject) => {
            try {
                const ws = new WebSocket(target);
                this.ws = ws;
                let settled = false;
                const failTimer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    try { ws.close(); } catch (e) { /* 忽略 */ }
                    reject(new Error('连接超时'));
                }, 8000);

                ws.onopen = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(failTimer);
                    this.connected = true;
                    this.lastRecvAt = Date.now();
                    this.startHeartbeat();
                    resolve();
                };
                ws.onerror = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(failTimer);
                    reject(new Error('无法连接对战服'));
                };
                ws.onclose = () => {
                    this.connected = false;
                    this.ws = null;
                    this.stopHeartbeat();
                    if (!settled) {
                        settled = true;
                        clearTimeout(failTimer);
                        reject(new Error('连接已关闭'));
                        return;
                    }
                    // 主动关闭不重连；其余情况（切后台、锁屏、Wi-Fi 切换）自动重连
                    if (this.manualClose) {
                        if (this.onClosed) this.onClosed();
                        return;
                    }
                    this.scheduleReconnect();
                };
                ws.onmessage = (ev: MessageEvent) => {
                    this.lastRecvAt = Date.now();
                    let msg: ServerMsg;
                    try {
                        msg = JSON.parse(String(ev.data));
                    } catch (e) {
                        cc.warn('[乌龟4] 收到非 JSON 消息:', ev.data);
                        return;
                    }

                    // 服务器签发的身份：登录成功就存下来，下次（重连）带回去
                    if (msg.t === 'loginOk') {
                        this.saveIdentity({ userId: msg.userId, token: msg.token });
                        if (this.reconnecting) {
                            // 重连成功：悄悄坐回原位并拉快照，不打扰界面流程
                            this.reconnecting = false;
                            this.reconnectTries = 0;
                            if (this.roomCode) this.send({ t: 'joinCode', code: this.roomCode });
                            else this.send({ t: 'join' });
                            setTimeout(() => this.sync(), 400);
                            return;
                        }
                    }
                    if (msg.t === 'roomOk') {
                        this.mySeat = msg.seat;
                        this.roomId = msg.roomId;
                        if (msg.code) this.roomCode = String(msg.code);
                    }

                    if (this.onMsg) this.onMsg(msg);
                };
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    // ================= 心跳与重连 =================

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.hbTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== 1) return;
            if (Date.now() - this.lastRecvAt > HB_SILENCE) {
                cc.warn('[乌龟4] 心跳静默超时，主动断开重连');
                try { this.ws.close(); } catch (e) { /* 忽略 */ }
                return;
            }
            this.send({ t: 'ping' });
        }, HB_INTERVAL);
    }

    private stopHeartbeat(): void {
        if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    }

    private scheduleReconnect(): void {
        if (this.manualClose) return;
        if (this.reconnectTries >= MAX_RETRY) {
            cc.warn('[乌龟4] 重连失败，放弃');
            this.reconnecting = false;
            if (this.onClosed) this.onClosed();
            return;
        }
        this.reconnectTries++;
        this.reconnecting = true;
        if (this.onReconnecting) this.onReconnecting(this.reconnectTries);

        const delay = 800 * this.reconnectTries;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.connect(this.url).then(() => {
                this.login(this.nickname, this.gender, this.avatar);
            }).catch(() => {
                this.scheduleReconnect();
            });
        }, delay);
    }

    // ================= 发送 =================

    send(obj: object): void {
        if (!this.ws || this.ws.readyState !== 1) {
            cc.warn('[乌龟4] 连接不可用，消息未发送:', JSON.stringify(obj));
            return;
        }
        this.ws.send(JSON.stringify(obj));
    }

    /**
     * 登录（进服务器大门），带个人资料供同桌显示。
     * 首次登录服务器会签发 userId + token；之后每次登录都会带上，用于"坐回原位"。
     */
    login(nickname: string, gender = 0, avatar = ''): void {
        this.nickname = nickname;
        this.gender = gender;
        this.avatar = avatar;
        const id = this.loadIdentity();
        const msg: ServerMsg = { t: 'login', nickname, gender, avatar, playerId: this.ensurePlayerId() };
        if (id) { msg.userId = id.userId; msg.token = id.token; }
        this.send(msg);
    }

    /** 快速匹配进房 */
    join(): void {
        this.send({ t: 'join' });
    }

    /** 开一个带房间号的私有房（邀请好友用） */
    create(): void {
        this.send({ t: 'create' });
    }

    /** 用 6 位房间号进房 */
    joinCode(code: string): void {
        this.send({ t: 'joinCode', code });
    }

    /** 准备开局（快速匹配房用；私有房由房主手动开局） */
    ready(): void {
        this.send({ t: 'ready' });
    }

    /** 房主手动开局（私有房：人齐后由房主触发） */
    startGame(): void {
        this.send({ t: 'startGame' });
    }

    /** 房主解散房间 */
    dissolve(): void {
        this.send({ t: 'dissolve' });
    }

    /** 提交动作：出牌 / 跳过 / 交牌 / 托管 */
    act(kind: 'play' | 'pass' | 'auto', cards?: number[]): void {
        const msg: ServerMsg = { t: 'act', kind };
        if (cards && cards.length) msg.cards = cards;
        this.send(msg);
    }

    /** 请求开下一局 */
    next(): void {
        this.send({ t: 'next' });
    }

    /** 向服务器要当前牌局快照（进场/重连时用） */
    sync(): void {
        this.send({ t: 'sync' });
    }

    /** 断开（退出联机时调用）——主动断开不会触发自动重连 */
    close(): void {
        this.manualClose = true;
        // 先明确告诉服务器「我是主动退出」。
        // 不发这条，服务器会当成掉线、把座位留着等你回来（手机切后台就是走那条路）。
        if (this.ws && this.ws.readyState === 1) {
            try { this.ws.send(JSON.stringify({ t: 'leave' })); } catch (e) { /* 忽略 */ }
        }
        this.reconnecting = false;
        this.reconnectTries = 0;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.stopHeartbeat();
        this.onMsg = null;
        this.onClosed = null;
        this.onReconnecting = null;
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* 忽略 */ }
        }
        this.ws = null;
        this.connected = false;
        this.mySeat = -1;
        this.roomId = '';
        this.roomCode = '';
    }
}
