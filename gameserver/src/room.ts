/**
 * 房间：4 人一桌，服务器权威。
 *
 * 核心原则：
 *   - 客户端只发「动作」（出哪些牌 / 交哪些牌 / 跳过 / 托管），
 *     能不能做由服务器的 GameEngine 判定，客户端说了不算（防作弊）。
 *   - 引擎是纯逻辑（assets/scripts/core/GameEngine.ts），在这里原样跑，
 *     所有座位都由真人输入驱动（不走 aiAction，除非客户端发 auto 托管）。
 */
import { GameEngine, Phase, SEAT_COUNT } from '../../assets/scripts/core/GameEngine';
import type { Card } from '../../assets/scripts/core/Card';
import { parsePattern, canBeat } from '../../assets/scripts/core/Pattern';
import { appendRound, RoundRecord, SeatRecord } from './recorder';
import type { WebSocket } from 'ws';

/**
 * 计时参数（秒）。可用环境变量调，方便压测/试玩时缩短等待：
 *   WG_EX_WAIT=5 WG_PLAY_WAIT=5 npm start
 */
export const EXCHANGE_TIMEOUT = Number(process.env.WG_EX_WAIT || 20);
export const PLAY_TIMEOUT = Number(process.env.WG_PLAY_WAIT || 20);
/** AI 补位 / 已托管的座位"思考"时间（秒）——借同一条托管路径，不另写一套逻辑 */
export const AI_THINK = Number(process.env.WG_AI_THINK || 1);
/** 连续超时几次后进入托管（之后该座位每一步只等 AI_THINK 秒，不再拖全场） */
export const AUTO_PILOT_AFTER = 2;

export interface Member {
    seat: number;
    userId: number;
    nickname: string;
    gender: number;                 // 0 未知 1 男 2 女
    avatar: string;                 // 头像 URL（微信头像 / 默认头像标识），可为空
    ws: WebSocket | null;          // null = 掉线（可重连）
    /** 掉线时刻（ms）；重连后清空 */
    offlineAt?: number;
    /** 本局是否掉线过（只用于统计） */
    droppedThisRound?: boolean;
    /** 是否 AI 补位 */
    isAI?: boolean;
}

let roomSeq = 1;
let codeSeq = 100000;

/** 生成 6 位房间号（递增，保证同一进程内不重复） */
export function makeRoomCode(): string {
    return String(codeSeq++);
}

export class Room {
    id: string;
    /** 6 位房间号，给「创建房间 / 邀请好友」用 */
    code: string;
    /** 是否是「创建房间」开的私有房（不参与快速匹配） */
    isPrivate = false;
    members: (Member | null)[] = [null, null, null, null];
    engine: GameEngine;
    readyFlags = new Set<number>();   // 每个座位都 ready 才能开局，防止重复 startRound
    createdAt = Date.now();
    /** 敌人是否已暴露（持有方块4 的人第一次出牌时才公开） */
    revealed = false;
    /** 当前倒计时所在座位（-1 = 无人计时） */
    timerSeat = -1;
    /** 倒计时总秒数（供客户端画进度环） */
    timerTotal = 0;
    /** 倒计时截止的绝对时间戳（ms） */
    deadline = 0;
    private timer: NodeJS.Timeout | null = null;
    /** 本局开始时间（ms），用于统计局时长 */
    roundStartedAt = 0;
    /** 开始等人凑满的时间（ms），用于匹配超时 AI 补位 */
    waitSince = Date.now();
    /** 本局被「超时托管」推进过的座位（只统计真人） */
    timeoutSeats = new Set<number>();
    /** 每个座位连续超时次数（手动操作会清零） */
    private timeouts = new Map<number, number>();
    /** 已进入托管的座位：之后每一步只等 1 秒，别让一个人拖死全场 */
    private autoPilot = new Set<number>();

    constructor(isPrivate = false) {
        this.id = 'R' + String(roomSeq++).padStart(4, '0');
        this.code = makeRoomCode();
        this.isPrivate = isPrivate;
        this.engine = new GameEngine({ humanSeat: 0, minRounds: 1, allHuman: true });
    }

    full(): boolean {
        return this.members.every((m) => m !== null);
    }

    empty(): boolean {
        return this.members.every((m) => m === null);
    }

    humanCount(): number {
        return this.members.filter((m) => m !== null).length;
    }

