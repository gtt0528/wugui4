/**
 * 乌龟4 —— 牌与牌力体系
 *
 * 牌力序列（小 → 大）：
 *   4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A < 2 < 3 < 小王 < 大王
 * 同点数时按花色：方块 < 梅花 < 红桃 < 黑桃
 * 花色颜色：方块/红桃 为红，梅花/黑桃 为黑，王无颜色
 *
 * 本文件为纯逻辑，不依赖 Cocos，可直接在 Node / 服务端复用。
 */

/** 花色 */
export enum Suit {
    Diamond = 0, // 方块
    Club = 1,    // 梅花
    Heart = 2,   // 红桃
    Spade = 3,   // 黑桃
    Joker = -1,  // 王
}

/** 颜色：红 = 方块/红桃，黑 = 梅花/黑桃 */
export enum Color {
    Red = 0,
    Black = 1,
    None = -1,
}

export interface Card {
    /** 1-54，与《扑克牌54张清单.xlsx》第一列序号一致，即全局大小序 */
    id: number;
    /** 点数等级 0-14，用于比较大小（4→0 ... 3→12, 小王→13, 大王→14） */
    point: number;
    /** 花色 Suit */
    suit: number;
    /** 颜色 Color */
    color: number;
    /** 完整牌名，如 "方块4" */
    name: string;
    /** 点数显示名，如 "4" "J" "小王" */
    label: string;
    /** 花色符号，用于 UI 绘制 */
    suitSymbol: string;
    isJoker: boolean;
    /**
     * 局间交牌的「不可立即再交」标记。
     * 一张牌被交换后本局会被打上此标记，直到本局结束（下一局重新发牌时自然清除）。
     * undefined | true 视为已被交过、不能马上再作为交牌对象。
     */
    exchanged?: boolean;
}

/** 点数显示顺序（由小到大） */
const POINT_LABELS: string[] = [
    '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '3',
];

/** 普通牌的花色定义，顺序即同点数内的大小顺序 */
const SUIT_DEFS = [
    { suit: Suit.Diamond, name: '方块', symbol: '♦', color: Color.Red },
    { suit: Suit.Club, name: '梅花', symbol: '♣', color: Color.Black },
    { suit: Suit.Heart, name: '红桃', symbol: '♥', color: Color.Red },
    { suit: Suit.Spade, name: '黑桃', symbol: '♠', color: Color.Black },
];

/** 大小王的点数等级 */
export const POINT_SMALL_JOKER = 13;
export const POINT_BIG_JOKER = 14;

/** 生成一副 54 张牌，id 即序号（1 最小，54 大王最大） */
export function createDeck(): Card[] {
    const deck: Card[] = [];
    let id = 1;

    for (let p = 0; p < POINT_LABELS.length; p++) {
        for (const def of SUIT_DEFS) {
            deck.push({
                id: id++,
                point: p,
                suit: def.suit,
                color: def.color,
                name: def.name + POINT_LABELS[p],
                label: POINT_LABELS[p],
                suitSymbol: def.symbol,
                isJoker: false,
            });
        }
    }

    deck.push({
        id: id++,
        point: POINT_SMALL_JOKER,
        suit: Suit.Joker,
        color: Color.None,
        name: '小王',
        label: '小王',
        suitSymbol: '',
        isJoker: true,
    });
    deck.push({
        id: id++,
        point: POINT_BIG_JOKER,
        suit: Suit.Joker,
        color: Color.None,
        name: '大王',
        label: '大王',
        suitSymbol: '',
        isJoker: true,
    });

    return deck;
}

/** 洗牌（Fisher-Yates），可传入自定义随机源便于测试复现 */
export function shuffle(cards: Card[], rand: () => number = Math.random): Card[] {
    const arr = cards.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
    }
    return arr;
}

/** 比较单张牌大小：a > b 返回正数，a < b 返回负数，相等返回 0 */
export function compareCard(a: Card, b: Card): number {
    if (a.point !== b.point) return a.point - b.point;
    return a.suit - b.suit;
}

/** 按牌力从小到大排序（会返回新数组） */
export function sortCards(cards: Card[]): Card[] {
    return cards.slice().sort((a, b) => a.id - b.id);
}

/** 按牌力从大到小排序 */
export function sortCardsDesc(cards: Card[]): Card[] {
    return cards.slice().sort((a, b) => b.id - a.id);
}

/** 从牌堆中移除指定的牌（按 id 匹配），返回剩余牌 */
export function removeCards(hand: Card[], cards: Card[]): Card[] {
    const ids = new Set(cards.map((c) => c.id));
    return hand.filter((c) => !ids.has(c.id));
}

/** 手牌是否包含指定的牌 */
export function hasCards(hand: Card[], cards: Card[]): boolean {
    const ids = new Set(hand.map((c) => c.id));
    return cards.every((c) => ids.has(c.id));
}

/** 按 id 取牌 */
export function cardById(deck: Card[], id: number): Card | undefined {
    return deck.find((c) => c.id === id);
}

/** 梅花4 的 id（第一局先出牌者） */
export const CLUB_4_ID = 2;
/** 方块4 的 id（敌人） */
export const DIAMOND_4_ID = 1;

/**
 * 这张牌能不能被拿去交换。两类牌禁止：
 *   1. 方块4 —— 敌人身份的标识，交出去就没人知道谁是敌人了；
 *   2. 本局已经被交换过的牌（exchanged 标记）—— 刚换来的牌不能马上再换出去。
 */
export function isExchangeable(card: Card): boolean {
    if (card.id === DIAMOND_4_ID) return false;
    return !card.exchanged;
}

/**
 * 取一手可交的牌，按牌力排序（默认从小到大）。
 * 若整手牌都不可交（极端情况），退化为整手牌，保证流程不会卡死。
 */
export function exchangeableCards(hand: Card[], ascending = true): Card[] {
    const free = hand.filter(isExchangeable);
    const list = free.length > 0 ? free : hand.slice();
    return ascending ? sortCards(list) : sortCardsDesc(list);
}

/** 给一批牌打上「本局已交换」标记（就地修改） */
export function markExchanged(cards: Card[]): void {
    for (const c of cards) c.exchanged = true;
}
