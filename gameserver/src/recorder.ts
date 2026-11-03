/**
 * 对局记录落盘（JSONL）
 *
 * 每局结束追加一行到 `logs/rounds-YYYY-MM-DD.jsonl`。
 * 刻意不依赖 MySQL / Spring Boot：线下找人试玩时，只要起了对战服就有数据。
 * 后面接 backend 时，把这批 JSONL 批量导入 `/api/matches` 即可。
 *
 * 字段设计面向两件事：
 *   1) 你自己分析（完成率、掉线率、局时长、敌人胜率）
 *   2) 拿去和发行商/公司谈（同一批人第二天还来不来）
 */
import * as fs from 'fs';
import * as path from 'path';

export interface SeatRecord {
    seat: number;
    userId: number;
    nickname: string;
    /** 本局是否掉线过 */
    offline: boolean;
    /** 是否 AI 补位 */
    ai: boolean;
    /** 名次：1 导游 / 2 中游 / 3 尾游 / 0 未出完（敌人或被抓） */
    rank: number;
    /** 结束时的剩牌张数 */
    left: number;
}

export interface RoundRecord {
    /** 记录写入时间（ISO） */
    ts: string;
    /** 服务器本地时间戳（ms），便于算间隔 */
    at: number;
    roomId: string;
    roomCode: string;
    roundNo: number;
    /** 本局是否是从第 1 局开始的连续局（有交牌阶段） */
    hasExchange: boolean;
    enemySeat: number;
    enemyWin: boolean;
    /** 出完牌的顺序（座位号） */
    finishOrder: number[];
    seats: SeatRecord[];
    /** 本局时长（秒），从发牌到结算 */
    durationSec: number;
    /** 本局发生过掉线的座位 */
    offlineSeats: number[];
    /** AI 补位座位 */
    aiSeats: number[];
    /** 本局是否有真人中途超时被托管 */
    timeoutSeats: number[];
}

const LOG_DIR = process.env.WUGUI_LOG_DIR || path.join(process.cwd(), 'logs');

let dirReady = false;

function ensureDir(): boolean {
    if (dirReady) return true;
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        dirReady = true;
        return true;
    } catch (err) {
        console.error('[记录] 创建日志目录失败:', err);
        return false;
    }
}

function dayKey(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 追加一局记录。任何异常都只打日志，绝不影响牌局。
 */
export function appendRound(rec: RoundRecord): void {
    if (!ensureDir()) return;
    const file = path.join(LOG_DIR, `rounds-${dayKey(new Date(rec.at))}.jsonl`);
    try {
        fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    } catch (err) {
        console.error('[记录] 写入对局记录失败:', err);
    }
}

/** 统计用：当天文件路径（没有则返回 null） */
export function todayFile(): string | null {
    const file = path.join(LOG_DIR, `rounds-${dayKey(new Date())}.jsonl`);
    return fs.existsSync(file) ? file : null;
}