    /** 返回 null=加入失败，否则返回分配的座位 */
    join(userId: number, nickname: string, ws: WebSocket, gender = 0, avatar = ''): number | null {
        // 房间从空变为有人 → 重新开始计算"等凑人"的时间
        if (this.isEmpty()) this.waitSince = Date.now();
        // 重连：同一 userId 优先坐回原位（牌局进行中也保留座位）
        for (let s = 0; s < SEAT_COUNT; s++) {
            const m = this.members[s];
            if (m && !m.isAI && m.userId === userId) {
                const back = !m.ws;
                m.ws = ws;
                m.nickname = nickname;
                m.gender = gender;
                m.avatar = avatar;
                m.offlineAt = undefined;
                if (back) {
                    this.broadcast({ t: 'memberUpdate', members: this.membersView() });
                    this.broadcast({ t: 'tip', msg: `${m.nickname} 已重新连接` });
                    // 正好轮到他 → 重新给满时间，别让人一回来就只剩 2 秒
                    if (this.timerSeat === s) this.startTimerFor(s, this.currentTimeoutSeconds(s));
                }
                return s;
            }
        }
        const seat = this.members.findIndex((m) => m === null);
        if (seat < 0) return null;

    /** 同一房间内昵称去重（玩家8707 → 玩家8707#2） */
        let nick = nickname;
        const used = new Set(this.members.filter((m): m is Member => !!m).map((m) => m.nickname));
        if (used.has(nick)) {
            let i = 2;
            while (used.has(`${nick}#${i}`)) i++;
            nick = `${nick}#${i}`;
        }

        this.members[seat] = { seat, userId, nickname: nick, gender, avatar, ws };
        return seat;
    }

    leave(seat: number): void {
        const m = this.members[seat];
        if (m) m.ws = null;
    }

    /** 牌局是否进行中（进行中掉线不退房，走托管） */
    private inRound(): boolean {
        return this.engine.roundNo > 0
            && (this.engine.phase === Phase.EXCHANGE || this.engine.phase === Phase.PLAYING);
    }

    /**
     * 掉线 / 退出。
     *
     * 关键改动（手机端）：**牌局进行中不再解散房间**。
     * 切后台、锁屏、地铁进隧道都会断一次，旧逻辑会把另外三个人直接踢出牌局。
     * 现在改为：保留座位 + 标记离线 + 广播提示，由「超时托管」把牌局继续打下去；
     * 局末再清理确实没回来的人，等他重连（同 userId 坐回原位）。
     */
    removeIfIdle(seat: number): boolean {
        const m = this.members[seat];
        if (!m) return false;

        if (this.inRound()) {
            m.ws = null;
            m.offlineAt = Date.now();
            m.droppedThisRound = true;
            this.broadcast({ t: 'memberUpdate', members: this.membersView() });
            this.broadcast({ t: 'tip', msg: `${m.nickname} 掉线了，超时会自动托管，等他回来` });
            // 正好轮到他 → 立即按正常时长重新计时，让他有机会连回来再操作
            if (this.timerSeat === seat) this.startTimerFor(seat, this.currentTimeoutSeconds(seat));
            return true;
        }

        this.members[seat] = null;
        this.readyFlags.delete(seat);
        this.retractNextVote(seat);
        this.clearTimer();
        // 已经打过至少一局还有人退出 → 房间解散，剩余人回匹配（新一波从第 1 局开始）
        if (this.engine.roundNo > 0 && !this.closed) {
            this.dissolve('有玩家退出了游戏，房间解散，请重新匹配');
        } else if (this.engine.roundNo === 0) {
            // 还没打过任何一局：只广播成员变化，凑新人
            this.broadcast({ t: 'memberUpdate', members: this.membersView() });
            this.broadcast({ t: 'readyCount', ready: this.readyFlags.size, need: SEAT_COUNT });
        }
        return true;
    }

    /** 房间是否已空（没有任何占座的成员） */
    isEmpty(): boolean {
        return this.members.every((m) => m === null);
    }

    /**
     * 主动退出（客户端明确发 {t:'leave'}，比如点了「退出游戏」）。
     *
     * 与「掉线」严格区分：
     *   - 主动退出：座位立刻释放，本局作废（打过局就解散房间，其余人回匹配）
     *   - 掉线（ws 断开但没发 leave，比如锁屏/切后台）：见 removeIfIdle，座位保留 + 托管
     */
    forceLeave(seat: number): void {
        const m = this.members[seat];
        if (!m) return;
        this.members[seat] = null;
        this.readyFlags.delete(seat);
        this.retractNextVote(seat);
        this.clearTimer();
        this.broadcast({ t: 'memberUpdate', members: this.membersView() });
        if (this.engine.roundNo > 0 && !this.closed) {
            this.dissolve(`${m.nickname} 退出了游戏，房间解散，请重新匹配`);
        } else if (this.isEmpty()) {
            this.dissolve('玩家都离开了');
        } else {
            this.broadcast({ t: 'readyCount', ready: this.readyFlags.size, need: SEAT_COUNT });
        }
    }

    /** 局结束后调用：把已断线未重连的成员移出房间并广播 */
    private purgeOffline(): void {
        if (this.inRound()) return;
        let changed = false;
        for (let s = 0; s < this.members.length; s++) {
            const m = this.members[s];
            if (m && !m.ws) { this.members[s] = null; this.readyFlags.delete(s); this.retractNextVote(s); changed = true; }
        }
        if (!changed) return;
        // 局末清理：把真没回来的（以及 AI 补位）请出房间，但**不解散**。
        // 剩下的人等着重连或新人补位，比被踢回匹配界面好得多。
        this.broadcast({ t: 'memberUpdate', members: this.membersView() });
        this.broadcast({ t: 'readyCount', ready: this.readyFlags.size, need: SEAT_COUNT });
        if (this.isEmpty()) this.dissolve('玩家都离开了');
    }

