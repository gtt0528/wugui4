/**
 * 乌龟4 —— 联机客户端（WebSocket 封装）
 *
 * 职责：连接对战服（gameserver）、收发 JSON 消息、把消息分发给当前界面。
 * 纯通道层，不含任何玩法逻辑——能不能出牌、出得合不合法，全部由服务器判定。
 *
 * 协议见 gameserver/src/server.ts 顶部注释。
 */

/** 对战服端口。与 gameserver 保持一致 */
const WS_PORT = 8090;

/**
 * 对战服地址：
 * - 自己用 http://localhost 打开游戏 → 连 ws://localhost（单机调试）
 * - 其它电脑用 http://<你的局域网IP>:7456 打开 → 自动连 ws://<你的局域网IP>（局域网联机）
 * - 微信小游戏等非浏览器环境没有 location.hostname，回退到 localhost
 */
export const WS_URL = ((): string => {
    try {
        const host = typeof location !== 'undefined' ? location.hostname : '';
        if (host && host !== 'localhost' && host !== '127.0.0.1') return `ws://${host}:${WS_PORT}`;
    } catch (e) { /* ignore */ }
    return `ws://localhost:${WS_PORT}`;
})();

/** 服务器消息的最小类型描述（只声明客户端关心的字段） */
export interface ServerMsg {
    t: string;
    [key: string]: any;
}

export type MsgHandler = (msg: ServerMsg) => void;

export class NetClient {

    private static _inst: NetClient | null = null;
    static get inst(): NetClient {
        if (!NetClient._inst) NetClient._inst = new NetClient();
        return NetClient._inst;
    }

    ws: WebSocket | null = null;
    connected = false;
    userId = 0;
    nickname = '';
    mySeat = -1;
    roomId = '';

    /** 当前界面的消息回调（换场景时由新界面接管） */
    onMsg: MsgHandler | null = null;
    /** 连接断开回调（界面用来弹「连接已断开」） */
    onClosed: (() => void) | null = null;

    /**
     * 建立连接。已连着就直接成功（重复点「开始匹配」不会开第二条连接）。
     */
    connect(url: string = WS_URL): Promise<void> {
        if (this.connected && this.ws) return Promise.resolve();
        return new Promise((resolve, reject) => {
            try {
                const ws = new WebSocket(url);
                this.ws = ws;
                let settled = false;
                const failTimer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    try { ws.close(); } catch (e) { /* 忽略 */ }
                    reject(new Error('连接超时'));
                }, 6000);

                ws.onopen = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(failTimer);
                    this.connected = true;
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
                    this.mySeat = -1;
                    this.roomId = '';
                    if (!settled) {
                        settled = true;
                        clearTimeout(failTimer);
                        reject(new Error('连接已关闭'));
                        return;
                    }
                    if (this.onClosed) this.onClosed();
                };
                ws.onmessage = (ev: MessageEvent) => {
                    let msg: ServerMsg;
                    try {
                        msg = JSON.parse(String(ev.data));
                    } catch (e) {
                        cc.warn('[乌龟4] 收到非 JSON 消息:', ev.data);
                        return;
                    }
                    if (this.onMsg) this.onMsg(msg);
                };
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    send(obj: object): void {
        if (!this.ws || this.ws.readyState !== 1) {
            cc.warn('[乌龟4] 连接不可用，消息未发送:', JSON.stringify(obj));
            return;
        }
        this.ws.send(JSON.stringify(obj));
    }

    /** 登录（进服务器大门），带个人资料供同桌显示 */
    login(nickname: string, gender = 0, avatar = ''): void {
        this.nickname = nickname;
        this.send({ t: 'login', nickname, gender, avatar });
    }

    /** 快速匹配进房 */
    join(): void {
        this.send({ t: 'join' });
    }

    /** 准备开局 */
    ready(): void {
        this.send({ t: 'ready' });
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

    /** 断开（退出联机时调用） */
    close(): void {
        this.onMsg = null;
        this.onClosed = null;
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* 忽略 */ }
        }
        this.ws = null;
        this.connected = false;
        this.mySeat = -1;
        this.roomId = '';
    }
}
