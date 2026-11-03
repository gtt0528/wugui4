/**
 * 乌龟4 —— 牌局流程引擎
 *
 * 一局的完整流程：
 *   1. 定发牌起点（首局投骰子，之后给上一局"导游"；敌人赢则给敌人）
 *   2. 逆时针发牌 54 张（起点与下家各 14 张，其余两人各 13 张）
 *   3. 定身份：持「方块4」者为敌人，其余三人为乌龟（暗身份）
 *   4. 局间交牌（首局无）：输家交最大牌 → 敌人交最大牌给导游 → 导游回一张 → 敌人各回一张
 *   5. 定先出牌者（首局持「梅花4」者；之后为交出最大牌的输家中牌最大者）
 *   6. 逆时针出牌，压不过可跳过；一圈无人压则最后出牌者重新领出
 *   7. 结束判定：敌人出完牌即敌人赢；三只乌龟全部出完即乌龟方赢
 *
 * 本文件为纯逻辑，不依赖 Cocos。
 */

import {
    Card, createDeck, shuffle, sortCards, removeCards,
    CLUB_4_ID, DIAMOND_4_ID, hasCards, exchangeableCards, markExchanged,
} from './Card';
import { Pattern, canPlay } from './Pattern';
import { decidePlay, decideRevealLead } from './AI';

/** 座位号约定：0 = 自己（下方），逆时针 0 → 1(右) → 2(上) → 3(左) → 0 */
export const SEAT_COUNT = 4;

/**
 * 上一局某乌龟的名次（按出完顺序）：1=导游 2=中游 3=尾游，0=没出完（被抓龟）。
 * 被敌人抓走的不算名次。
 */
export function turtleRankOf(result: RoundResult, seat: number): number {
    if (seat === result.enemySeat) return 0;
    const idx = result.finishOrder.indexOf(seat);
    return idx < 0 ? 0 : idx + 1;
}

/** 名次中文名（1=导游 2=中游 3=尾游 0=被抓龟） */
export const RANK_NAME = ['被抓龟', '导游', '中游', '尾游'];

/** 下一家（逆时针） */
export function nextSeat(seat: number): number {
    return (seat + 1) % SEAT_COUNT;
}

export enum Phase {
    IDLE = 'IDLE',
    DEAL = 'DEAL',
    EXCHANGE = 'EXCHANGE',
    PLAYING = 'PLAYING',
    ROUND_END = 'ROUND_END',
    /** 结算已确认，在房间里等待其他玩家（人类点击"继续留在房间"之后） */
    ROUND_WAIT = 'ROUND_WAIT',
    GAME_END = 'GAME_END',
}

export interface PlayerState {
    seat: number;
    cards: Card[];
    isEnemy: boolean;
    /** 已出完牌 */
    finished: boolean;
    /** 名次：1=导游 2=中游 3=尾游（仅乌龟）；0 表示未定 */
    rank: number;
}

/**
 * 交牌步骤。新流程（桌上抢牌模型）：
 *   ENEMY_PUT     敌人从手上点选 N 张大牌，交到桌子正中间（N = 游客人数）
 *   TOURIST_PICK  游客按 导游 → 中游 → 尾游 的顺序，从桌上挑走一张
 *   TOURIST_RETURN 游客从手上挑一张牌还给敌人（自愿选择，只需不是方块4、不是已交换过的）
 *   LOSER_GIVE    被抓龟从手上点选最大的一张交给敌人（直接落敌人手里，不经过桌子）
 *   ENEMY_RETURN  敌人从手上点选 N 张小牌，摆到桌子中间（N = 被抓龟人数）
 *   LOSER_PICK    被抓龟按「谁交给敌人的大牌更大，谁先挑」的顺序，从桌上挑走一张
 */
export type ExchangeKind =
    'ENEMY_PUT' | 'TOURIST_PICK' | 'TOURIST_RETURN' | 'LOSER_GIVE' | 'ENEMY_RETURN' | 'LOSER_PICK';

export interface ExchangeStep {
    kind: ExchangeKind;
    /** 需要操作的座位 */
    from: number;
    /** 接收方座位（TOURIST_PICK 为 -1，因为拿牌者是按顺序轮流，不固定） */
    to: number;
    /** 提示文案 */
    hint: string;
    /** 本步需要交出的张数（ENEMY_PUT / LOSER_GIVE 可能 >1） */
    count: number;
    /** 本步对应的游客名次（1=导游 2=中游 3=尾游） */
    rank?: number;
}

/** 一次已完成的交换，用于 UI 播动画和日志 */
export interface ExchangeRecord {
    from: number;
    to: number;
    card: Card;
    kind: ExchangeKind;
    /** 序号（从 0 开始），UI 按顺序播放 */
    index: number;
}

export interface RoundResult {
    roundNo: number;
    enemySeat: number;
    enemyWin: boolean;
    /** 按出完牌顺序排列的座位 */
    finishOrder: number[];
    /** 各座位名次名 */
    rankNames: { [seat: number]: string };
}