    /** 房间销毁前的清理（防止定时器泄漏） */
    dispose(): void {
        this.clearTimer();
    }

    /** 敌人身份对每个座位的可见性：自己永远知道，别人要等他出过牌才看得到 */
    enemySeatView(): number {
        return this.revealed ? this.engine.enemySeat : -1;
    }

    broadcast(msg: object, exceptSeat = -1): void {
        const data = JSON.stringify(msg);
        for (const m of this.members) {
            if (m && m.ws && m.ws.readyState === 1 && m.seat !== exceptSeat) m.ws.send(data);
        }
    }

    private sendTo(seat: number, msg: object): void {
        const m = this.members[seat];
        if (m && m.ws && m.ws.readyState === 1) m.ws.send(JSON.stringify(msg));
    }

    private handView(seat: number): { id: number; name: string; exchanged: boolean }[] {
        return this.engine.players[seat].cards.map((c) => ({ id: c.id, name: c.name, exchanged: !!c.exchanged }));
    }

    /** 各家发到各家自己手里的牌（私密消息） */
    private sendAllHands(): void {
        this.sendAllHandsAndIdentity();
    }

    /** 手牌 + 自己的身份（只有本人知道自己是不是敌人） */
    private sendAllHandsAndIdentity(): void {
        for (const m of this.members) {
            if (!m) continue;
            this.sendTo(m.seat, { t: 'hand', cards: this.handView(m.seat) });
            this.sendTo(m.seat, { t: 'identity', isEnemy: m.seat === this.engine.enemySeat });
        }
    }

    membersView(): object[] {
        return this.members.map((m, s) => m
            ? { seat: m.seat, userId: m.userId, nickname: m.nickname, gender: m.gender, avatar: m.avatar, connected: !!m.ws, ai: !!m.isAI }
            : { seat: s, empty: true });
    }

    /** 各家排名（1=导游 2=中游 3=尾游，0=未出完/敌人），供客户端在头像旁标身份 */
    ranksView(): number[] {
        return this.engine.players.map((p) => (p.finished && !p.isEnemy ? p.rank : 0));
    }

    // ============ 开局 ============

    startRound(): void {
        this.readyFlags.clear();
        this.nextVotes.clear();         // 新一局：清空「再来一局」投票
        this.revealed = false;          // 新一局重新隐藏敌人身份
        this.exchangeLogSent = 0;       // 交牌动画广播进度归零
        this.exchangeJustDone = false;
        this.timeoutSeats.clear();      // 本局托管统计归零
        this.timeouts.clear();
        this.autoPilot.clear();         // 新局重新给每个人 20 秒
        for (const m of this.members) if (m) m.droppedThisRound = false;
        this.clearTimer();
        this.roundStartedAt = Date.now();
        this.engine.startRound();
        // 注意：不广播 enemySeat —— 敌人身份要等他第一次出牌才暴露（防作弊/防剧透）
        this.broadcast({
            t: 'roundStart',
            roundNo: this.engine.roundNo,
            members: this.membersView(),
            handCounts: this.engine.players.map((p) => p.cards.length),
        });
        this.sendAllHands();
        this.pump();
        // 发牌动画收尾同步：正常客户端本地动画 ~4.3 秒内播完；
        // 后台标签页动画会被暂停，到点广播 dealDone 强制全部翻牌，保证四家视觉终点一致
        setTimeout(() => { if (!this.closed) this.broadcast({ t: 'dealDone' }); }, 4800);
    }

    // ============ 就绪与开局 ============

    /**
     * ready 随到随记（坐满前先到的 ready 不作废）。
     * 坐满且 4 家都 ready → 自动开局。返回 true 表示已开局。
     */
    markReady(seat: number): boolean {
        this.readyFlags.add(seat);
        this.broadcast({ t: 'readyCount', ready: this.readyFlags.size, need: SEAT_COUNT });
        if (this.full() && this.readyFlags.size >= SEAT_COUNT) {
            this.startRound();
            return true;
        }
        return false;
    }

    /**
     * AI 补位：把空座位填上机器人，然后直接开局。
     *
     * 冷启动阶段真人很难同时凑满 4 个，玩家点「开始匹配」干等到 1/4 人就会走。
     * 机器人不打单独的 AI 循环——它们借「1 秒超时托管」这条现成路径出牌，
     * 所以视觉上就是"机器人思考 1 秒后出牌"，和真人超时的表现一模一样。
     */
    fillWithAI(reason = '等待超时，已用机器人补位开局'): boolean {
        if (this.full()) return false;
        let added = 0;
        for (let s = 0; s < SEAT_COUNT; s++) {
            if (this.members[s]) continue;
            this.members[s] = {
                seat: s,
                userId: -1000 - s,
                nickname: `机器人${s + 1}号`,
                gender: 0,
                avatar: '',
                ws: null,
                isAI: true,
            };
            this.readyFlags.add(s);
            added++;
        }
        if (!added) return false;

        this.broadcast({ t: 'memberUpdate', members: this.membersView() });
        this.broadcast({ t: 'readyCount', ready: this.readyFlags.size, need: SEAT_COUNT });
        this.broadcast({ t: 'tip', msg: reason });

        const p = this.engine.phase;
        if (this.full() && this.readyFlags.size >= SEAT_COUNT
            && p !== Phase.EXCHANGE && p !== Phase.PLAYING) {
            this.startRound();
        }
        return true;
    }

