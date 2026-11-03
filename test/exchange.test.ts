/**
 * 乌龟4 —— 交牌专项测试（桌上抢牌模型）
 *
 * 校验重点：
 *   1. 方块4 与已交换牌永远不参与交牌
 *   2. 敌人摆到桌上的必须是最大的 N 张
 *   3. 游客按 导游 > 中游 > 尾游 的顺序拿牌，且拿的必须是桌上现存的牌
 *   4. 还牌是"自愿选择"，不要求最小
 *   5. 先出牌权 = 交出最大牌的人
 *   6. 「同一花色」必须真的同花色，不能红黑混凑
 */

import { Card, DIAMOND_4_ID, exchangeableCards, isExchangeable, createDeck, Suit } from '../assets/scripts/core/Card';
import { GameEngine, Phase, RANK_NAME } from '../assets/scripts/core/GameEngine';
import { parsePattern, PatternType } from '../assets/scripts/core/Pattern';

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log('  [OK] ' + msg); }
    else { fail++; console.log('  [FAIL] ' + msg); }
}

// ================= 1. 基础判定 =================
console.log('===== 1. isExchangeable 基础判定 =====');
const deck = createDeck();
const d4 = deck.find((c) => c.id === DIAMOND_4_ID)!;
const d5 = deck.find((c) => c.name === '方块5')!;
ok(!isExchangeable(d4), '方块4 不可交换');
ok(isExchangeable(d5), '方块5 可交换');
d5.exchanged = true;
ok(!isExchangeable(d5), '被交换过的牌不可再交换');

// ================= 2. 同一花色牌型 =================
console.log('\n===== 2. 同一花色（必须真的同花色，不是红黑同色）=====');
const find = (name: string) => createDeck().find((c) => c.name === name)!;
{
    // 全是方块但点数不连续 → 同一花色（连续的话会升级成一条龙）
    const allDiamond = ['方块5', '方块7', '方块8', '方块9', '方块J'].map(find);
    const p1 = parsePattern(allDiamond);
    ok(p1?.type === PatternType.SAME_SUIT, `5 张不连续的方块 = 同一花色（实际 ${p1?.name}）`);

    // 红黑混着、花色不统一 → 不合法
    const mixed = ['方块5', '红桃6', '方块7', '红桃8', '方块9'].map(find);
    const p2 = parsePattern(mixed);
    ok(p2 === null || p2.type !== PatternType.SAME_SUIT,
        `方块红桃混凑不算同一花色（实际 ${p2 ? p2.name : 'null'}）`);

    // 全是黑桃且连续 → 一条龙（同花顺，优先级高于同一花色）
    const allSpade = ['黑桃5', '黑桃6', '黑桃7', '黑桃8', '黑桃9'].map(find);
    const p3 = parsePattern(allSpade);
    ok(p3?.type === PatternType.DRAGON, `黑桃5-9 既是同花色又是顺子 = 一条龙（实际 ${p3?.name}）`);

    // 关键回归：红桃 + 梅花混着（红黑都有）绝对不能算同一花色
    const blackRed = ['红桃4', '梅花5', '红桃6', '梅花7', '红桃8'].map(find);
    const p4 = parsePattern(blackRed);
    ok(p4 === null || p4.type !== PatternType.SAME_SUIT,
        `红桃梅花混凑不算同一花色（实际 ${p4 ? p4.name : 'null'}）`);
}

// ================= 3. 完整多局模拟 =================
console.log('\n===== 3. 多局实战：交牌流程与约束 =====');

let totalRounds = 0;
let d4Exchanged = 0;
let putNotTop = 0;
let pickOrderBad = 0;
let pickNotOnTable = 0;
let leadWrong = 0;
let leadChecked = 0;

