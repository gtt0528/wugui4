/**
 * 乌龟4 —— 玩家数据（本地存储版）
 *
 * 现阶段是单机版，积分/战绩全部存在玩家手机本地：
 *   - 浏览器预览：localStorage
 *   - 微信小游戏：wx.getStorageSync（Cocos 的 sys.localStorage 已自动桥接）
 * 以后接联机时，把 load/save 换成云开发即可，外部调用方式不变。
 *
 * 积分规则：初始 1000，赢一局 +15，输一局 -10，最低 0。
 */

const KEY = 'wugui4.profile.v1';

export const INIT_SCORE = 1000;
export const SCORE_WIN = 15;
export const SCORE_LOSE = -10;

export interface Profile {
    /** 昵称 */
    nick: string;
    /** 性别：0 未知 1 男 2 女（首次进入时填写，联机时展示给同桌） */
    gender: number;
    /** 当前积分 */
    score: number;
    /** 累计胜局 */
    wins: number;
    /** 累计负局 */
    losses: number;
    /** 累计局数 */
    rounds: number;
    /** 最高连胜 */
    bestStreak: number;
    /** 当前连胜 */
    streak: number;
}

function defaultProfile(): Profile {
    return {
        nick: '玩家' + Math.floor(1000 + Math.random() * 9000),
        gender: 0,
        score: INIT_SCORE,
        wins: 0,
        losses: 0,
        rounds: 0,
        bestStreak: 0,
        streak: 0,
    };
}

let cache: Profile | null = null;

/** 读取玩家数据（首次会创建） */
export function loadProfile(): Profile {
    if (cache) return cache;
    try {
        const raw = cc.sys.localStorage.getItem(KEY);
        if (raw) {
            const obj = JSON.parse(raw);
            cache = Object.assign(defaultProfile(), obj);
            return cache;
        }
    } catch (e) {
        cc.warn('[乌龟4] 读取存档失败，使用默认数据', e);
    }
    cache = defaultProfile();
    saveProfile(cache);
    return cache;
}

/** 写回存档 */
export function saveProfile(p?: Profile): void {
    const data = p || cache;
    if (!data) return;
    cache = data;
    try {
        cc.sys.localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
        cc.warn('[乌龟4] 保存存档失败', e);
    }
}

/** 结算一局后更新积分，返回本局积分变化 */
export function applyRoundResult(win: boolean): number {
    const p = loadProfile();
    p.rounds += 1;
    let delta = 0;
    if (win) {
        delta = SCORE_WIN;
        p.wins += 1;
        p.streak += 1;
        if (p.streak > p.bestStreak) p.bestStreak = p.streak;
    } else {
        delta = SCORE_LOSE;
        p.losses += 1;
        p.streak = 0;
    }
    p.score = Math.max(0, p.score + delta);
    saveProfile(p);
    return delta;
}

/** 积分是否够开一局（不够时提示看广告 / 明日再战） */
export function canPlay(): boolean {
    return loadProfile().score > 0;
}

/** 积分不足时的救济：直接补 50 分（正式版改成看激励视频广告） */
export const RELIEF_SCORE = 50;

export function applyRelief(): void {
    const p = loadProfile();
    p.score = Math.max(p.score, RELIEF_SCORE);
    saveProfile(p);
}

/** 胜率（0~100 的整数） */
export function winRate(): number {
    const p = loadProfile();
    if (p.rounds === 0) return 0;
    return Math.round((p.wins / p.rounds) * 100);
}