    /** 真人数量（不含 AI） */
    realCount(): number {
        return this.members.filter((m) => !!m && !m.isAI).length;
    }

    /**
     * 快照同步：客户端进场景/断线重连后主动要当前牌局状态。
     * 发一遍 起局信息 + 手牌 + 公共状态，如果正轮到他行动再补一条 turn。
     */
    resync(seat: number): void {
        const e = this.engine;
        const counts = () => e.players.map((p) => p.cards.length);

        if (e.roundNo === 0 || (e.phase !== Phase.EXCHANGE && e.phase !== Phase.PLAYING)) {
            // 还没开局，或本局已结束：给房间信息 + 结算（如有），客户端显示等待/结算面板
            this.sendTo(seat, { t: 'roomOk', roomId: this.id, seat, members: this.membersView() });
            this.sendTo(seat, { t: 'readyCount', ready: this.readyFlags.size, need: SEAT_COUNT });
            if (e.phase === Phase.ROUND_END || e.phase === Phase.ROUND_WAIT) {
                this.sendTo(seat, { t: 'state', phase: e.phase, lastPlaySeat: e.lastPlaySeat, handCounts: counts() });
                this.sendTo(seat, { t: 'roundEnd', result: e.lastResult });
                // 补发「再来一局」投票进度，重连的人也知道现在几个人点了
                this.sendTo(seat, {
                    t: 'nextVote', count: this.nextVotes.size,
                    need: this.members.filter((m) => !!m).length,
                });
            }
            return;
        }

        this.sendTo(seat, {
            t: 'roundStart', roundNo: e.roundNo, seat,
            members: this.membersView(), handCounts: counts(),
        });
        if (this.revealed) this.sendTo(seat, { t: 'enemyRevealed', seat: e.enemySeat });
        this.sendTo(seat, { t: 'hand', cards: this.handView(seat) });
        this.sendTo(seat, { t: 'identity', isEnemy: seat === e.enemySeat });
        this.sendTo(seat, { t: 'state', phase: e.phase, lastPlaySeat: e.lastPlaySeat, handCounts: counts(), tableCards: e.tableCards.map((c) => c.id) });

        if (e.phase === Phase.EXCHANGE && e.currentExchange) {
            const step = e.currentExchange;
            // 只给这个座位发 turn；「轮到谁」的全场广播由 pump 负责，这里不能重发，
            // 否则同一步会被广播多次，客户端飞牌动画看起来在「重播」
            if (step.from === seat) {
                this.sendTo(seat, {
                    t: 'turn', kind: step.kind, hint: step.hint, count: step.count,
                    rank: step.rank || 0, tableCards: e.tableCards.map((c) => c.id),
                    loserPickOrder: this.loserPickOrderView(),
                });
            }
        } else if (e.phase === Phase.PLAYING && e.currentSeat === seat) {
            this.sendTo(seat, {
                t: 'turn', kind: 'PLAY', mustLead: e.lastPattern === null,
                lastPattern: e.lastPattern ? e.lastPattern.name : null,
                lastCards: e.lastPattern ? e.lastPattern.cards.map((c) => c.id) : [],
                lastSeat: e.lastPlaySeat,
            });
        }

        // 连上来的时候正好轮到他/别人在倒计时 → 补发剩余秒数
        if (this.timerSeat >= 0 && this.deadline > 0) {
            const left = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
            this.sendTo(seat, {
                t: 'timer', seat: this.timerSeat, seconds: left,
                total: this.timerTotal, deadline: this.deadline,
            });
        }
    }

    // ============ 动作处理 ============

