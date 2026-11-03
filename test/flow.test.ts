/**
 * 乌龟4 —— 人机完整流程模拟测试
 *
 * 目的：验证 UI（GameScene）会走的那条路径不会卡死，尤其是「真人参与交牌」的分支。
 * 关键不变量：
 *   1. 交牌过程中总牌数必须恒为 54（有给出就必须有归还）
 *   2. 同一张牌在同一局的交牌阶段不会被交换两次（exchanged 标记）
 *   3. 真人步骤（LOSER_GIVE / TURTLE_RETURN）一定能被推进
 */

import { Card, DIAMOND_4_ID } from '../assets/scripts/core/Card';
import { GameEngine, Phase } from '../assets/scripts/core/GameEngine';

let pass = 0;
let fail = 0;

function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log('  [OK] ' + msg); }
    else { fail++; console.log('  [FAIL] ' + msg); }
}

/** 全场牌数：四家手牌 + 桌上正中间待认领的牌 */
function totalCards(e: GameEngine): number {
    return e.players.reduce((a, p) => a + p.cards.length, 0) + e.tableCards.length;
}

/** 模拟真人（座 0）的交牌选择：按引擎给的建议走 */
function humanExchangeChoice(e: GameEngine): number {
    const c = e.pendingGiveCard();
    return c ? c.id : -1;
}

const ROUNDS = 8;
const e = new GameEngine({ humanSeat: 0, minRounds: 2 });

console.log('===== 人机完整流程模拟（座 0 为真人代打）=====');

