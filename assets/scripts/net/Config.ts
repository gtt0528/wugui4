/**
 * 乌龟4 —— 服务端地址与运行环境
 *
 * 之前地址写死在 NetClient 里：
 *   `location.hostname` 在浏览器里能拿到局域网 IP，但在微信小游戏里**没有 location**，
 *   于是必然回退到 ws://localhost —— 真机上连的就是手机自己，100% 连不上。
 *
 * 现在的取址顺序：
 *   1. 本地覆盖（`wugui4.server` 存在 localStorage 里，调试试玩时方便改，不用重新构建）
 *   2. 微信小游戏 → 用下面的 PROD_WS / PROD_HTTP（必须是 wss + 已备案域名）
 *   3. 浏览器 → 按当前页面 host 推断（保持原来的局域网联机体验）
 */

/** ⚠️ 上线前把这两个换成你自己的域名（需 ICP 备案 + 证书 + 微信后台 socket 合法域名） */
export const PROD_WS = 'wss://YOUR-DOMAIN.com/ws';
export const PROD_HTTP = 'https://YOUR-DOMAIN.com';

/** 本地/局域网默认端口，与 gameserver(8090) / backend(8081) 保持一致 */
export const DEV_WS_PORT = 8090;
export const DEV_HTTP_PORT = 8081;

const KEY = 'wugui4.server';

export interface ServerCfg {
    /** WebSocket 地址 */
    ws: string;
    /** HTTP 接口地址（账号/战绩服务） */
    http: string;
}

declare const wx: any;

/** 是否运行在微信小游戏环境（用 connectSocket 判断，比 sys.platform 更可靠） */
export function isWechat(): boolean {
    try {
        return typeof wx !== 'undefined' && !!wx && typeof wx.connectSocket === 'function';
    } catch (e) {
        return false;
    }
}

function readOverride(): ServerCfg | null {
    try {
        const raw = cc.sys.localStorage.getItem(KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (obj && typeof obj.ws === 'string' && obj.ws) {
            return { ws: obj.ws, http: typeof obj.http === 'string' ? obj.http : obj.ws.replace(/^ws/, 'http') };
        }
    } catch (e) { /* 忽略 */ }
    return null;
}

/** 运行时设置服务端地址（调试用，会持久化） */
export function setServerOverride(ws: string, http?: string): void {
    const cfg: ServerCfg = { ws, http: http || ws.replace(/^ws/, 'http') };
    try { cc.sys.localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
}

/** 清除覆盖，回到自动推断 */
export function clearServerOverride(): void {
    try { cc.sys.localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
}

let cached: ServerCfg | null = null;

/** 当前应该连的服务端地址 */
export function serverCfg(): ServerCfg {
    if (cached) return cached;

    const override = readOverride();
    if (override) { cached = override; return cached; }

    // 微信小游戏：没有 location，只能走线上 wss 域名
    if (isWechat()) {
        cached = { ws: PROD_WS, http: PROD_HTTP };
        return cached;
    }

    // 浏览器：沿用「按当前页面 host 推断」，手机连热点/同一 Wi-Fi 时可直接联机
    try {
        const host = typeof location !== 'undefined' ? location.hostname : '';
        if (host && host !== 'localhost' && host !== '127.0.0.1') {
            cached = { ws: `ws://${host}:${DEV_WS_PORT}`, http: `http://${host}:${DEV_HTTP_PORT}` };
            return cached;
        }
    } catch (e) { /* 忽略 */ }

    cached = { ws: `ws://localhost:${DEV_WS_PORT}`, http: `http://localhost:${DEV_HTTP_PORT}` };
    return cached;
}

/** 线上配置是否还是占位符（用来在界面上给个明确提示，而不是让人对着超时发呆） */
export function prodNotConfigured(): boolean {
    return PROD_WS.indexOf('YOUR-DOMAIN') >= 0;
}
