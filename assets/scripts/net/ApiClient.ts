/**
 * 账号 / 战绩服务客户端（backend · Spring Boot，默认 8081）
 *
 * 之前 backend 六个接口写好了却一次没被调用过：客户端只有本地存档，战绩不上云。
 * 这里补上最小闭环：
 *   1. 登录：微信环境先试 wx.login → /api/auth/wx；不行或没配置就退到 /api/auth/guest
 *      （游客登录带 openid=本地 playerId，后端据此认出同一个玩家，跨次登录不重复建号）
 *   2. 每局结束上报：POST /api/matches（只能上报自己这一条，符合后端权限规则）
 *   3. 查我的累计：GET /api/users/me
 *
 * 设计原则：**后端是可选增强，不是依赖**。
 *   - 后端没起 / 超时（4 秒）/ 报错 → 全部静默降级，牌局和本地积分照常；
 *   - 一次失败后 5 分钟内不再尝试，避免每局都卡 4 秒；
 *   - 浏览器用 XMLHttpRequest，微信小游戏用 wx.request（小游戏没有 XHR）。
 */
import { serverCfg, isWechat } from './Config';
import { identityStore, NetClient } from './NetClient';
import { wxLogin } from './WxAdapter';
import { loadProfile } from '../core/Profile';

declare const wx: any;

const TOKEN_KEY = 'wugui4.apiToken.v1';
const USER_KEY = 'wugui4.apiUser.v1';
/** 单次请求超时（ms）——宁可不记，也不让结算界面等人 */
const TIMEOUT = 4000;
/** 后端不可用后冷却时间（ms） */
const COOLDOWN = 5 * 60 * 1000;

export interface MyProfile {
    id: number;
    nickname: string;
    gender?: number;
    avatar?: string;
    totalGames?: number;
    totalWins?: number;
}

export class ApiClient {

    private static _inst: ApiClient | null = null;
    static get inst(): ApiClient {
        if (!ApiClient._inst) ApiClient._inst = new ApiClient();
        return ApiClient._inst;
    }

    token = '';
    /** 后端用户 id（不是联机服的 userId，两者独立） */
    userId = 0;
    nickname = '';
    /** 后端可用时的累计资料，界面想展示就读它 */
    me: MyProfile | null = null;

    private downUntil = 0;
    private logging = false;

    constructor() {
        try {
            const t = identityStore().getItem(TOKEN_KEY);
            if (t) this.token = t;
            const u = identityStore().getItem(USER_KEY);
            if (u) {
                const obj = JSON.parse(u);
                if (obj && typeof obj.id === 'number') { this.userId = obj.id; this.nickname = obj.nickname || ''; }
            }
        } catch (e) { /* 忽略 */ }
    }

    private base(): string {
        return serverCfg().http.replace(/\/+$/, '');
    }

    // ================= HTTP =================