    handleAct(seat: number, msg: { kind?: string; cards?: number[] }): void {
        const e = this.engine;
        const kind = msg.kind || 'auto';
        // 玩家自己动了 → 立刻退出托管，恢复 20 秒正常倒计时
        this.clearAutoPilot(seat);

        if (e.phase === Phase.EXCHANGE) {
            const step = e.currentExchange;
            if (!step || step.from !== seat) {
                this.sendTo(seat, { t: 'error', msg: '现在没轮到你交牌' });
                return;
            }
            let ok: boolean;
            if (kind === 'auto') {
                // 联机必须自己点牌+点按钮，禁止任何自动交牌（牌不能自己动）
                this.sendTo(seat, { t: 'error', msg: '请先点选牌，再点击按钮交出去' });
                return;
            } else if (msg.cards && msg.cards.length) {
                ok = e.submitExchange(msg.cards);
            } else {
                this.sendTo(seat, { t: 'error', msg: '缺少 cards' });
                return;
            }
            if (!ok) {
                this.sendTo(seat, { t: 'error', msg: this.exchangeFailMsg(step.kind), keepTurn: true });
                return;
            }
            this.afterEngineChange();
            return;
        }

        if (e.phase === Phase.PLAYING) {
            if (e.currentSeat !== seat) {
                this.sendTo(seat, { t: 'error', msg: '现在没轮到你出牌' });
                return;
            }
            if (kind === 'pass') {
                if (e.lastPattern === null) {
                    this.sendTo(seat, { t: 'error', msg: '你是领出方，必须出牌' });
                    return;
                }
                this.doPass(seat);
                return;
            }
            // play 或 auto
            let cards: Card[];
            if (kind === 'auto') {
                const sug = e.aiAction();
                if (sug.action !== 'play' || !sug.cards || !sug.cards.length) {
                    if (e.lastPattern === null) { this.sendTo(seat, { t: 'error', msg: '领出方不能托管跳过' }); return; }
                    this.doPass(seat);
                    return;
                }
                cards = sug.cards;
            } else {
                if (!msg.cards || !msg.cards.length) { this.sendTo(seat, { t: 'error', msg: '缺少 cards' }); return; }
                const byId = new Map(e.players[seat].cards.map((c) => [c.id, c]));
                cards = msg.cards.map((id) => byId.get(id)).filter((c): c is Card => !!c);
                if (cards.length !== msg.cards.length) { this.sendTo(seat, { t: 'error', msg: '有牌不在你手里' }); return; }
            }
            // 先单独校验牌型/大小，好给客户端说得清楚一点
            const probe = parsePattern(cards);
            if (!probe) {
                this.sendTo(seat, { t: 'error', msg: '这手牌不成牌型（张数或组合不对）', keepTurn: true });
                return;
            }
            if (e.lastPattern && !canBeat(probe, e.lastPattern)) {
                this.sendTo(seat, {
                    t: 'error',
                    msg: `你的「${probe.name}」吃不了上家的「${e.lastPattern.name}」，请重新选牌`,
                    keepTurn: true,
                });
                return;
            }
            if (!this.doPlay(seat, cards)) {
                this.sendTo(seat, { t: 'error', msg: '这手牌不合法或压不过上家，请重新选牌', keepTurn: true });
                return;
            }
            return;
        }

        this.sendTo(seat, { t: 'error', msg: '当前阶段不能操作：' + e.phase });
    }

    // ============ 出牌 / 跳过的唯一出口 ============
    // 玩家点击和「超时托管」都走这里，保证两条路径的广播顺序、动画完全一致。

    /** 出牌。成功返回 true（内部完成 identity 暴露 + played 广播 + 推进） */
    private doPlay(seat: number, cards: Card[]): boolean {
        const e = this.engine;
        if (!e.playCards(seat, cards)) return false;
        // 敌人（方块4 持有者）第一次出牌 → 向全场暴露身份
        if (!this.revealed && seat === e.enemySeat) {
            this.revealed = true;
            this.broadcast({ t: 'enemyRevealed', seat });
        }
        this.broadcast({ t: 'played', seat, cards: cards.map((c) => c.id) });
        this.afterEngineChange();
        return true;
    }

    /** 跳过 */
    private doPass(seat: number): void {
        this.engine.pass(seat);
        this.broadcast({ t: 'played', seat, pass: true });
        this.afterEngineChange();
    }

    /** 交牌失败原因（与单机版提示文案一致） */
    private exchangeFailMsg(kind: string): string {
        switch (kind) {
            case 'TOURIST_PICK':
            case 'LOSER_PICK': return '这张牌已经不在桌上了';
            case 'LOSER_GIVE': return '只能交出最大的那张牌';
            case 'ENEMY_RETURN':
            case 'TOURIST_RETURN': return '这张牌不能交：方块4 和本局已换过的牌都不能再交';
            default: return '这次交牌不合法，请重新选择';
        }
    }

    /**
     * 托管交牌：直接采用引擎给出的「系统建议」，与玩家点牌走同一个 submitExchange。
     *   ENEMY_PUT      → 手上最大的 N 张（用户要求：大牌本来就是固定的那几张）
     *   ENEMY_RETURN   → 手上最小的 N 张（用户要求：回小牌默认给最小的）
     *   TOURIST_PICK   → 桌上最大的一张
     *   LOSER_PICK     → 桌上最大的一张
     *   TOURIST_RETURN → 最小的一张
     *   LOSER_GIVE     → 最大的一张（规则强制）
     */
    private autoExchange(): boolean {
        const e = this.engine;
        const ids = e.pendingGiveCards().map((c) => c.id);
        if (!ids.length) return e.submitExchange(-1);
        return e.submitExchange(ids);
    }

    // ============ 回合计时 ============

    /** 当前该座位应该给多少秒：AI 补位 1 秒，真人交牌 20 秒、出牌 30 秒 */
    private currentTimeoutSeconds(seat: number): number {
        const m = this.members[seat];
        if (m && m.isAI) return AI_THINK;
        if (this.autoPilot.has(seat)) return AI_THINK;      // 已托管：别每步都拖 20 秒
        if (m && !m.ws) return AI_THINK;                    // 掉线的人：直接快速托管
        return this.engine.phase === Phase.EXCHANGE ? EXCHANGE_TIMEOUT : PLAY_TIMEOUT;
    }

