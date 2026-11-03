/**
 * 乌龟4 —— 连点/重复提交测试
 *
 * 针对「鼠标或手指连点，同一张牌被搬好几次、出现重影」这类问题。
 *
 * 分两层校验：
 *   A. 引擎层：同一个步骤被连续 submitExchange 多次，必须只有第一次生效，
 *      后面全部返回 false，且牌数守恒（没有凭空多出/丢失牌）。
 *   B. UI 层：GameScene 的提交锁逻辑（exchangeLock / playLock / 节流）
 *      用纯逻辑复刻一遍，验证连点下只提交一次。
 */

import {
    DIAMOND_4_ID, isExchangeable, createDeck,
} from '../assets/scripts/core/Card';
import { GameEngine, Phase } from '../assets/scripts/core/GameEngine';

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log('  [OK] ' + msg); }
    else { fail++; console.log('  [FAIL] ' + msg); }
}

function totalCards(e: GameEngine): number {
    let n = 0;
    for (let s = 0; s < 4; s++) n += e.players[s].cards.length;
    n += e.tableCards.length;
    return n;
}

function playUntilRoundEnd(e: GameEngine): void {
    let g = 0;
    while ((e.phase as Phase) === Phase.PLAYING && g++ < 800) {
        const a = e.aiAction();
        if (a.action === 'play' && a.cards && a.cards.length) e.playCards(e.currentSeat, a.cards);
        else e.pass(e.currentSeat);
    }
}

// ============================================================
// A. 引擎层：同一步骤连续提交 N 次
// ============================================================
console.log('===== A. 引擎层：同一步骤连点 =====');
{
    let stepCases = 0;
    let dupAccepted = 0;        // 第二次以后仍被接受（= bug）
    let cardCountBroken = 0;    // 牌数不守恒（= 重影根源）
    let logDoubleCount = 0;     // 同一条换牌记录出现两次

    for (let game = 0; game < 30; game++) {
        const e = new GameEngine({ humanSeat: 0, minRounds: 9 });
        e.startRound();
        for (let r = 0; r < 4; r++) {
            playUntilRoundEnd(e);
            e.startRound();

            let guard = 0;
            while (e.phase === Phase.EXCHANGE && guard++ < 80) {
                const step = e.currentExchange;
                if (!step) { e.advanceExchange(); continue; }

                const ids = e.pendingGiveCards().map((c) => c.id);
                const submit = ids.length ? ids : -1;
                const before = totalCards(e);
                const logBefore = e.exchangeLog.length;
                const kindBefore = step.kind;

                // 模拟"手指连点 5 下"
                const results: boolean[] = [];
                for (let k = 0; k < 5; k++) results.push(e.submitExchange(submit));

                stepCases++;
                // 第一次应该被接受，后面 4 次必须全部被拒
                const extraAccepted = results.slice(1).filter((x) => x).length;
                if (extraAccepted > 0) dupAccepted++;

                if (totalCards(e) !== before) cardCountBroken++;

                /*
                 * 注意：第一次提交成功后，引擎会顺带把后续的 AI 步骤一口气跑完，
                 * 所以 exchangeLog 的新增量里混了别的座位产生的记录。
                 * 只统计「本步骤本人」产生的记录条数才有意义。
                 */
                const addedByMe = e.exchangeLog.slice(logBefore)
                    .filter((x) => x.from === step.from && x.kind === kindBefore).length;
                const expectMax = (kindBefore === 'ENEMY_PUT' || kindBefore === 'ENEMY_RETURN')
                    ? step.count : 1;
                if (addedByMe > expectMax) logDoubleCount++;
            }
        }
    }

    ok(stepCases > 0, `测到 ${stepCases} 个真人步骤的连点`);
    ok(dupAccepted === 0, `同一牌不能被交两次（重复被接受 ${dupAccepted} 次）`);
    ok(cardCountBroken === 0, `连点后总牌数仍是 54（异常 ${cardCountBroken} 次）`);
    ok(logDoubleCount === 0, `同一步骤不会产生重复换牌记录（异常 ${logDoubleCount} 次）`);
}

// ============================================================
// B. 单独验证 LOSER_GIVE 传 -1 不会重复交牌
//    这是之前最危险的一处：每次传 -1 都会重新取"当前最大"，会连交好几张
// ============================================================
console.log('\n===== B. 被抓龟传 -1 的连点 =====');
{
    let tested = 0;
    let stolen = 0;

    for (let game = 0; game < 30; game++) {
        const e = new GameEngine({ humanSeat: 0, minRounds: 9 });
        e.startRound();
        for (let r = 0; r < 4; r++) {
            playUntilRoundEnd(e);
            e.startRound();
            let guard = 0;
            while (e.phase === Phase.EXCHANGE && guard++ < 80) {
                const step = e.currentExchange;
                if (!step) { e.advanceExchange(); continue; }

                if (step.kind === 'LOSER_GIVE') {
                    const handBefore = e.players[step.from].cards.length;
                    // 连点 6 下，全部传 -1（系统自动挑最大）
                    for (let k = 0; k < 6; k++) e.submitExchange(-1);
                    // 这一步只该让被抓龟少 1 张；若少 2 张以上就是重复交牌
                    const handAfter = e.players[step.from].cards.length;
                    tested++;
                    if (handBefore - handAfter > 1) stolen++;
                } else {
                    const ids = e.pendingGiveCards().map((c) => c.id);
                    e.submitExchange(ids.length ? ids : -1);
                }
            }
        }
    }
    ok(tested > 0, `测到 ${tested} 次 LOSER_GIVE`);
    ok(stolen === 0, `传 -1 连点只会交 1 张，不会连交多张（异常 ${stolen} 次）`);
}