    private request(method: string, path: string, body?: object): Promise<any> {
        const url = this.base() + path;
        const headers: { [k: string]: string } = { 'Content-Type': 'application/json' };
        if (this.token) headers.Authorization = 'Bearer ' + this.token;

        return new Promise((resolve, reject) => {
            let done = false;
            const ok = (v: any) => { if (!done) { done = true; resolve(v); } };
            const fail = (e: any) => { if (!done) { done = true; reject(e); } };

            if (isWechat()) {
                try {
                    wx.request({
                        url, method,
                        data: body,
                        header: headers,
                        timeout: TIMEOUT,
                        success: (res: any) => {
                            const code = res && typeof res.statusCode === 'number' ? res.statusCode : 0;
                            if (code >= 200 && code < 300) ok(res.data);
                            else fail(new Error('HTTP ' + code));
                        },
                        fail: (err: any) => fail(new Error((err && err.errMsg) || 'wx.request 失败')),
                    });
                } catch (e) { fail(e); }
                return;
            }

            try {
                const xhr = new XMLHttpRequest();
                xhr.open(method, url, true);
                xhr.timeout = TIMEOUT;
                for (const k of Object.keys(headers)) xhr.setRequestHeader(k, headers[k]);
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try { ok(xhr.responseText ? JSON.parse(xhr.responseText) : null); }
                        catch (e) { ok(null); }
                    } else fail(new Error('HTTP ' + xhr.status));
                };
                xhr.onerror = () => fail(new Error('网络错误（后端没启动？）'));
                xhr.ontimeout = () => fail(new Error('请求超时'));
                xhr.send(body ? JSON.stringify(body) : null);
            } catch (e) { fail(e); }
        });
    }

    // ================= 登录 =================

    private applyLogin(r: any): boolean {
        if (!r || typeof r.token !== 'string' || !r.user) return false;
        this.token = r.token;
        this.userId = r.user.id || 0;
        this.nickname = r.user.nickname || '';
        try {
            identityStore().setItem(TOKEN_KEY, this.token);
            identityStore().setItem(USER_KEY, JSON.stringify({ id: this.userId, nickname: this.nickname }));
        } catch (e) { /* 忽略 */ }
        cc.log(`[战绩服务] 已登录：${this.nickname}（userId=${this.userId}）`);
        return true;
    }

    /**
     * 确保已登录。已有 token 直接返回 true；否则走一次登录。
     * 绝不抛异常 —— 调用方不需要 try/catch。
     */
    async ensureLogin(): Promise<boolean> {
        if (this.token) return true;
        return this.login();
    }

    async login(): Promise<boolean> {
        if (this.logging) return false;
        if (Date.now() < this.downUntil) return false;
        this.logging = true;
        const p = loadProfile();
        const playerId = NetClient.inst.playerId || '';
        try {
            // 微信环境先试微信登录（需后端配置 appid/secret；没配后端会回 501）
            if (isWechat()) {
                try {
                    const code = await wxLogin();
                    const r = await this.request('POST', '/api/auth/wx', { code });
                    if (this.applyLogin(r)) return true;
                } catch (e) { /* 微信登录不可用 → 落到游客 */ }
            }
            // 游客登录：openid 用本地 playerId，后端据此认出同一个玩家
            const body: { nickname: string; openid?: string } = { nickname: p.nick };
            if (playerId) body.openid = playerId;
            const r = await this.request('POST', '/api/auth/guest', body);
            return this.applyLogin(r);
        } catch (err) {
            this.downUntil = Date.now() + COOLDOWN;
            cc.log('[战绩服务] 不可用，本局只记本地（不影响游戏）：' + (err as Error).message);
            return false;
        } finally {
            this.logging = false;
        }
    }

    // ================= 战绩 =================

    /**
     * 上报一局。mode: ONLINE 联机 / LOCAL 单机。
     * 静默失败：后端没起时什么都不会发生，玩家无感知。
     */
    async reportRound(o: { win: boolean; delta: number; seat: number; mode: 'ONLINE' | 'LOCAL' }): Promise<void> {
        try {
            if (!(await this.ensureLogin())) return;
            await this.request('POST', '/api/matches', {
                mode: o.mode,
                totalRounds: 1,
                players: [{
                    userId: this.userId,
                    seat: o.seat,
                    result: o.win ? 'WIN' : 'LOSE',
                    score: o.delta,
                }],
            });
        } catch (err) {
            cc.log('[战绩服务] 上报失败（不影响牌局）：' + (err as Error).message);
        }
    }

    /** 拉我的累计战绩（后端可用时才有值） */
    async fetchMe(): Promise<MyProfile | null> {
        try {
            if (!(await this.ensureLogin())) return null;
            const r = await this.request('GET', '/api/users/me');
            if (r && typeof r.id === 'number') { this.me = r; return r; }
        } catch (err) {
            cc.log('[战绩服务] 读取资料失败：' + (err as Error).message);
        }
        return null;
    }
}
