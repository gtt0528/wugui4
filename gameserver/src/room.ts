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
import type { WebSocket } from 'ws';

export interface Member {
    seat: number;
    userId: number;
    nickname: string;
    gender: number;                 // 0 未知 1 男 2 女
    avatar: string;                 // 头像 URL（微信头像 / 默认头像标识），可为空
    ws: WebSocket | null;          // null = 掉线（可重连）
}

let roomSeq = 1;

export class Room {
    id: string;
    members: (Member | null)[] = [null, null, null, null];
    engine: GameEngine;
    readyFlags = new Set<number>();   // 每个座位都 ready 才能开局，防止重复 startRound
    createdAt = Date.now();
    /** 敌人是否已暴露（持有方块4 的人第一次出牌时才公开） */
    revealed = false;
    /** 当前倒计时所在座位（-1 = 无人计时） */
    timerSeat = -1;
    /** 倒计时截止的绝对时间戳（ms） */
    deadline = 0;
    private timer: NodeJS.Timeout | null = null;

    constructor() {
        this.id = 'R' + String(roomSeq++).padStart(4, '0');
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
        // 重连：同一 userId 优先坐回原位
        for (let s = 0; s < SEAT_COUNT; s++) {
            const m = this.members[s];
            if (m && m.userId === userId) {
                m.ws = ws;
                m.nickname = nickname;
                m.gender = gender;
                m.avatar = avatar;
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
     * 未开局（或本局已结束）时真正退出房间：释放座位、清 ready、广播成员变化。
     * 牌局进行中则只标记离线（leave），由托管推进。返回是否真的移除了。
     */
    removeIfIdle(seat: number): boolean {
        if (this.inRound() && this.members[seat]) {
            // 牌局进行中有人退出/掉线：没有倒计时托管，缺人会卡死牌局 → 直接解散
            this.leave(seat);
            if (this.engine.roundNo > 0 && !this.closed) {
                this.dissolve('有玩家退出了游戏，房间解散，请重新匹配');
            }
            return true;
        }
        if (!this.members[seat]) return false;
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

    /** 局结束后调用：把已断线未重连的成员移出房间并广播 */
    private purgeOffline(): void {
        if (this.inRound()) return;
        let changed = false;
        for (let s = 0; s < this.members.length; s++) {
            const m = this.members[s];
            if (m && !m.ws) { this.members[s] = null; this.readyFlags.delete(s); this.retractNextVote(s); changed = true; }
        }
        if (!changed) return;
        // 打过局的房间缺了人 → 解散回匹配；一局都没打过 → 继续凑人
        if (this.engine.roundNo > 0) {
            this.dissolve('有玩家掉线退出，房间解散，请重新匹配');
        } else {
            this.broadcast({ t: 'memberUpdate', members: this.membersView() });
            this.broadcast({ t: 'readyCount', ready: this.readyFlags.size, need: SEAT_COUNT });
        }
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
            ? { seat: m.seat, userId: m.userId, nickname: m.nickname, gender: m.gender, avatar: m.avatar, connected: !!m.ws }
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
        this.clearTimer();
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
            this.sendTo(seat, { t: 'timer', seat: this.timerSeat, seconds: left, deadline: this.deadline });
        }
    }

    // ============ 动作处理 ============

    handleAct(seat: number, msg: { kind?: string; cards?: number[] }): void {
        const e = this.engine;
        const kind = msg.kind || 'auto';

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
                e.pass(seat);
                this.broadcast({ t: 'played', seat, pass: true });
                this.afterEngineChange();
                return;
            }
            // play 或 auto
            let cards: Card[];
            if (kind === 'auto') {
                const sug = e.aiAction();
                if (sug.action !== 'play' || !sug.cards || !sug.cards.length) {
                    if (e.lastPattern === null) { this.sendTo(seat, { t: 'error', msg: '领出方不能托管跳过' }); return; }
                    e.pass(seat);
                    this.broadcast({ t: 'played', seat, pass: true });
                    this.afterEngineChange();
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
            if (!e.playCards(seat, cards)) {
                this.sendTo(seat, { t: 'error', msg: '这手牌不合法或压不过上家，请重新选牌', keepTurn: true });
                return;
            }
            // 敌人（方块4 持有者）第一次出牌 → 向全场暴露身份
            if (!this.revealed && seat === e.enemySeat) {
                this.revealed = true;
                this.broadcast({ t: 'enemyRevealed', seat });
            }
            this.broadcast({ t: 'played', seat, cards: cards.map((c) => c.id) });
            this.afterEngineChange();
            return;
        }

        this.sendTo(seat, { t: 'error', msg: '当前阶段不能操作：' + e.phase });
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

    /** 托管：按引擎默认策略交牌 */
    private autoExchange(stepKind: string): boolean {
        const e = this.engine;
        if (stepKind === 'ENEMY_PUT' || stepKind === 'ENEMY_RETURN') {
            return e.submitExchange(e.pendingGiveCards().map((c) => c.id));
        }
        if (stepKind === 'TOURIST_PICK' || stepKind === 'LOSER_PICK') {
            // 超时默认挑：不论大牌堆还是小牌堆，都挑「最大」的那张
            // （大牌堆挑最大最划算；小牌堆挑最大也是为了拿回相对有价值的牌）
            return e.submitExchange(this.bestTableCardId());
        }
        return e.submitExchange(-1);
    }

    /** 桌上最大的一张（超时默认选牌用） */
    private bestTableCardId(): number {
        const t = this.engine.tableCards;
        if (!t.length) return -1;
        let best = t[0];
        for (const c of t) {
            if (c.point > best.point || (c.point === best.point && c.suit > best.suit)) best = c;
        }
        return best.id;
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
            this.purgeOffline();   // 局结束：把中途掉线没回来的人请出房间，腾出座位
            return;   // 等客户端发 {t:'next'} 再开下一局
        }
        this.pump();
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
                // 只把操作提示发给本人；不设倒计时——玩家想多久都行，没有自动托管
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
                return;
            }
            if (e.phase === Phase.PLAYING) {
                const m = this.members[e.currentSeat];
                // 只把出牌提示发给本人；不设倒计时——玩家想多久都行，没有自动托管
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
                return;
            }
            if (e.phase !== Phase.ROUND_END && e.phase !== Phase.ROUND_WAIT) {
                console.error(`[房间${this.id}] pump 停在未处理阶段 phase=${e.phase}`);
            }
            return;
        }
        console.error(`[房间${this.id}] pump 循环 200 次未收敛 phase=${e.phase} step=${e.currentExchange?.kind}`);
    }

    private clearTimer(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.timerSeat = -1;
        this.deadline = 0;
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
            this.nextVotes.clear();
            this.startRound();
        }
    }

    /** 掉线/退房的人从投票里剔除，防止永远凑不齐 */
    private retractNextVote(seat: number): void {
        this.nextVotes.delete(seat);
    }
}
