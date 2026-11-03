/**
 * 乌龟4 —— AI 出牌决策
 *
 * 策略要点：
 *   领出：手牌较多时优先走组合牌型（顺子/同一花色/三带二/4带1）以消耗手牌，否则出最小单张
 *   跟牌：出"最小的能压过"的同型牌；5 张牌型同型压不过时，可用更高级的 5 张牌型压；压不过则跳过
 *   交牌：交出最弱的一张
 * AI 不区分自己是否为敌人（与真人信息对称，保证公平）
 */

import { Card, sortCards, sortCardsDesc, DIAMOND_4_ID, POINT_SMALL_JOKER, POINT_BIG_JOKER } from './Card';
import { Pattern, PatternType, parsePattern, canBeat, fiveTypeRank } from './Pattern';

/** 顺子可用点数范围：4(0) ~ A(10) */
const STRAIGHT_MIN = 0;
const STRAIGHT_MAX = 10;

/** 按点数分组 */
function groupByPoint(hand: Card[]): Map<number, Card[]> {
    const m = new Map<number, Card[]>();
    for (const c of hand) {
        if (!m.has(c.point)) m.set(c.point, []);
        m.get(c.point)!.push(c);
    }
    const vals = Array.from(m.values());
    for (const arr of vals) arr.sort((a, b) => a.suit - b.suit);
    return m;
}

/** 计算组合的排序权重（关键牌越小越优先） */
function comboWeight(cards: Card[]): number {
    const p = parsePattern(cards);
    if (!p) return Number.MAX_SAFE_INTEGER;
    return p.point * 10 + (p.suit + 1);
}

function pickMin(combos: Card[][]): Card[] | null {
    if (combos.length === 0) return null;
    let best = combos[0];
    let bw = comboWeight(best);
    for (const c of combos) {
        const w = comboWeight(c);
        if (w < bw) { bw = w; best = c; }
    }
    return best;
}

/** 枚举同点数 N 张的组合 */
function samePointCombos(hand: Card[], n: number): Card[][] {
    const out: Card[][] = [];
    const groups = groupByPoint(hand);
    for (const arr of Array.from(groups.values())) {
        if (arr.length >= n && !arr[0].isJoker) {
            // 取花色最小的 n 张（同等点数下优先保留大花色无意义，直接取前 n 张）
            out.push(arr.slice(0, n));
            // 也提供取最大花色的版本，供花色比较需要时使用
            if (arr.length > n) out.push(arr.slice(arr.length - n));
        }
    }
    return out;
}

/** 枚举顺子：连续 5 个点数，不含 2/3/王 */
function straightCombos(hand: Card[]): Card[][] {
    const out: Card[][] = [];
    const groups = groupByPoint(hand);
    for (let start = STRAIGHT_MIN; start + 4 <= STRAIGHT_MAX; start++) {
        const picks: Card[][] = [];
        let ok = true;
        for (let p = start; p < start + 5; p++) {
            const g = groups.get(p);
            if (!g || g.length === 0) { ok = false; break; }
            picks.push(g);
        }
        if (!ok) continue;
        // 每个点数取一张，组合枚举（限制规模）
        const cart: Card[][] = [[]];
        for (const g of picks) {
            const next: Card[][] = [];
            for (const acc of cart) {
                if (acc.length + 1 < g.length + 1 && cart.length * g.length > 64) break;
                for (const c of g) next.push(acc.concat([c]));
            }
            if (next.length === 0) break;
            cart.length = 0;
            cart.push(...next);
        }
        for (const c of cart) if (c.length === 5) out.push(c);
    }
    return out;
}

/** 枚举同一花色：5 张同花色且点数互不相同 */
function sameColorCombos(hand: Card[]): Card[][] {
    const out: Card[][] = [];
    const byColor = new Map<number, Card[]>();
    for (const c of hand) {
        if (c.isJoker) continue;
        if (!byColor.has(c.color)) byColor.set(c.color, []);
        byColor.get(c.color)!.push(c);
    }
    for (const arr of Array.from(byColor.values())) {
        if (arr.length < 5) continue;
        // 按点数分组，每个点数取一张，共 5 个点数
        const groups = groupByPoint(arr);
        const keys = Array.from(groups.keys()).sort((a, b) => a - b);
        // 限制枚举规模：最多取点数最小的 8 组
        const limited = keys.slice(0, 8);
        const combos = combosOfPoints(groups, limited, 5);
        for (const c of combos) {
            if (parsePattern(c)?.type === PatternType.SAME_SUIT) out.push(c);
        }
    }
    return out;
}

/** 枚举一条龙：同色且连续 */
function dragonCombos(hand: Card[]): Card[][] {
    const out: Card[][] = [];
    for (const c of straightCombos(hand)) {
        if (parsePattern(c)?.type === PatternType.DRAGON) out.push(c);
    }
    return out;
}

/** 从若干点数分组中取 k 个点数各一张 */
function combosOfPoints(groups: Map<number, Card[]>, keys: number[], k: number): Card[][] {
    const results: Card[][] = [];
    const pick = (idx: number, acc: Card[]): void => {
        if (acc.length === k) { results.push(acc.slice()); return; }
        if (idx >= keys.length) return;
        if (results.length > 256) return; // 规模保护
        const g = groups.get(keys[idx])!;
        for (const c of g) {
            acc.push(c);
            pick(idx + 1, acc);
            acc.pop();
        }
        pick(idx + 1, acc);
    };
    pick(0, []);
    return results.filter((c) => c.length === k);
}