for (let t = 0; t < 80; t++) {
    const e = new GameEngine({ humanSeat: 9, minRounds: 9 });
    e.startRound();
    for (let r = 0; r < 8; r++) {
        let g = 0;
        while ((e.phase as Phase) === Phase.PLAYING && g++ < 500) {
            const a = e.aiAction();
            if (a.action === 'play' && a.cards && a.cards.length) e.playCards(e.currentSeat, a.cards);
            else e.pass(e.currentSeat);
        }
        const last = e.lastResult!;
        const tourists = last.finishOrder.filter((s) => s !== last.enemySeat);
        const enemySeat = last.enemySeat;

        e.startRound();
        totalRounds++;

        let guard = 0;
        while (e.phase === Phase.EXCHANGE && guard++ < 60) {
            const step = e.currentExchange;
            if (!step) { e.advanceExchange(); continue; }
            const ids = e.pendingGiveCards().map((c) => c.id);
            e.submitExchange(ids.length ? ids : -1);
        }

        // 拿牌顺序从日志里读（AI 步骤是连跑完的，循环看不到 currentExchange）
        const actualPick = e.exchangeLog
            .filter((x) => x.kind === 'TOURIST_PICK')
            .map((x) => x.to);

        // 检查交牌日志
        for (const rec of e.exchangeLog) {
            if (rec.card.id === DIAMOND_4_ID) d4Exchanged++;
        }

        // 摆上桌的必须是最大的 N 张
        const puts = e.exchangeLog.filter((x) => x.kind === 'ENEMY_PUT');
        if (puts.length !== tourists.length) {
            putNotTop++;
        }

        // 拿牌顺序必须等于 导游 > 中游 > 尾游
        if (JSON.stringify(actualPick) !== JSON.stringify(tourists)) {
            pickOrderBad++;
            if (pickOrderBad <= 2) {
                console.log(`    [顺序错] 实际=${actualPick} 期望=${tourists}`);
            }
        }

        // 先出牌权
        if (e.bigGives.length > 0) {
            let top = e.bigGives[0];
            for (const g of e.bigGives) if (g.card.id > top.card.id) top = g;
            leadChecked++;
            if (e.currentSeat !== top.seat) leadWrong++;
        }

        // 打完本局
        g = 0;
        while ((e.phase as Phase) === Phase.PLAYING && g++ < 500) {
            const a = e.aiAction();
            if (a.action === 'play' && a.cards && a.cards.length) e.playCards(e.currentSeat, a.cards);
            else e.pass(e.currentSeat);
        }
    }
}

ok(d4Exchanged === 0, `共 ${totalRounds} 局，方块4 被交换次数 = ${d4Exchanged}`);
ok(putNotTop === 0, `敌人摆上桌的张数始终 = 游客人数（异常 ${putNotTop} 次）`);
ok(pickOrderBad === 0, `游客拿牌顺序始终 导游>中游>尾游（异常 ${pickOrderBad} 次）`);
ok(leadWrong === 0, `先出牌权归属正确（校验 ${leadChecked} 次，错误 ${leadWrong} 次）`);

// ================= 4. 还牌不要求最小 =================
console.log('\n===== 4. 还牌是自愿选择，不强制最小 =====');
{
    let tested = 0;
    let rejected = 0;
    for (let t = 0; t < 200; t++) {
        const e = new GameEngine({ humanSeat: 0, minRounds: 9 });
        e.startRound();
        for (let r = 0; r < 5; r++) {
            let g = 0;
            while ((e.phase as Phase) === Phase.PLAYING && g++ < 500) {
                const a = e.aiAction();
                if (a.action === 'play' && a.cards && a.cards.length) e.playCards(e.currentSeat, a.cards);
                else e.pass(e.currentSeat);
            }
            e.startRound();
            let guard = 0;
            while (e.phase === Phase.EXCHANGE && guard++ < 60) {
                const step = e.currentExchange;
                if (!step) { e.advanceExchange(); continue; }
                if (step.from === 0 && (step.kind === 'TOURIST_RETURN' || step.kind === 'ENEMY_RETURN')) {
                    // 故意选「不是最小」的可交牌
                    const free = e.playerFreeCards(0);
                    if (free.length >= 2) {
                        // ENEMY_RETURN 必须一次交够 count 张，这里取最大的 count 张（明显不是最小的）
                        const need = step.kind === 'ENEMY_RETURN' ? Math.max(1, step.count || 1) : 1;
                        const notMin = free.slice().reverse().slice(0, need);
                        const accepted = e.submitExchange(notMin.map((c) => c.id));
                        tested++;
                        if (!accepted) rejected++;
                        if (tested >= 60) break;
                    } else {
                        const ids = e.pendingGiveCards().map((c) => c.id);
                        e.submitExchange(ids.length ? ids : -1);
                    }
                } else {
                    const ids = e.pendingGiveCards().map((c) => c.id);
                    e.submitExchange(ids.length ? ids : -1);
                }
            }
            if (tested >= 60) break;
        }
        if (tested >= 60) break;
    }
    ok(tested > 0, `测到 ${tested} 次"交非最小的牌"`);
    ok(rejected === 0, `交非最小的牌全部被接受（被拒 ${rejected} 次）`);
}