export interface GameConfig {
    /** 真人座位（其余为 AI） */
    humanSeat: number;
    /** 最少局数，未打够视为中途退出 */
    minRounds: number;
    /**
     * 联机模式：4 个座位全是真人，每一步都必须由该座位的玩家点牌+点按钮，
     * 引擎绝不替任何人自动交牌/选牌（单机模式为 false）。
     */
    allHuman: boolean;
}

export class GameEngine {
    phase: Phase = Phase.IDLE;
    roundNo = 0;
    players: PlayerState[] = [];
    enemySeat = -1;
    currentSeat = 0;
    lastPattern: Pattern | null = null;
    lastPlaySeat = -1;
    passCount = 0;
    finishOrder: number[] = [];

    /** 上一局结果 */
    lastResult: RoundResult | null = null;
    /** 历史所有局结果 */
    history: RoundResult[] = [];

    /** 交牌队列 */
    exchangeSteps: ExchangeStep[] = [];
    currentExchange: ExchangeStep | null = null;
    /** 已完成交换记录（UI 用） */
    exchangeLog: ExchangeRecord[] = [];
    /**
     * 桌子正中间摆着的、等人认领的大牌（ENEMY_PUT 交出、游客尚未拿走的那几张）。
     * 只有这里面的牌能被 TOURIST_PICK 拿走。
     */
    tableCards: Card[] = [];
    /** 游客拿牌顺序（导游 > 中游 > 尾游 的座位列表），TOURIST_PICK 按此顺序推进 */
    pickOrder: number[] = [];
    /** 下一个该拿牌的游客序号（指向 pickOrder） */
    pickIndex = 0;
    /**
     * 本局所有「交出大牌」的记录（敌人摆到桌上的 + 被抓龟给敌人的），用于决定先出牌者。
     * 规则：谁交出去的牌最大，谁先出牌。
     */
    bigGives: { seat: number; card: Card }[] = [];
    /** 被抓龟从桌上拿牌的进度（指向 loserPickOrder） */
    loserPickIndex = 0;
    /** 本局每只被抓龟实际交给敌人的那张牌（用于排序和 UI 播报） */
    loserGivenCards: { seat: number; card: Card }[] = [];
    /** 上一局的赢家（第一个出完牌的乌龟），没有则为 -1 */
    lastGuideSeat = -1;
    /** 上一局的输家座位（没出完牌的乌龟） */
    lastLoserSeats: number[] = [];
    /**
     * 被抓龟拿小牌的顺序。
     * 规则：**谁交给敌人的大牌更大，谁先挑**（交了大牌吃亏，优先挑好牌作为补偿）。
     * 在 doLoserGive 里每交一张就更新，保证用的是实际交出的牌而不是预估值。
     */
    loserPickOrder: number[] = [];
    /**
     * 敌人身份是否已暴露。
     * 触发条件（两个都要满足）：
     *   1. 某只乌龟刚打出最后一张牌、成为新游客，且那一手没人压得住；
     *   2. 方块4 仍在敌人手上。
     * 暴露后敌人在领出时必须打出含方块4的牌型（方块4出掉后约束自然解除）。
     * 若方块4 已不在手上，则不触发，正常顺延给下一个玩家出牌。
     */
    enemyRevealed = false;
    /** 本局的「乌龟刚出完牌且无人压住」待判定标记 */
    private justFinishedTurtle = false;

    config: GameConfig;
    private rand: () => number;

    constructor(config?: Partial<GameConfig>, rand: () => number = Math.random) {
        this.config = Object.assign({ humanSeat: 0, minRounds: 2, allHuman: false }, config || {});
        this.rand = rand;
    }

    // ============ 发牌 ============

    /** 投骰子决定首个拿牌者：每人 1-6 点，最大者胜；并列则并列者重投 */
    rollForDealStart(): { seat: number; rolls: number[]; rounds: number[][] } {
        const rounds: number[][] = [];
        let candidates = [0, 1, 2, 3];
        let rolls = [0, 0, 0, 0];

        while (candidates.length > 1) {
            const r = [0, 0, 0, 0];
            for (const s of candidates) r[s] = 1 + Math.floor(this.rand() * 6);
            rounds.push(r.slice());
            rolls = r;
            let max = -1;
            for (const s of candidates) max = Math.max(max, r[s]);
            candidates = candidates.filter((s) => r[s] === max);
        }
        return { seat: candidates[0], rolls, rounds };
    }

