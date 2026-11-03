/**
 * 乌龟4 —— 牌型识别与大小比较
 *
 * 牌型（按张数分组）：
 *   单张   1 张   任意一张
 *   对子   2 张   两张相同点数
 *   三张   3 张   三张相同点数
 *   鸡     4 张   四张相同点数
 *   三带二 5 张   三张相同点数 + 一对
 *   顺子   5 张   五张点数连续，不含 2、3、王
 *   同一花色 5 张  五张**同一花色**的单张（例如全是方块），不含王
 *   一条龙 5 张   既是顺子又是同一花色
 *   4带1   5 张   四张相同点数 + 任意一张
 *
 * 比较原则：
 *   单张/对子/三张/鸡：牌型相同且张数相同时才可比，取"关键牌"的点数与花色比较。
 *   5 张牌型**互相可吃**，统一大小序：一条龙 > 4带1 > 三带二 > 顺子 > 同一花色；
 *   同型时比关键牌，其中同一花色/一条龙先比花色（方块<梅花<红桃<黑桃）、再比最大点数。
 * 带牌牌型（三带二、4带1）只比主牌，附牌不参与。
 * 大王、小王可以单张出；两张王放在一起也算一对（能压任何对子）。
 */

import { Card, compareCard, Suit } from './Card';

export enum PatternType {
    INVALID = 0,
    SINGLE = 1,      // 单张
    PAIR = 2,        // 对子
    TRIO = 3,        // 三张
    CHICKEN = 4,     // 鸡（四张）
    TRIO_PAIR = 5,   // 三带二
    STRAIGHT = 6,    // 顺子
    SAME_SUIT = 7,   // 同一花色
    DRAGON = 8,      // 一条龙
    FOUR_ONE = 9,    // 4带1
}

export interface Pattern {
    type: PatternType;
    cards: Card[];
    /** 关键牌点数（主牌点数） */
    point: number;
    /** 关键牌花色（主牌中最大的花色） */
    suit: number;
    /** 展示名 */
    name: string;
}

const TYPE_NAMES: { [k: number]: string } = {
    [PatternType.SINGLE]: '单张',
    [PatternType.PAIR]: '对子',
    [PatternType.TRIO]: '三张',
    [PatternType.CHICKEN]: '鸡',
    [PatternType.TRIO_PAIR]: '三带二',
    [PatternType.STRAIGHT]: '顺子',
    [PatternType.SAME_SUIT]: '同一花色',
    [PatternType.DRAGON]: '一条龙',
    [PatternType.FOUR_ONE]: '4带1',
};

/** 顺子可用的最小/最大点数等级：4(0) ~ A(10)，不含 2(11)、3(12)、王 */
const STRAIGHT_MIN_POINT = 0;
const STRAIGHT_MAX_POINT = 10;

/** 统计各点数的张数 */
function countByPoint(cards: Card[]): Map<number, Card[]> {
    const m = new Map<number, Card[]>();
    for (const c of cards) {
        if (!m.has(c.point)) m.set(c.point, []);
        m.get(c.point)!.push(c);
    }
    return m;
}

function allSamePoint(cards: Card[]): boolean {
    return cards.every((c) => c.point === cards[0].point);
}

/** 点数是否连续（要求点数互不相同，且不含 2/3/王） */
function isConsecutive(cards: Card[]): boolean {
    if (cards.length === 0) return false;
    const sorted = cards.slice().sort((a, b) => a.point - b.point);
    for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].point < STRAIGHT_MIN_POINT || sorted[i].point > STRAIGHT_MAX_POINT) return false;
        if (i > 0 && sorted[i].point === sorted[i - 1].point) return false;
        if (i > 0 && sorted[i].point !== sorted[i - 1].point + 1) return false;
    }
    return true;
}

/**
 * 是否全为**同一花色**（不含王，且点数互不相同）。
 * 注意：这里按花色（方块/梅花/红桃/黑桃）判断，不是按红黑颜色。
 *   ✔ 方块5 方块6 方块7 方块8 方块9
 *   ✘ 方块5 红桃6 方块7 红桃8 方块9（红黑混着、花色不统一，不合法）
 */
export function isSameSuit(cards: Card[]): boolean {
    if (cards.length === 0) return false;
    const suit = cards[0].suit;
    if (suit === Suit.Joker) return false;
    if (!cards.every((c) => c.suit === suit)) return false;
    // 点数互不相同，避免与三带二/4带1 等组合型混淆
    const pts = new Set(cards.map((c) => c.point));
    return pts.size === cards.length;
}

/** 组内最大的牌（按 point 再按 suit） */
function maxCard(cards: Card[]): Card {
    return cards.reduce((a, b) => (compareCard(a, b) >= 0 ? a : b));
}