/** 枚举指定牌型的所有候选 */
export function candidatesOfType(hand: Card[], type: PatternType): Card[][] {
    switch (type) {
        case PatternType.SINGLE:
            return hand.map((c) => [c]);
        case PatternType.PAIR: {
            const out = samePointCombos(hand, 2);
            // 大王 + 小王 =「王对」，也是合法对子（能压任何对子）
            const small = hand.find((c) => c.isJoker && c.point === POINT_SMALL_JOKER);
            const big = hand.find((c) => c.isJoker && c.point === POINT_BIG_JOKER);
            if (small && big) out.push([small, big]);
            return out;
        }
        case PatternType.TRIO:
            return samePointCombos(hand, 3);
        case PatternType.CHICKEN:
            return samePointCombos(hand, 4);
        case PatternType.TRIO_PAIR: {
            const trios = samePointCombos(hand, 3);
            const pairs = samePointCombos(hand, 2);
            const out: Card[][] = [];
            for (const t of trios) {
                for (const p of pairs) {
                    if (t[0].point !== p[0].point) out.push(t.concat(p));
                }
            }
            return out;
        }
        case PatternType.FOUR_ONE: {
            const fours = samePointCombos(hand, 4);
            const out: Card[][] = [];
            for (const f of fours) {
                for (const c of hand) {
                    if (!f.some((x) => x.id === c.id)) out.push(f.concat([c]));
                }
            }
            return out;
        }
        case PatternType.STRAIGHT:
            return straightCombos(hand).filter((c) => parsePattern(c)?.type === PatternType.STRAIGHT);
        case PatternType.SAME_SUIT:
            return sameColorCombos(hand);
        case PatternType.DRAGON:
            return dragonCombos(hand);
        default:
            return [];
    }
}

/** 全部合法候选（领出时用） */
function allCandidates(hand: Card[]): Card[][] {
    const types = [
        PatternType.SINGLE, PatternType.PAIR, PatternType.TRIO, PatternType.CHICKEN,
        PatternType.TRIO_PAIR, PatternType.FOUR_ONE, PatternType.STRAIGHT,
        PatternType.SAME_SUIT, PatternType.DRAGON,
    ];
    const out: Card[][] = [];
    for (const t of types) out.push(...candidatesOfType(hand, t));
    return out.filter((c) => parsePattern(c) !== null);
}

/** 领出：手牌多时优先走组合，否则出最小单张 */
function chooseLead(hand: Card[]): Card[] | null {
    const singles = hand.map((c) => [c]);
    if (hand.length >= 8) {
        const combos = allCandidates(hand).filter((c) => c.length >= 3);
        const bestCombo = pickMin(combos);
        // 只有组合的关键牌较小才值得拆出（避免拿大牌去凑）
        if (bestCombo && comboWeight(bestCombo) <= comboWeight(sortCardsDesc(hand).slice(0, 1)) ) {
            return bestCombo;
        }
    }
    return pickMin(singles) || sortCards(hand).slice(0, 1);
}

/** 跟牌：先找同型里最小的能压的；5 张牌型同型压不过时，按等级从低到高用更高级牌型压 */
function chooseFollow(hand: Card[], last: Pattern): Card[] | null {
    const cands = candidatesOfType(hand, last.type);
    const beating: Card[][] = [];
    for (const c of cands) {
        const p = parsePattern(c);
        if (p && canBeat(p, last)) beating.push(c);
    }
    const sameType = pickMin(beating);
    if (sameType) return sameType;

    /*
     * 5 张牌型互相可吃（一条龙 > 4带1 > 三带二 > 顺子 > 同一花色）。
     * 同型找不到能压的，就用更高级的 5 张牌型压——
     * 从等级最低的开始找，避免拿着一条龙去压一个顺子这种大材小用。
     */
    const lastRank = fiveTypeRank(last.type);
    if (lastRank > 0) {
        const order = [
            PatternType.SAME_SUIT, PatternType.STRAIGHT, PatternType.TRIO_PAIR,
            PatternType.FOUR_ONE, PatternType.DRAGON,
        ].filter((t) => fiveTypeRank(t) > lastRank);
        for (const t of order) {
            const opts: Card[][] = [];
            for (const c of candidatesOfType(hand, t)) {
                const p = parsePattern(c);
                if (p && canBeat(p, last)) opts.push(c);
            }
            const best = pickMin(opts);
            if (best) return best;
        }
    }
    return null;
}

/**
 * AI 出牌决策
 * @returns 要出的牌；返回 null 表示跳过（要不起）
 */
export function decidePlay(hand: Card[], last: Pattern | null): Card[] | null {
    if (!hand || hand.length === 0) return null;
    if (!last) return chooseLead(hand);
    return chooseFollow(hand, last);
}

/** 交牌时给出最弱的一张 */
export function decideExchangeReturn(hand: Card[]): Card | null {
    if (hand.length === 0) return null;
    return sortCards(hand)[0];
}

/**
 * 敌人身份暴露后的领出决策：必须打出含方块4的牌型。
 * 从所有合法领出组合里挑「含方块4」且整体最小的一手；实在没有组合就单出方块4。
 */
export function decideRevealLead(hand: Card[]): Card[] | null {
    const d4 = hand.find((c) => c.id === DIAMOND_4_ID);
    if (!d4) return null; // 方块4已不在手上，无此约束
    const combos = allCandidates(hand).filter((c) => c.some((x) => x.id === d4.id));
    const best = pickMin(combos);
    return best || [d4];
}