    /** 开新的一局 */
    startRound(): void {
        this.roundNo += 1;
        const deck = shuffle(createDeck(), this.rand);
        // 一副新牌：清掉上一局遗留的交牌标记
        for (const c of deck) c.exchanged = false;

        // 1. 定发牌起点
        let dealStartSeat: number;
        if (this.roundNo === 1 || !this.lastResult) {
            dealStartSeat = this.rollForDealStart().seat;
        } else {
            // 优先给上一局的导游（第一个出完的乌龟）；敌人赢了则给敌人
            const guideSeat = this.lastResult.finishOrder.find((s) => s !== this.lastResult!.enemySeat);
            dealStartSeat = this.lastResult.enemyWin
                ? this.lastResult.enemySeat
                : (guideSeat !== undefined ? guideSeat : this.lastResult.enemySeat);
        }

        // 2. 逆时针发牌，起点与下家各 14 张
        this.players = [];
        for (let s = 0; s < SEAT_COUNT; s++) {
            this.players.push({ seat: s, cards: [], isEnemy: false, finished: false, rank: 0 });
        }
        for (let i = 0; i < deck.length; i++) {
            const seat = (dealStartSeat + i) % SEAT_COUNT;
            this.players[seat].cards.push(deck[i]);
        }
        for (const p of this.players) p.cards = sortCards(p.cards);

        // 3. 定身份：方块4 是敌人
        this.enemySeat = this.players.findIndex((p) => p.cards.some((c) => c.id === DIAMOND_4_ID));
        this.players.forEach((p) => { p.isEnemy = p.seat === this.enemySeat; });

        // 重置出牌状态
        this.lastPattern = null;
        this.lastPlaySeat = -1;
        this.passCount = 0;
        this.finishOrder = [];
        this.bigGives = [];
        this.exchangeLog = [];
        this.exchangeSteps = [];
        this.currentExchange = null;
        this.tableCards = [];
        this.pickOrder = [];
        this.pickIndex = 0;
        this.loserPickOrder = [];
        this.loserPickIndex = 0;
        this.loserGivenCards = [];
        this.enemyRevealed = false;
        this.justFinishedTurtle = false;
        this.phase = Phase.DEAL;

        // 4. 局间交牌（首局跳过）
        if (this.roundNo === 1) {
            this.currentSeat = this.players.findIndex((p) => p.cards.some((c) => c.id === CLUB_4_ID));
            this.phase = Phase.PLAYING;
        } else {
            this.buildExchangeSteps();
        }
    }

    // ============ 局间交牌 ============

    private buildExchangeSteps(): void {
        const last = this.lastResult!;
        const enemy = last.enemySeat;
        // 被抓龟：上一局没出完牌的乌龟
        const losers = [0, 1, 2, 3].filter((s) => s !== enemy && !last.finishOrder.includes(s));
        // 游客（出完了的乌龟），按名次排：导游 > 中游 > 尾游
        const tourists = last.finishOrder.filter((s) => s !== enemy);
        const guide = tourists.length > 0 ? tourists[0] : undefined;

        this.lastGuideSeat = guide !== undefined ? guide : -1;
        this.lastLoserSeats = losers.slice();
        this.exchangeLog = [];
        this.tableCards = [];
        this.pickOrder = tourists.slice();
        this.pickIndex = 0;

        /*
         * 交牌流程（桌上抢牌模型）：
         *   链路 A ── 敌人 ↔ 游客
         *     ① 敌人从手上点选 N 张大牌（N = 游客人数）交到桌子正中间
         *     ② 导游先点一张拿走 → 中游再点 → 尾游最后（几张里随便挑）
         *     ③ 每位游客各自从手上挑一张还给敌人（自主选择，不是必须最小）
         *   链路 B ── 敌人 ↔ 被抓龟
         *     ④ 每只被抓龟把手上的最大牌交给敌人（直接落敌人手里）
         *     ⑤ 敌人从手上点选 M 张小牌（M = 被抓龟人数）摆到桌子中间
         *     ⑥ 被抓龟按「谁交出去的大牌更大，谁先挑」的顺序，从桌上挑一张拿走
         * 约束：方块4 与已被交换过的牌不能参与任何一次交牌。
         */
        const steps: ExchangeStep[] = [];
        if (tourists.length > 0) {
            steps.push({
                kind: 'ENEMY_PUT', from: enemy, to: -1,
                hint: `点选最大的 ${tourists.length} 张交到桌子中间`,
                count: tourists.length,
            });
            // 游客按名次依次拿牌（这里先建步骤，具体拿哪张由玩家/AI 决定）
            for (let i = 0; i < tourists.length; i++) {
                const t = tourists[i];
                steps.push({
                    kind: 'TOURIST_PICK', from: t, to: -1,
                    hint: `${RANK_NAME[i + 1]}挑一张桌上的大牌拿走`,
                    count: 1, rank: i + 1,
                });
            }
            for (const w of tourists) {
                steps.push({
                    kind: 'TOURIST_RETURN', from: w, to: enemy,
                    hint: '挑一张自己的牌还给敌人（方块4 除外）', count: 1,
                });
            }
        }
        // ④ 被抓龟交最大牌给敌人
        for (const s of losers) {
            steps.push({
                kind: 'LOSER_GIVE', from: s, to: enemy,
                hint: '点选你手上最大的一张交给敌人', count: 1,
            });
        }
        /*
         * ⑤⑥ 敌人把 M 张小牌摆到桌上，被抓龟按「交出去的大牌大小」排序依次挑。
         * 排序规则：交的牌大的人先挑（交了大牌亏了，补偿他优先选好牌的权力）。
         * 这个顺序在 buildExchangeSteps 时就要定下来，因为 LOSER_GIVE 的牌
         * 此时可能还没确定（真人还没点）。所以先用 AI 的预估：
         * 即"手上最大的那张"，与实际执行时 AI/真人会交的牌一致。
         * 真正的排序在 doLoserGive 里每交一张就更新一次，保证用的是实际交出的牌。
         */
        if (losers.length > 0) {
            /*
             * ⑤⑥ 与交大牌完全对称：
             *   敌人一次性点选 M 张小牌（M = 被抓龟人数）摆到桌子中间，
             *   然后被抓龟按「谁交给敌人的大牌更大谁先挑」的顺序依次挑走。
             *   不能「摆一张挑一张」——那样桌上永远只有 1 张，先挑的人就没得挑了。
             */
            steps.push({
                kind: 'ENEMY_RETURN', from: enemy, to: -1,
                hint: `点选 ${losers.length} 张小牌摆到桌子中间`,
                count: losers.length,
            });
            this.loserPickOrder = losers.slice();   // 交完大牌后会按实际交出的牌重排
            for (let i = 0; i < losers.length; i++) {
                steps.push({
                    kind: 'LOSER_PICK', from: -1, to: -1,
                    hint: '从桌上挑一张小牌拿走', count: 1,
                });
            }
        }
        this.exchangeSteps = steps;
        this.phase = Phase.EXCHANGE;
        this.advanceExchange();
    }