    /**
     * 记一次真人超时。连续 AUTO_PILOT_AFTER 次 → 进入托管。
     * 返回 true 表示这一次刚好进入托管（用于提示文案）。
     */
    private registerTimeout(seat: number): boolean {
        const m = this.members[seat];
        if (!m || m.isAI) return false;
        this.timeoutSeats.add(seat);
        const n = (this.timeouts.get(seat) || 0) + 1;
        this.timeouts.set(seat, n);
        if (n >= AUTO_PILOT_AFTER && !this.autoPilot.has(seat)) {
            this.autoPilot.add(seat);
            return true;
        }
        return false;
    }

    /** 玩家自己动了 → 退出托管状态 */
    private clearAutoPilot(seat: number): void {
        if (this.timeouts.delete(seat)) { /* 已清 */ }
        this.autoPilot.delete(seat);
    }

    /**
     * 给某个座位开始倒计时，并向**全场**广播（四家都能看到谁在想事情）。
     * 只新增一条 timer 消息，不改变任何既有的广播顺序和动画。
     */
    private startTimerFor(seat: number, seconds: number): void {
        this.clearTimer(true);
        if (seat < 0) return;
        const total = Math.max(1, Math.round(seconds));
        this.timerSeat = seat;
        this.timerTotal = total;
        this.deadline = Date.now() + total * 1000;
        this.broadcast({ t: 'timer', seat, seconds: total, total, deadline: this.deadline });
        this.timer = setTimeout(() => this.onTimeout(seat), total * 1000);
    }

    /**
     * 超时：替这位玩家做出「本来他该点的那个动作」。
     * 走的是和玩家点击完全相同的入口（submitExchange / doPlay / doPass），
     * 所以飞牌动画、流程条、身份暴露等视觉表现完全一致，只是少了一次点击。
     */
    private onTimeout(seat: number): void {
        this.timer = null;
        this.timerSeat = -1;
        this.deadline = 0;
        if (this.closed) return;

        const e = this.engine;
        const m = this.members[seat];
        const who = m ? m.nickname : `${seat + 1}号位`;
        const isBot = !m || !!m.isAI;
        const justAuto = this.registerTimeout(seat);

        /**
         * 提示只发一次：刚进入托管时说"已进入托管"，
         * 进入托管之后不再每轮刷屏（否则四家屏幕全是提示）。
         */
        const tip = (action: string) => {
            if (isBot) return;
            if (justAuto) {
                this.broadcast({ t: 'tip', msg: `${who} 连续超时，已进入托管（自动${action}）` });
            } else if (!this.autoPilot.has(seat)) {
                this.broadcast({ t: 'tip', msg: `${who} 超时，已自动${action}` });
            }
        };

        try {
            if (e.phase === Phase.EXCHANGE) {
                const step = e.currentExchange;
                if (!step || step.from !== seat) return;   // 已经推进过了
                const ok = this.autoExchange();
                if (!ok) {
                    // 极端兜底：系统建议也不合法时，直接跳过这一步，避免死等
                    console.error(`[房间${this.id}] 托管交牌失败 kind=${step.kind}，跳过该步骤`);
                    e.exchangeSteps.shift();
                    e.currentExchange = null;
                    e.advanceExchange();
                }
                tip('交牌');
                this.afterEngineChange();
                return;
            }

            if (e.phase === Phase.PLAYING) {
                if (e.currentSeat !== seat) return;
                const sug = e.aiAction();

                if (sug.action === 'play' && sug.cards && sug.cards.length && e.playCards(seat, sug.cards)) {
                    // 复用 doPlay 的后半段（身份暴露 + 广播 + 推进）
                    if (!this.revealed && seat === e.enemySeat) {
                        this.revealed = true;
                        this.broadcast({ t: 'enemyRevealed', seat });
                    }
                    this.broadcast({ t: 'played', seat, cards: sug.cards.map((c) => c.id) });
                    tip('出牌');
                    this.afterEngineChange();
                    return;
                }

                if (e.lastPattern === null) {
                    // 领出方不能过 → 出一张最小的单牌，保证牌局能继续
                    const cards = e.players[seat].cards;
                    const one = cards.length ? cards[cards.length - 1] : null;
                    if (one && this.doPlay(seat, [one])) tip('打出最小的一张');
                    return;
                }

                tip('跳过');
                this.doPass(seat);
                return;
            }
        } catch (err) {
            console.error(`[房间${this.id}] 超时托管异常:`, err);
            // 兜底：别让玩家卡在死界面
            this.pump();
        }
    }