/** 识别一手牌的牌型，非法返回 null */
export function parsePattern(cards: Card[]): Pattern | null {
    if (!cards || cards.length === 0) return null;
    const n = cards.length;
    const byPoint = countByPoint(cards);
    const groups = Array.from(byPoint.values()).sort((a, b) => b.length - a.length || a[0].point - b[0].point);

    const mk = (type: PatternType, keyCards: Card[]): Pattern => {
        const k = maxCard(keyCards);
        return { type, cards: cards.slice(), point: k.point, suit: k.suit, name: TYPE_NAMES[type] };
    };

    switch (n) {
        case 1:
            return mk(PatternType.SINGLE, cards);

        case 2:
            if (allSamePoint(cards) && !cards[0].isJoker) return mk(PatternType.PAIR, cards);
            // 大王 + 小王 =「王对」：也算一对；大王点数 14 天然压过任何对子
            if (cards[0].isJoker && cards[1].isJoker) return mk(PatternType.PAIR, cards);
            return null;

        case 3:
            if (allSamePoint(cards) && !cards[0].isJoker) return mk(PatternType.TRIO, cards);
            return null;

        case 4:
            if (allSamePoint(cards) && !cards[0].isJoker) return mk(PatternType.CHICKEN, cards);
            return null;

        case 5: {
            // 4带1：四张相同点数 + 任意一张
            if (groups.length === 2 && groups[0].length === 4 && !groups[0][0].isJoker) {
                return mk(PatternType.FOUR_ONE, groups[0]);
            }
            // 三带二：三张相同点数 + 一对
            if (groups.length === 2 && groups[0].length === 3 && groups[1].length === 2
                && !groups[0][0].isJoker && !groups[1][0].isJoker) {
                return mk(PatternType.TRIO_PAIR, groups[0]);
            }
            // 一条龙：既连续又同色
            if (isConsecutive(cards) && isSameSuit(cards)) return mk(PatternType.DRAGON, cards);
            // 顺子：连续
            if (isConsecutive(cards)) return mk(PatternType.STRAIGHT, cards);
            // 同一花色：5 张花色完全一致（不是红黑同色）
            if (isSameSuit(cards)) return mk(PatternType.SAME_SUIT, cards);
            return null;
        }

        default:
            return null;
    }
}

/** 两手牌能否比较大小：张数相同（5 张牌型之间可以互相压，见 fiveTypeRank） */
export function isSameKind(a: Pattern, b: Pattern): boolean {
    if (a.cards.length !== b.cards.length) return false;
    // 5 张牌型互相可吃：一条龙 > 4带1 > 三带二 > 顺子 > 同一花色
    if (a.cards.length === 5 && fiveTypeRank(a.type) > 0 && fiveTypeRank(b.type) > 0) return true;
    return a.type === b.type;
}

/**
 * 5 张牌型的统一大小序（等级越高越大）：
 *   一条龙(5) > 4带1(4) > 三带二(3) > 顺子(2) > 同一花色(1)
 * 其余牌型（单张/对子/三张/鸡）不在表内，仍只能同型互压。
 */
export function fiveTypeRank(type: PatternType): number {
    switch (type) {
        case PatternType.DRAGON: return 5;
        case PatternType.FOUR_ONE: return 4;
        case PatternType.TRIO_PAIR: return 3;
        case PatternType.STRAIGHT: return 2;
        case PatternType.SAME_SUIT: return 1;
        default: return 0;
    }
}

/** a 是否能压过 b（同张数；5 张牌型按统一大小序，同型比关键牌） */
export function canBeat(a: Pattern, b: Pattern): boolean {
    if (!isSameKind(a, b)) return false;

    const ra = fiveTypeRank(a.type);
    const rb = fiveTypeRank(b.type);
    // 5 张牌型跨型比较：等级高者胜
    if (ra > 0 && rb > 0 && ra !== rb) return ra > rb;

    /*
     * 同型比较：
     * 同一花色 / 一条龙：**先比花色，再比点数**。
     *   方块5张 < 梅花5张 < 红桃5张 < 黑桃5张
     *   花色相同时，比这 5 张里最大的那张点数（parsePattern 算出的 point 就是最大牌的点数）
     * 例：方块 9 8 7 6 5 打不过 梅花 4 5 6 7 8 —— 因为梅花整体比方块大。
     */
    if (a.type === PatternType.SAME_SUIT || a.type === PatternType.DRAGON) {
        if (a.suit !== b.suit) return a.suit > b.suit;
        return a.point > b.point;
    }

    // 其余牌型：先比点数，点数相同再比花色
    if (a.point !== b.point) return a.point > b.point;
    return a.suit > b.suit;
}

/** 能否出这一手牌：首出只需合法，跟牌必须同型且更大 */
export function canPlay(cards: Card[], last: Pattern | null): Pattern | null {
    const p = parsePattern(cards);
    if (!p) return null;
    if (!last) return p;
    return canBeat(p, last) ? p : null;
}

/** 牌型描述文本，用于 UI 提示 */
export function patternText(p: Pattern): string {
    return p.name;
}