    /**
     * 推进交牌流程。AI 步骤自动执行，真人步骤停下等输入。
     * 返回 true 表示交牌已全部结束。
     */
    advanceExchange(): boolean {
        let guard = 0;
        while (this.exchangeSteps.length > 0) {
            if (guard++ > 200) break; // 死循环保护
            const step = this.exchangeSteps[0];

            // LOSER_PICK 的实际拿牌人由 loserPickOrder 决定（按交出大牌大小排序）
            if (step.kind === 'LOSER_PICK') {
                step.from = this.loserPickOrder[this.loserPickIndex] ?? -1;
            }

            // 单机：只有 humanSeat 等真人，其余座位由 AI 自动执行；
            // 联机（allHuman）：每个座位都是真人，任何一步都必须停下来等人点牌+点按钮
            if (this.config.allHuman || step.from === this.config.humanSeat) {
                this.currentExchange = step;
                return false;
            }

            // ---- AI 执行这一步 ----
            this.exchangeSteps.shift();

            if (step.kind === 'ENEMY_PUT') {
                this.doEnemyPut(step, this.bestPutCards(step.from, step.count));
            } else if (step.kind === 'TOURIST_PICK') {
                // AI 游客：桌上最大的那张
                const pick = this.tableCards.slice().sort((a, b) => b.id - a.id)[0];
                if (pick) this.doTouristPick(step, pick);
            } else if (step.kind === 'TOURIST_RETURN') {
                // AI 还牌：给最小的一张（AI 策略，真人不受此限制）
                const pick = exchangeableCards(this.players[step.from].cards, true)[0];
                if (pick) this.doTransfer(step, pick);
            } else if (step.kind === 'ENEMY_RETURN') {
                // AI 敌人还小牌：一次挑 M 张最小的，一起摆到桌子中间
                const picks = exchangeableCards(this.players[step.from].cards, true)
                    .slice(0, Math.max(1, step.count || 1));
                if (picks.length > 0) this.doEnemyReturnMany(step, picks);
            } else if (step.kind === 'LOSER_GIVE') {
                const big = exchangeableCards(this.players[step.from].cards, false)[0];
                if (big) this.doTransfer(step, big);
            } else if (step.kind === 'LOSER_PICK') {
                // AI 被抓龟：桌上最大的一张
                const pick = this.tableCards.slice().sort((a, b) => b.id - a.id)[0];
                if (pick) this.doLoserPick(step, pick);
            }
        }

        // 交牌结束：谁交出去的大牌最大，谁先出牌
        this.currentExchange = null;
        this.currentSeat = this.firstLeadSeat();
        this.phase = Phase.PLAYING;
        this.checkRevealAfterExchange();
        return true;
    }

    /** 系统推荐的「该交哪几张」：手上最大的 N 张（已排除方块4 与已交换牌） */
    bestPutCards(seat: number, count: number): Card[] {
        return exchangeableCards(this.players[seat].cards, false).slice(0, Math.max(1, count || 1));
    }

    /**
     * 定先出牌者。
     * 规则：本局交牌中所有「交出大牌」的人（敌人摆到桌上的 + 被抓龟给敌人的）里，
     *       交出的那张牌最大的先出牌；牌一样大时按座位靠前者。
     * 退化：没有任何人交大牌（首局 / 极端情况）→ 持梅花4 者先出。
     */
    private firstLeadSeat(): number {
        if (this.bigGives.length > 0) {
            let top = this.bigGives[0];
            for (const g of this.bigGives) {
                if (g.card.id > top.card.id) top = g;
            }
            return top.seat;
        }
        let s = this.players.findIndex((p) => p.cards.some((c) => c.id === CLUB_4_ID));
        if (s < 0) s = 0;
        return s;
    }