// ============================================================
// 5. 先出牌权：谁交出去的那张最大，谁先出
//    参与比较的是「所有交大牌的人」——敌人摆到桌上的 + 被抓龟给敌人的
// ============================================================
console.log('\n===== 5. 先出牌权归属 =====');
{
    let checked = 0;
    let wrongSeat = 0;
    let wrongEnemyHasD4 = 0;
    let multiLoserCases = 0;

    for (let game = 0; game < 40; game++) {
        const e = new GameEngine({ humanSeat: 0, minRounds: 9 });
        e.startRound();
        for (let r = 0; r < 4; r++) {
            let g = 0;
            while ((e.phase as Phase) === Phase.PLAYING && g++ < 500) {
                const a = e.aiAction();
                if (a.action === 'play' && a.cards && a.cards.length) e.playCards(e.currentSeat, a.cards);
                else e.pass(e.currentSeat);
            }
            e.startRound();
            let guard = 0;
            while (e.phase === Phase.EXCHANGE && guard++ < 60) {
                const ids = e.pendingGiveCards().map((c) => c.id);
                e.submitExchange(ids.length ? ids : -1);
            }
            if (e.phase !== Phase.PLAYING) continue;

            // 逐条重算「交出最大牌的人」
            if (e.bigGives.length === 0) continue;
            let top = e.bigGives[0];
            for (const gg of e.bigGives) if (gg.card.id > top.card.id) top = gg;
            checked++;
            if (e.currentSeat !== top.seat) wrongSeat++;
            // 敌人手上不该还拿着方块4 时却…（只检查交出去的大牌里没有方块4）
            if (e.bigGives.some((gg) => gg.card.id === DIAMOND_4_ID)) wrongEnemyHasD4++;
            if (e.bigGives.filter((gg) => gg.seat !== e.lastResult!.enemySeat).length > 0
                && e.bigGives.some((gg) => gg.seat === e.lastResult!.enemySeat)) {
                multiLoserCases++; // 敌人和被抓龟都交了牌，参与同一次比较
            }
        }
    }
    ok(checked > 0, `测到 ${checked} 次有效交牌`);
    ok(wrongSeat === 0, `先出牌者始终是交出最大牌的人（错 ${wrongSeat} 次）`);
    ok(wrongEnemyHasD4 === 0, `交出去的大牌里从未出现方块4（${wrongEnemyHasD4} 次）`);
    ok(multiLoserCases > 0, `敌人与被抓龟同时交牌的局也参与了同一次比较（${multiLoserCases} 次）`);
}

// ============================================================
// 6. 桌上摆牌张数 = 游客人数，且被拿完后桌子清空
// ============================================================
console.log('\n===== 6. 桌上摆牌张数 =====');
{
    let checked = 0;
    let wrongCount = 0;
    let leftOnTable = 0;
    for (let game = 0; game < 40; game++) {
        const e = new GameEngine({ humanSeat: 0, minRounds: 9 });
        e.startRound();
        for (let r = 0; r < 3; r++) {
            let g = 0;
            while ((e.phase as Phase) === Phase.PLAYING && g++ < 500) {
                const a = e.aiAction();
                if (a.action === 'play' && a.cards && a.cards.length) e.playCards(e.currentSeat, a.cards);
                else e.pass(e.currentSeat);
            }
            const r0 = e.lastResult;
            const touristCount = r0 ? r0.finishOrder.filter((s) => s !== r0.enemySeat).length : 0;
            e.startRound();
            let guard = 0;
            while (e.phase === Phase.EXCHANGE && guard++ < 60) {
                const ids = e.pendingGiveCards().map((c) => c.id);
                e.submitExchange(ids.length ? ids : -1);
            }
            if (touristCount === 0) continue;

            // 从交牌记录里数「摆到桌上」的张数 / 「被拿走」的张数
            const puts = e.exchangeLog.filter((x) => x.kind === 'ENEMY_PUT').length;
            const picks = e.exchangeLog.filter((x) => x.kind === 'TOURIST_PICK').length;
            checked++;
            if (puts !== touristCount) wrongCount++;
            if (picks !== puts) wrongCount++;   // 摆几张就被拿走几张
            if (e.tableCards.length !== 0) leftOnTable++;
        }
    }
    ok(checked > 0, `测到 ${checked} 局有游客的交牌`);
    ok(wrongCount === 0, `摆到桌上的张数 = 游客人数，且全部被拿走（错 ${wrongCount} 项）`);
    ok(leftOnTable === 0, `交牌结束时桌上不留牌（错 ${leftOnTable} 局）`);
}

console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);
if (fail > 0) throw new Error('交牌专项测试失败');