// ============================================================
// C. 敌人摆牌连点：桌上不能出现重复的牌
// ============================================================
console.log('\n===== C. 敌人摆牌连点 =====');
{
    let tested = 0;
    let dupOnTable = 0;
    let wrongCount = 0;

    for (let game = 0; game < 30; game++) {
        const e = new GameEngine({ humanSeat: 0, minRounds: 9 });
        e.startRound();
        for (let r = 0; r < 4; r++) {
            playUntilRoundEnd(e);
            e.startRound();
            let guard = 0;
            while (e.phase === Phase.EXCHANGE && guard++ < 80) {
                const step = e.currentExchange;
                if (!step) { e.advanceExchange(); continue; }

                if (step.kind === 'ENEMY_PUT') {
                    const want = e.pendingGiveCards().map((c) => c.id);
                    const needCount = step.count;
                    // 连点 5 下
                    for (let k = 0; k < 5; k++) e.submitExchange(want);
                    tested++;

                    /*
                     * 摆牌成功后引擎会继续跑 AI 拿牌步骤，桌上会被拿走。
                     * 所以要看「摆到桌上的总张数」和「被拿走的张数」是否匹配，
                     * 而不是看当前 tableCards 还剩几张。
                     */
                    const puts = e.exchangeLog.filter((x) => x.kind === 'ENEMY_PUT').length;
                    if (puts !== needCount) wrongCount++;

                    // 整局都没出现过同一张牌被摆两次
                    const putIds = e.exchangeLog.filter((x) => x.kind === 'ENEMY_PUT').map((x) => x.card.id);
                    if (new Set(putIds).size !== putIds.length) dupOnTable++;
                } else {
                    const ids = e.pendingGiveCards().map((c) => c.id);
                    e.submitExchange(ids.length ? ids : -1);
                }
            }
        }
    }
    ok(tested > 0, `测到 ${tested} 次 ENEMY_PUT`);
    ok(dupOnTable === 0, `连点后桌上没有重复的同一张牌（异常 ${dupOnTable} 次）`);
    ok(wrongCount === 0, `连点后桌上张数仍等于游客人数（异常 ${wrongCount} 次）`);
}

// ============================================================
// D. UI 锁逻辑复刻：验证 exchangeLock 能挡住连点
// ============================================================
console.log('\n===== D. UI 提交锁逻辑 =====');
{
    // 复刻 GameScene.onExchangeButton 的核心判据
    let lock = false;
    let selId = 7;
    let submitCount = 0;

    const tap = (): void => {
        if (lock) return;
        if (selId <= 0) return;
        lock = true;
        const id = selId;
        selId = -1;
        submitCount++;
        // 模拟 0.05s 后解锁（与真实代码一致）
        // 这里不真等，直接手动解锁
        void id;
    };

    // 模拟连点 10 下
    for (let k = 0; k < 10; k++) tap();
    ok(submitCount === 1, `连点 10 下只提交 1 次（实际 ${submitCount} 次）`);

    // 解锁后，由于 selId 已被清空，再点也不会重复提交
    lock = false;
    for (let k = 0; k < 10; k++) tap();
    ok(submitCount === 1, `即使锁被释放，旧选择已清空，不会再提交（实际 ${submitCount} 次）`);
}

// ============================================================
// E. 节流时间窗
// ============================================================
console.log('\n===== E. 点击节流 =====');
{
    const THROTTLE = 0.18;
    let lastTap = 0;
    let accepted = 0;
    const passTap = (now: number): boolean => {
        if (now - lastTap < THROTTLE) return false;
        lastTap = now;
        return true;
    };
    // 模拟 60fps 下连点 20 帧（每帧 1/60 秒）
    for (let i = 0; i < 20; i++) {
        if (passTap(i / 60)) accepted++;
    }
    // 20 帧 = 0.317 秒，按 0.18 秒窗口，最多 2 次
    ok(accepted >= 1 && accepted <= 2,
        `0.32 秒内连点 20 次只放行 ${accepted} 次（应为 1~2 次）`);

    // 正常间隔点击（每 0.3 秒一次）应全部放行
    lastTap = 0; accepted = 0;
    for (let i = 0; i < 5; i++) {
        if (passTap(1 + i * 0.3)) accepted++;
    }
    ok(accepted === 5, `每 0.3 秒正常点击 5 次全部放行（实际 ${accepted} 次）`);
}

console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);
if (fail > 0) throw new Error('连点测试失败');