    /**
     * 敌人把选好的牌摆到桌子正中间。
     * 校验：必须是手上最大的 N 张（顺序无所谓），方块4/已交换牌禁止。
     */
    private doEnemyPut(step: ExchangeStep, cards: Card[]): boolean {
        if (!cards || cards.length === 0) return false;
        const hand = this.players[step.from].cards;
        // 全部牌得在手上
        if (!cards.every((c) => hand.some((h) => h.id === c.id))) return false;
        if (cards.some((c) => c.id === DIAMOND_4_ID)) return false;
        if (cards.some((c) => c.exchanged)) return false;

        // 必须是最大的 N 张：把要交的和"手上最大的 N 张"逐个比对
        const expect = this.bestPutCards(step.from, cards.length).map((c) => c.id).sort((a, b) => a - b);
        const got = cards.map((c) => c.id).sort((a, b) => a - b);
        if (expect.length !== got.length || expect.some((id, i) => id !== got[i])) return false;

        // 从手牌移到桌上
        for (const c of cards) {
            c.exchanged = true; // 摆上桌就算"已移动过"，不能再被拿去做别的交换
            this.players[step.from].cards = removeCards(this.players[step.from].cards, [c]);
            this.tableCards.push(c);
            this.bigGives.push({ seat: step.from, card: c });
            this.exchangeLog.push({
                from: step.from, to: -1, card: c, kind: 'ENEMY_PUT',
                index: this.exchangeLog.length,
            });
        }
        return true;
    }

    /** 游客从桌上拿走一张牌 */
    private doTouristPick(step: ExchangeStep, card: Card): boolean {
        const idx = this.tableCards.findIndex((c) => c.id === card.id);
        if (idx < 0) return false;
        this.tableCards.splice(idx, 1);
        // 拿走的牌加入游客手牌（保留 exchanged 标记：刚换来的本局不能再交出去）
        this.players[step.from].cards = sortCards(this.players[step.from].cards.concat([card]));
        this.exchangeLog.push({
            from: -1, to: step.from, card, kind: 'TOURIST_PICK',
            index: this.exchangeLog.length,
        });
        this.pickIndex++;
        return true;
    }

    /** 执行一次牌张转移（给敌人/被抓龟的还牌等直接转手） */
    private doTransfer(step: ExchangeStep, card: Card): void {
        markExchanged([card]);
        this.transfer(step.from, step.to, [card]);
        if (step.kind === 'LOSER_GIVE') {
            this.bigGives.push({ seat: step.from, card });
            // 记录被抓龟实际交出的牌，实时重算「谁先挑小牌」的顺序
            this.loserGivenCards.push({ seat: step.from, card });
            this.loserPickOrder = this.loserGivenCards.slice()
                .sort((a, b) => b.card.id - a.card.id)
                .map((x) => x.seat);
        }
        this.exchangeLog.push({
            from: step.from, to: step.to, card, kind: step.kind,
            index: this.exchangeLog.length,
        });
    }

    /** 敌人把一张小牌摆到桌子中间（等被抓龟来挑） */
    private doEnemyReturn(step: ExchangeStep, card: Card): boolean {
        const hand = this.players[step.from].cards;
        if (!hand.some((c) => c.id === card.id)) return false;
        if (card.id === DIAMOND_4_ID) return false;
        if (card.exchanged) return false;
        card.exchanged = true;
        this.players[step.from].cards = removeCards(hand, [card]);
        this.tableCards.push(card);
        this.exchangeLog.push({
            from: step.from, to: -1, card, kind: 'ENEMY_RETURN',
            index: this.exchangeLog.length,
        });
        return true;
    }

    /** 敌人一次摆 N 张小牌到桌上（N = 被抓龟人数），校验全部可交 */
    private doEnemyReturnMany(step: ExchangeStep, cards: Card[]): boolean {
        if (!cards || cards.length === 0) return false;
        if (cards.length !== Math.max(1, step.count || 1)) return false;
        const uid = new Set(cards.map((c) => c.id));
        if (uid.size !== cards.length) return false;            // 不能重复点同一张
        const hand = this.players[step.from].cards;
        if (!cards.every((c) => hand.some((h) => h.id === c.id))) return false;
        if (cards.some((c) => c.id === DIAMOND_4_ID || c.exchanged)) return false;
        for (const c of cards) this.doEnemyReturn(step, c);
        return true;
    }

    /** 被抓龟从桌上拿走一张小牌 */
    private doLoserPick(step: ExchangeStep, card: Card): boolean {
        const idx = this.tableCards.findIndex((c) => c.id === card.id);
        if (idx < 0) return false;
        this.tableCards.splice(idx, 1);
        this.players[step.from].cards = sortCards(this.players[step.from].cards.concat([card]));
        this.exchangeLog.push({
            from: -1, to: step.from, card, kind: 'LOSER_PICK',
            index: this.exchangeLog.length,
        });
        this.loserPickIndex++;
        return true;
    }