    /** 引擎状态变化后的统一出口：发手牌 → 广播公共状态 → 推进下一位行动者 */
    private afterEngineChange(): void {
        this.clearTimer();              // 有人动作了，撤销上一位的倒计时
        // 先广播「刚才这一步做了什么」让客户端进入飞牌状态，再下发新手牌：
        // 这样客户端会把新手牌缓存起来，等牌飞到位再翻，不会「点完按钮牌自己先变了」
        const logHasNew = this.exchangeLogSent < this.engine.exchangeLog.length;
        if (logHasNew) {
            this.exchangeJustDone = this.engine.phase !== Phase.EXCHANGE;
            this.broadcastExchangeProgress();
        }
        this.sendAllHands();
        this.broadcast({
            t: 'state',
            phase: this.engine.phase,
            lastPlaySeat: this.engine.lastPlaySeat,
            handCounts: this.engine.players.map((p) => p.cards.length),
            ranks: this.ranksView(),
            enemySeat: this.enemySeatView(),
            tableCards: this.engine.tableCards.map((c) => c.id),
        });
        if (this.engine.phase === Phase.ROUND_END || this.engine.phase === Phase.ROUND_WAIT) {
            this.clearTimer();
            this.broadcast({ t: 'roundEnd', result: this.engine.lastResult });
            this.saveRoundRecord();   // 落盘：每局一行 JSONL，供试玩数据分析
            this.purgeOffline();   // 局结束：把中途掉线没回来的人请出房间，腾出座位
            return;   // 等客户端发 {t:'next'} 再开下一局
        }
        this.pump();
    }

    /**
     * 本局记录落盘。放在 purgeOffline 之前——否则掉线者的昵称已经被清掉了。
     * 任何异常都吞掉，绝不影响牌局。
     */
    private saveRoundRecord(): void {
        try {
            const e = this.engine;
            const res = e.lastResult;
            if (!res) return;
            const now = Date.now();
            const seats: SeatRecord[] = [];
            const offlineSeats: number[] = [];
            const aiSeats: number[] = [];

            for (let s = 0; s < SEAT_COUNT; s++) {
                const m = this.members[s];
                const p = e.players[s];
                const offline = !!(m && (m.droppedThisRound || !m.ws));
                seats.push({
                    seat: s,
                    userId: m ? m.userId : 0,
                    nickname: m ? m.nickname : '（空位）',
                    offline,
                    ai: !!(m && m.isAI),
                    rank: p && p.finished && !p.isEnemy ? p.rank : 0,
                    left: p ? p.cards.length : 0,
                });
                if (offline) offlineSeats.push(s);
                if (m && m.isAI) aiSeats.push(s);
            }

            appendRound({
                ts: new Date(now).toISOString(),
                at: now,
                roomId: this.id,
                roomCode: this.code,
                roundNo: e.roundNo,
                hasExchange: e.roundNo > 1,
                enemySeat: e.enemySeat,
                enemyWin: !!res.enemyWin,
                finishOrder: e.finishOrder.slice(),
                seats,
                durationSec: this.roundStartedAt ? Math.round((now - this.roundStartedAt) / 1000) : 0,
                offlineSeats,
                aiSeats,
                timeoutSeats: Array.from(this.timeoutSeats),
            });

            // 重置本局统计
            this.timeoutSeats.clear();
            for (const m of this.members) if (m) m.droppedThisRound = false;
        } catch (err) {
            console.error(`[房间${this.id}] 落盘对局记录失败:`, err);
        }
    }

    /** 被抓龟挑小牌的顺序（供客户端显示「你排第几」） */
    private loserPickOrderView(): number[] {
        return this.engine.loserPickOrder.slice();
    }

    // ============ 交牌动画广播 ============

    /** 已经广播过的 exchangeLog 条数（避免重复播同一张牌的飞行动画） */
    private exchangeLogSent = 0;
    /** 上一次广播的「轮到谁交牌」标识，用于去重 */
    private lastExTurnKey = '';
    /** 「再来一局」投票：必须全员点齐才开局 */
    private nextVotes = new Set<number>();
    /** 交牌刚结束的那一次广播要用（结束后 phase 已是 PLAYING，仍要播最后几张牌的动画） */
    private exchangeJustDone = false;

    /**
     * 把本轮新产生的交换记录逐条广播给全场（包括不操作的人）。
     * 客户端收到 {t:'ex', ...} 就开始播「牌从 A 飞到 B/桌上」的动画，
     * 所以四家看到的交牌过程完全一致，而不是只有操作者能看到。
     */
    private broadcastExchangeProgress(): void {
        const log = this.engine.exchangeLog;
        while (this.exchangeLogSent < log.length) {
            const r = log[this.exchangeLogSent++];
            this.broadcast({
                t: 'ex',
                from: r.from,
                to: r.to,
                card: { id: r.card.id, name: r.card.name },
                kind: r.kind,
                index: r.index,
            });
        }
    }