for (let r = 0; r < ROUNDS; r++) {
    e.startRound();

    // ---------- 交牌阶段（桌上抢牌模型） ----------
    let guard = 0;
    const seenCardIds: number[] = [];
    while (e.phase === Phase.EXCHANGE) {
        if (guard++ > 60) throw new Error('交牌阶段死循环');
        const before = totalCards(e);
        const step = e.currentExchange;
        if (!step) { e.advanceExchange(); continue; }
        if (step.from !== 0) throw new Error('出现非真人待选步骤，UI 分支会走空');

        if (step.kind === 'ENEMY_PUT') {
            const wants = e.pendingGiveCards();
            ok(wants.length === Math.max(1, step.count),
                `第${r + 1}局 ENEMY_PUT 要摆 ${step.count} 张（实际 ${wants.length}）`);
            ok(wants.every((c) => c.id !== DIAMOND_4_ID), `第${r + 1}局 ENEMY_PUT 不含方块4`);
            // 必须是手上最大的 N 张
            const free = e.playerFreeCards(0).slice().reverse().slice(0, wants.length).map((c) => c.id);
            ok(JSON.stringify(wants.map((c) => c.id)) === JSON.stringify(free),
                `第${r + 1}局 ENEMY_PUT 摆的正是最大的 ${wants.length} 张`);
            // 少摆一张应被拒
            if (wants.length > 1) {
                ok(e.submitExchange([wants[0].id]) === false, `第${r + 1}局 ENEMY_PUT 张数不足被拒`);
            }
            // 摆一张非最大的应被拒
            const notTop = e.playerFreeCards(0).slice(0, -(wants.length))[0];
            if (notTop && wants.length > 0) {
                const fake = wants.slice(0, -1).concat([notTop]).map((c) => c.id);
                ok(e.submitExchange(fake) === false, `第${r + 1}局 ENEMY_PUT 拒绝非最大牌`);
            }
        } else if (step.kind === 'TOURIST_PICK') {
            const table = e.tableCards.slice();
            ok(table.length > 0, `第${r + 1}局 TOURIST_PICK 时桌上有牌（${table.length} 张）`);
            const pick = table[0];
            const accepted = e.submitExchange(pick.id);
            ok(accepted, `第${r + 1}局 TOURIST_PICK 拿牌成功（${pick.name}）`);
            ok(totalCards(e) === before, `第${r + 1}局 拿牌后总牌数仍为 54`);
            continue;
        } else if (step.kind === 'LOSER_GIVE') {
            const want = e.pendingGiveCard();
            ok(!!want, `第${r + 1}局 LOSER_GIVE 能拿到最大牌建议`);
            ok(!!want && want.id !== DIAMOND_4_ID, `第${r + 1}局 LOSER_GIVE 建议不是方块4`);
        } else {
            // TOURIST_RETURN / ENEMY_RETURN：自愿选择，不要求最小
            const free = e.playerFreeCards(0);
            ok(free.length > 0, `第${r + 1}局 ${step.kind} 有可交的牌（${free.length} 张）`);
        }

        // 方块4 在任何交牌步骤都必须被拒
        if (e.players[0].cards.some((c) => c.id === DIAMOND_4_ID)) {
            ok(e.submitExchange(DIAMOND_4_ID) === false, `第${r + 1}局 方块4 被拒绝交出`);
        }

        const ids = e.pendingGiveCards().map((c) => c.id);
        const accepted = e.submitExchange(ids.length ? ids : -1);
        ok(accepted, `第${r + 1}局 ${step.kind} 提交被接受`);
        ok(totalCards(e) === before, `第${r + 1}局 交牌一步后总数仍为 54（${step.kind}）`);
    }

    ok(totalCards(e) === 54, `第${r + 1}局 交牌结束后总牌数 = 54`);
    ok(e.tableCards.length === 0, `第${r + 1}局 交牌结束后桌上没有剩牌（${e.tableCards.length}）`);

    // 本局交换过的牌 id 必须互不重复（同局不能二次交换）
    // 摆上桌(ENEMY_PUT)与拿走(TOURIST_PICK)、敌人还到桌上(ENEMY_RETURN)与被抓龟挑走(LOSER_PICK)
    // 都是同一张牌的两段流程，不算两次交换
    for (const rec of e.exchangeLog) {
        if (rec.kind !== 'ENEMY_PUT' && rec.kind !== 'TOURIST_PICK'
            && rec.kind !== 'ENEMY_RETURN' && rec.kind !== 'LOSER_PICK') seenCardIds.push(rec.card.id);
    }
    const uniq = new Set(seenCardIds);
    ok(uniq.size === seenCardIds.length,
        `第${r + 1}局 交牌没有同一张牌被换两次（换手 ${seenCardIds.length} 张）`);

    // 被抓龟挑小牌的顺序 = 谁交给敌人的大牌更大谁先挑
    if (e.loserGivenCards.length > 1) {
        const expectOrder = e.loserGivenCards.slice().sort((a, b) => b.card.id - a.card.id).map((x) => x.seat);
        ok(JSON.stringify(e.loserPickOrder) === JSON.stringify(expectOrder),
            `第${r + 1}局 被抓龟按交牌大小降序挑小牌（${JSON.stringify(e.loserPickOrder)}）`);
    }

    // ---------- 出牌阶段 ----------
    let steps = 0;
    while (e.phase === Phase.PLAYING) {
        if (steps++ > 4000) throw new Error('出牌阶段死循环');
        const seat = e.currentSeat;
        // 座 0 也走 aiAction（内部已处理暴露约束），保证模拟与 UI 一致
        const act = e.aiAction();
        if (act.action === 'play' && act.cards && act.cards.length) {
            if (!e.playCards(seat, act.cards)) throw new Error('座' + seat + '选出的牌被判定非法：' + act.cards.map((c) => c.name));
        } else {
            e.pass(seat);
        }
        if (totalCards(e) > 54) throw new Error('牌数异常增加');
    }

    ok(e.phase === Phase.ROUND_END, `第${r + 1}局 正常结束`);
    const res = e.lastResult!;
    ok(!!res, `第${r + 1}局 有结算结果`);
    ok(Object.keys(res.rankNames).length === 4, `第${r + 1}局 名次覆盖 4 个座位`);

    // 胜负自洽：敌人赢 = 敌人出完且仍有乌龟没出完；乌龟赢 = 三只乌龟全部出完
    const allTurtlesDone = e.players.filter((p) => !p.isEnemy).every((p) => p.finished);
    ok(res.enemyWin
        ? (e.players[res.enemySeat].finished && !allTurtlesDone)
        : allTurtlesDone,
        `第${r + 1}局 胜负判定自洽`);

    // 名次自洽：被抓走的乌龟不得有名次
    for (let s = 0; s < 4; s++) {
        if (!e.players[s].isEnemy && !e.players[s].finished) {
            ok(res.rankNames[s] === '被抓走', `第${r + 1}局 座${s} 未出完标注为「被抓走」`);
        }
    }

    const meWin = e.isWinner(0);
    console.log(`  第${r + 1}局: 敌人=座${res.enemySeat} ${res.enemyWin ? '敌人赢' : '乌龟方赢'} `
        + `我=${meWin ? '赢' : '输'} 名次=${JSON.stringify(res.rankNames)}`);
}

ok(e.roundNo === ROUNDS, `连续打了 ${ROUNDS} 局`);
// lastGuideSeat 是在「最后一局开局时」按倒数第二局结果设置的
{
    const prev = e.history[e.history.length - 2];
    if (prev) {
        const expectedGuide = prev.finishOrder.find((s) => s !== prev.enemySeat);
        const expected = expectedGuide !== undefined ? expectedGuide : -1;
        ok(e.lastGuideSeat === expected,
            `上一局导游记录正确（lastGuideSeat=${e.lastGuideSeat}，期望=${expected}）`);
    }
}

console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);
if (fail > 0) throw new Error('有用例失败');