    /**
     * 真人提交交牌操作。返回值只表示「本次操作是否被接受」。
     * 各步骤的含义：
     *   ENEMY_PUT       cardIds = 选中的那 N 张（必须正好是最大的 N 张）
     *   TOURIST_PICK    cardIds = [桌上那张牌的 id]
     *   TOURIST_RETURN  cardIds = [要还给敌人的那张]（任意可交的牌，不必最小）
     *   LOSER_GIVE      cardIds = [要交给敌人的最大牌]（必须最大）
     *   ENEMY_RETURN    cardIds = [要还给被抓龟的那张]（任意可交的牌，不必最小）
     */
    submitExchange(cardIds: number | number[]): boolean {
        const step = this.currentExchange;
        if (!step) return false;
        const ids = Array.isArray(cardIds) ? cardIds : [cardIds];

        // ---------- 敌人摆大牌上桌 ----------
        if (step.kind === 'ENEMY_PUT') {
            const cards: Card[] = [];
            for (const id of ids) {
                const c = this.players[step.from].cards.find((x) => x.id === id);
                if (!c) return false;
                cards.push(c);
            }
            if (cards.length !== step.count) return false;
            const ok = this.doEnemyPut(step, cards);
            if (!ok) return false;
            this.exchangeSteps.shift();
            this.currentExchange = null;
            this.advanceExchange();
            return true;
        }

        // ---------- 游客从桌上拿牌 ----------
        if (step.kind === 'TOURIST_PICK') {
            const card = this.tableCards.find((c) => c.id === ids[0]);
            if (!card) return false;
            const ok = this.doTouristPick(step, card);
            if (!ok) return false;
            this.exchangeSteps.shift();
            this.currentExchange = null;
            this.advanceExchange();
            return true;
        }

        // ---------- 抓龟交最大牌 ----------
        if (step.kind === 'LOSER_GIVE') {
            const biggest = exchangeableCards(this.players[step.from].cards, false)[0];
            if (!biggest) return false;
            // 传 -1 视为「用系统挑的最大那张」
            const chosen = ids[0] < 0 ? biggest : this.players[step.from].cards.find((c) => c.id === ids[0]);
            if (!chosen) return false;
            if (chosen.id === DIAMOND_4_ID) return false;
            if (chosen.exchanged) return false;
            if (chosen.id !== biggest.id) return false; // 必须是最大的一张
            this.doTransfer(step, chosen);
            this.exchangeSteps.shift();
            this.currentExchange = null;
            this.advanceExchange();
            return true;
        }

        // ---------- 被抓龟从桌上挑小牌 ----------
        if (step.kind === 'LOSER_PICK') {
            const card = this.tableCards.find((c) => c.id === ids[0]);
            if (!card) return false;
            const ok = this.doLoserPick(step, card);
            if (!ok) return false;
            this.exchangeSteps.shift();
            this.currentExchange = null;
            this.advanceExchange();
            return true;
        }

        // ---------- 敌人还小牌：一次摆 N 张到桌子中间 ----------
        if (step.kind === 'ENEMY_RETURN') {
            const ids2 = ids.filter((id) => id > 0);   // 传了 -1 就整体走"系统建议"
            const cards: Card[] = [];
            if (ids2.length === 0) {
                cards.push(...this.pendingGiveCards());
            } else {
                for (const id of ids2) {
                    const c = this.players[step.from].cards.find((x) => x.id === id);
                    if (!c) return false;
                    cards.push(c);
                }
            }
            const ok = this.doEnemyReturnMany(step, cards);
            if (!ok) return false;
            this.exchangeSteps.shift();
            this.currentExchange = null;
            this.advanceExchange();
            return true;
        }

        // ---------- 游客还牌：任意可交的牌，不要求最小 ----------
        // 传 -1 视为「用系统建议的那张」（AI 风格：给最小的一张）
        let retCard: Card | undefined;
        if (ids[0] < 0) {
            retCard = exchangeableCards(this.players[step.from].cards, true)[0];
        } else {
            retCard = this.players[step.from].cards.find((c) => c.id === ids[0]);
        }
        if (!retCard) return false;
        if (retCard.id === DIAMOND_4_ID) return false;   // 身份牌永远不能交
        if (retCard.exchanged) return false;             // 本局已移动过的牌不能再交
        this.doTransfer(step, retCard);
        this.exchangeSteps.shift();
        this.currentExchange = null;
        this.advanceExchange();
        return true;
    }

    /** 交牌流程是否已全部结束 */
    isExchangeFinished(): boolean {
        return this.currentExchange === null && this.exchangeSteps.length === 0;
    }

    /** 系统建议「该交哪几张」/「该拿哪张」 */
    pendingGiveCards(): Card[] {
        const step = this.currentExchange;
        if (!step) return [];
        if (step.kind === 'ENEMY_PUT' || step.kind === 'LOSER_GIVE') {
            return this.bestPutCards(step.from, Math.max(1, step.count || 1));
        }
        if (step.kind === 'TOURIST_PICK' || step.kind === 'LOSER_PICK') {
            // 桌上最大的一张（被抓龟挑补偿，挑最大的最划算）
            const top = this.tableCards.slice().sort((a, b) => b.id - a.id)[0];
            return top ? [top] : [];
        }
        if (step.kind === 'ENEMY_RETURN') {
            // 敌人摆给被抓龟的小牌：给最小的 N 张（不必最小，这是 AI 的偏好）
            return exchangeableCards(this.players[step.from].cards, true)
                .slice(0, Math.max(1, step.count || 1));
        }
        if (step.kind === 'TOURIST_RETURN') {
            const small = exchangeableCards(this.players[step.from].cards, true)[0];
            return small ? [small] : [];
        }
        return [];
    }