    pump(): void {
        const e = this.engine;
        let guard = 0;
        while (guard++ < 200) {
            if (e.phase === Phase.EXCHANGE) {
                if (!e.currentExchange) {
                    // 联机 4 真人：advanceExchange 会停在第一个真人步骤（返回 false 是正常），
                    // 或交牌全部跑完进入 PLAYING（返回 true）。两种情况都继续走循环。
                    e.advanceExchange();
                    continue;
                }
                const step = e.currentExchange;
                if (step.from < 0) {
                    // 4 真人模式下没有可操作座位（异常数据）：丢掉这一步，别让 advanceExchange 反复停下死循环
                    e.exchangeSteps.shift();
                    e.currentExchange = null;
                    continue;
                }
                const m = this.members[step.from];
                // ---- 全场广播「现在轮到谁交牌」：四家都能看到提示，不是只有操作者 ----
                // 去重：同一步（同人同类型）重复 pump 时不重复广播，否则客户端动画会重播
                const stepKey = `${step.from}:${step.kind}:${e.exchangeSteps.length}`;
                if (stepKey !== this.lastExTurnKey) {
                    this.lastExTurnKey = stepKey;
                    this.broadcast({
                        t: 'exTurn',
                        seat: step.from,
                        kind: step.kind,
                        hint: step.hint,
                        count: step.count,
                        rank: step.rank || 0,
                        tableCards: e.tableCards.map((c) => c.id),
                        loserPickOrder: this.loserPickOrderView(),
                    });
                }
                // 只把操作提示发给本人
                if (m && m.ws && m.ws.readyState === 1) {
                    this.sendTo(step.from, {
                        t: 'turn',
                        kind: step.kind,
                        hint: step.hint,
                        count: step.count,
                        rank: step.rank || 0,
                        tableCards: e.tableCards.map((c) => c.id),
                        loserPickOrder: this.loserPickOrderView(),
                    });
                }
                // 全场倒计时：轮到谁交牌/拿牌，谁开始计时（20 秒）。
                // 同一步重复 pump 不重置计时，避免"每刷新一次就多给 20 秒"。
                if (!(this.timerSeat === step.from && this.timer)) {
                    this.startTimerFor(step.from, this.currentTimeoutSeconds(step.from));
                }
                return;
            }
            if (e.phase === Phase.PLAYING) {
                const m = this.members[e.currentSeat];
                // 只把出牌提示发给本人
                if (m && m.ws && m.ws.readyState === 1) {
                    this.sendTo(e.currentSeat, {
                        t: 'turn',
                        kind: 'PLAY',
                        mustLead: e.lastPattern === null,
                        lastPattern: e.lastPattern ? e.lastPattern.name : null,
                        // 上一手的牌 id：客户端要拿它重建 Pattern 做「提示」判断
                        lastCards: e.lastPattern ? e.lastPattern.cards.map((c) => c.id) : [],
                        lastSeat: e.lastPlaySeat,
                    });
                }
                // 出牌也计时（30 秒），防止一个人发呆全场卡死
                if (!(this.timerSeat === e.currentSeat && this.timer)) {
                    this.startTimerFor(e.currentSeat, this.currentTimeoutSeconds(e.currentSeat));
                }
                return;
            }
            if (e.phase !== Phase.ROUND_END && e.phase !== Phase.ROUND_WAIT) {
                console.error(`[房间${this.id}] pump 停在未处理阶段 phase=${e.phase}`);
            }
            return;
        }
        console.error(`[房间${this.id}] pump 循环 200 次未收敛 phase=${e.phase} step=${e.currentExchange?.kind}`);
    }

    /**
     * 停止倒计时。
     * 之前有过倒计时才广播 seat:-1（让客户端收起计时环），避免每次推进都多发一条空消息。
     * silent = 内部换计时时用，不发中间态。
     */
    private clearTimer(silent = false): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        const had = this.timerSeat >= 0;
        this.timerSeat = -1;
        this.timerTotal = 0;
        this.deadline = 0;
        if (had && !silent) this.broadcast({ t: 'timer', seat: -1 });
    }

    /** 房间是否已解散（有人退出且本局已打完 → 全员回匹配） */
    closed = false;

    /**
     * 解散房间：广播 roomClosed，剩余玩家收到后回到匹配界面；
     * 之后进来的玩家会匹配成新房间的第 1 局。
     */
    private dissolve(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        this.broadcast({ t: 'roomClosed', msg: reason });
        this.clearTimer();
    }

    // ============ 「再来一局」全员确认 ============

    /**
     * 一局结束后，必须**所有人都点「再来一局」**才发牌开下一局。
     * 任何一个人点都不拉别人进场——每家自己决定，点齐了才开局。
     */
    requestNext(seat: number): void {
        const e = this.engine;
        if (e.phase !== Phase.ROUND_END && e.phase !== Phase.ROUND_WAIT) return;
        this.nextVotes.add(seat);
        const need = this.members.filter((m) => !!m).length;
        this.broadcast({ t: 'nextVote', count: this.nextVotes.size, need });
        if (this.nextVotes.size >= need) {
            // 引擎固定 4 个座位，人不满就开局会卡死 → 等人齐（新玩家加入 ready 后会自然开）
            if (!this.full()) {
                this.broadcast({ t: 'tip', msg: `还差 ${SEAT_COUNT - need} 位玩家，人齐后自动开局` });
                return;
            }
            this.nextVotes.clear();
            this.startRound();
        }
    }

    /** 掉线/退房的人从投票里剔除，防止永远凑不齐 */
    private retractNextVote(seat: number): void {
        this.nextVotes.delete(seat);
    }
}