    /** 兼容旧调用：返回系统建议的第一张 */
    pendingGiveCard(): Card | null {
        const list = this.pendingGiveCards();
        return list.length > 0 ? list[0] : null;
    }

    /** 某座位手上「可交的牌」（排除方块4 与本局已移动过的牌），按从小到大排序 */
    playerFreeCards(seat: number): Card[] {
        return exchangeableCards(this.players[seat].cards, true);
    }

    /**
     * 本步骤玩家可以点选的牌（用于 UI 高亮/校验）：
     *   ENEMY_PUT       所有可交的牌（玩家自己挑，但最终必须凑成最大的 N 张）
     *   TOURIST_PICK / LOSER_PICK   桌上那几张
     *   LOSER_GIVE     只有最大的那张
     *   TOURIST_RETURN / ENEMY_RETURN  所有可交的牌（自选，不强制最小）
     */
    selectableCards(seat: number): Card[] {
        const step = this.currentExchange;
        if (!step || step.from !== seat) return [];
        if (step.kind === 'TOURIST_PICK' || step.kind === 'LOSER_PICK') return this.tableCards.slice();
        if (step.kind === 'LOSER_GIVE') {
            const biggest = exchangeableCards(this.players[seat].cards, false)[0];
            return biggest ? [biggest] : [];
        }
        return this.players[seat].cards.filter((c) => c.id !== DIAMOND_4_ID && !c.exchanged);
    }

    private transfer(from: number, to: number, cards: Card[]): void {
        this.players[from].cards = removeCards(this.players[from].cards, cards);
        this.players[to].cards = sortCards(this.players[to].cards.concat(cards));
    }

    // ============ 出牌 ============

    /** 当前出牌者是否必须领出（无人可压） */
    isFreePlay(): boolean {
        return this.lastPattern === null;
    }

    /** 出牌。成功返回 true */
    playCards(seat: number, cards: Card[]): boolean {
        if (this.phase !== Phase.PLAYING) return false;
        if (seat !== this.currentSeat) return false;
        const p = this.players[seat];
        if (!hasCards(p.cards, cards)) return false;

        const pattern = canPlay(cards, this.lastPattern);
        if (!pattern) return false;

        // 敌人暴露且手上还有方块4时领出：必须打出含方块4的牌型（方块4出掉后约束解除）
        if (this.enemyRevealed && seat === this.enemySeat && this.lastPattern === null
            && p.cards.some((c) => c.id === DIAMOND_4_ID)
            && !cards.some((c) => c.id === DIAMOND_4_ID)) {
            return false;
        }

        p.cards = removeCards(p.cards, cards);
        this.lastPattern = pattern;
        this.lastPlaySeat = seat;
        this.passCount = 0;

        // 只有"乌龟刚出完最后一张牌"这种情况才可能触发敌人暴露
        this.justFinishedTurtle = false;
        if (p.cards.length === 0) {
            const wasTurtle = !p.isEnemy;
            p.finished = true;
            this.finishOrder.push(seat);
            this.assignRank(seat);
            if (wasTurtle) this.justFinishedTurtle = true;
        }

        if (this.checkRoundEnd()) return true;

        this.moveToNext();
        return true;
    }

    /** 跳过（要不起） */
    pass(seat: number): boolean {
        if (this.phase !== Phase.PLAYING) return false;
        if (seat !== this.currentSeat) return false;
        if (this.lastPattern === null) return false; // 领出时不能跳过

        this.passCount += 1;

        // 需要表态的人数 = 未出完者中除"最后出牌者"以外的人
        const alive = this.players.filter((x) => !x.finished);
        const leaderFinished = this.players[this.lastPlaySeat]?.finished ?? true;
        const needPass = alive.filter((x) => x.seat !== this.lastPlaySeat).length;

        if (this.passCount >= needPass) {
            // 一圈无人压过
            this.lastPattern = null;
            this.passCount = 0;

            /*
             * 特殊时机：某只乌龟刚打出最后一张牌、且这一圈没人压得住 →
             *   若敌人手上还有方块4，则直接轮到敌人领出（身份随之公开，领出必须带方块4）；
             *   若方块4 已经不在了，就按普通规则顺延给下一个未出完的玩家。
             */
            const finishedThisTrick = this.justFinishedTurtle;
            this.justFinishedTurtle = false;

            if (finishedThisTrick
                && this.players[this.enemySeat].cards.some((c) => c.id === DIAMOND_4_ID)) {
                this.currentSeat = this.enemySeat;
                this.checkReveal();
                return true;
            }

            // 普通流程：由最后出牌者重新领出；若其已出完则顺延到下一个未出完者
            let s = leaderFinished ? nextSeat(this.lastPlaySeat) : this.lastPlaySeat;
            let guard = 0;
            while (this.players[s].finished && guard++ < SEAT_COUNT) s = nextSeat(s);
            this.currentSeat = s;
        } else {
            this.moveToNext();
        }
        return true;
    }

    /**
     * 敌人暴露检测（严格按规则）：
     *   触发条件必须同时满足：
     *     1. 某只乌龟刚刚打出最后一张牌、成为新游客，且那一手**没人压得住**（一圈通过没人出）；
     *     2. 方块4 仍在敌人手上。
     *   此时轮到敌人领出 → 敌人身份公开，领出必须打出含方块4的牌型。
     *   若方块4 已不在手上 → 不触发，正常顺延给下一个未出完的玩家出牌。
     */
    private checkReveal(): void {
        if (this.enemyRevealed) return;
        if (!this.justFinishedTurtle) return;                 // 条件1的前半：必须是乌龟刚出完牌
        const d4OnHand = this.players[this.enemySeat].cards.some((c) => c.id === DIAMOND_4_ID);
        if (!d4OnHand) return;                                // 条件2：方块4 必须还在敌人手上
        this.enemyRevealed = true;
        this.justFinishedTurtle = false;
    }

    /** 交牌结束时也要判定一次（此时可能已经满足暴露条件） */
    private checkRevealAfterExchange(): void {
        // 交牌阶段不会有"乌龟刚出完牌"，这里只做一次稳妥的清理
        this.justFinishedTurtle = false;
    }

    private moveToNext(): void {
        let s = nextSeat(this.currentSeat);
        let guard = 0;
        while (this.players[s].finished && guard++ < SEAT_COUNT) s = nextSeat(s);
        this.currentSeat = s;
    }

    private assignRank(seat: number): void {
        const p = this.players[seat];
        if (p.isEnemy) return; // 敌人不参与乌龟名次
        const turtleFinished = this.finishOrder.filter((s) => !this.players[s].isEnemy).length;
        p.rank = turtleFinished; // 1=导游 2=中游 3=尾游
    }

    /**
     * 本局是否结束。胜负规则：
     *   - 敌人出完牌时，若仍有乌龟没出完 → 敌人赢，那些没出完的乌龟「被抓走」，立即结束；
     *   - 3 只乌龟全部在敌人之前出完 → 乌龟方赢；
     *   - 乌龟的名次（导游/中游/尾游）只给「赶在敌人出完之前出完」的乌龟，
     *     被抓走的乌龟不算名次、只算输。
     */
    private checkRoundEnd(): boolean {
        const enemy = this.players[this.enemySeat];
        const turtles = this.players.filter((p) => !p.isEnemy);
        const turtleAllDone = turtles.every((p) => p.finished);

        // 敌人出完：还有乌龟没出完 → 敌人赢；全出完了 → 乌龟方赢
        if (enemy.finished) {
            this.finishRound(!turtleAllDone);
            return true;
        }
        // 3 只乌龟全部出完（敌人还没出完）→ 乌龟方赢
        if (turtleAllDone) {
            this.finishRound(false);
            return true;
        }
        return false;
    }

    private finishRound(enemyWin: boolean): void {
        const rankNames: { [seat: number]: string } = {};
        const RANK_TEXT = ['', '导游', '中游', '尾游'];
        for (const p of this.players) {
            if (p.isEnemy) {
                rankNames[p.seat] = enemyWin ? '敌人（赢）' : '敌人（输）';
            } else if (p.finished) {
                rankNames[p.seat] = RANK_TEXT[p.rank] || '乌龟';
            } else {
                // 敌人出完时还没出完的乌龟 = 被抓走，不算名次
                rankNames[p.seat] = '被抓走';
            }
        }

        const result: RoundResult = {
            roundNo: this.roundNo,
            enemySeat: this.enemySeat,
            enemyWin,
            finishOrder: this.finishOrder.slice(),
            rankNames,
        };
        this.lastResult = result;
        this.history.push(result);
        this.phase = Phase.ROUND_END;
    }

    /**
     * 某个座位本局是否算"赢"（用于积分）。
     * - 乌龟赢：至少在自己被抓之前出完了牌（即 finishOrder 里有它）
     * - 敌人赢：敌人是第一个出完的
     */
    isWinner(seat: number): boolean {
        const r = this.lastResult;
        if (!r) return false;
        if (seat === r.enemySeat) return r.enemyWin;
        return r.finishOrder.includes(seat);
    }

    /** 是否已打够最少局数 */
    canEndGame(): boolean {
        return this.roundNo >= this.config.minRounds;
    }

    // ============ AI 驱动 ============

    /** 让当前座位（AI）自动行动 */
    aiAction(): { action: 'play' | 'pass'; cards?: Card[] } {
        if (this.phase !== Phase.PLAYING) return { action: 'pass' };
        const seat = this.currentSeat;
        const p = this.players[seat];
        // 敌人暴露且需领出：必须出含方块4的牌型
        if (this.enemyRevealed && seat === this.enemySeat && this.lastPattern === null) {
            const cards = decideRevealLead(p.cards);
            if (cards) return { action: 'play', cards };
        }
        const decision = decidePlay(p.cards, this.lastPattern);
        if (!decision) return { action: 'pass', cards: [] };
        return { action: 'play', cards: decision };
    }

    /** AI 交牌选择（给最弱的一张；不能挑刚换来的牌） */
    aiExchangeChoice(seat: number): Card {
        return exchangeableCards(this.players[seat].cards, true)[0];
    }
}
