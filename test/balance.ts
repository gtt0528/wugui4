/**
 * 乌龟4 —— 平衡性统计
 *
 * 统计两类数据：
 *   A. 独立首局（不受交牌影响）：敌人「第一个出完」的胜率，理论期望约 25%
 *   B. 连续 4 局一桌（含交牌）：观察交牌是否让敌人滚雪球
 */

import { GameEngine, Phase } from '../assets/scripts/core/GameEngine';

function playOutRound(e: GameEngine): void {
    let guard = 0;
    while (e.phase === Phase.EXCHANGE) {
        if (guard++ > 50) throw new Error('交牌死循环');
        const step = e.currentExchange;
        if (!step) { e.advanceExchange(); break; }
        // 引擎自己会给建议牌（系统挑最大 / 挑最小），这里直接照做
        const pick = e.pendingGiveCard();
        e.submitExchange(pick ? pick.id : -1);
    }
    let steps = 0;
    while (e.phase === Phase.PLAYING) {
        if (steps++ > 4000) throw new Error('出牌死循环');
        const seat = e.currentSeat;
        // 统一走 aiAction（内部已处理「敌人暴露必须带方块4」等约束）
        const act = e.aiAction();
        if (act.action === 'play' && act.cards && act.cards.length) {
            if (!e.playCards(seat, act.cards)) throw new Error('出牌被拒 seat=' + seat);
        } else {
            e.pass(seat);
        }
    }
}

// ---------- A. 独立首局 ----------
const N = 2000;
let enemyWinA = 0;
let firstOutEnemy = 0;
for (let i = 0; i < N; i++) {
    const e = new GameEngine({ humanSeat: 0, minRounds: 2 }); // humanSeat 只影响谁来点，全 AI 代打
    e.startRound();
    playOutRound(e);
    const r = e.lastResult!;
    if (r.enemyWin) enemyWinA++;
    if (r.finishOrder[0] === r.enemySeat) firstOutEnemy++;
}
console.log('===== A. 独立首局（每组全新发牌，无交牌）=====');
console.log(`  样本 ${N} 局`);
console.log(`  敌人胜率        : ${(enemyWinA / N * 100).toFixed(1)}%   （理论期望 ≈ 25%）`);
console.log(`  敌人第一个出完率: ${(firstOutEnemy / N * 100).toFixed(1)}%`);

// ---------- B. 连续 4 局一桌 ----------
const TABLES = 400;
const perRoundWin: number[] = [0, 0, 0, 0];
const perRoundCount: number[] = [0, 0, 0, 0];
let enemyWinB = 0;
let totalB = 0;
for (let t = 0; t < TABLES; t++) {
    const e = new GameEngine({ humanSeat: 0, minRounds: 4 });
    for (let r = 0; r < 4; r++) {
        e.startRound();
        playOutRound(e);
        const res = e.lastResult!;
        perRoundCount[r]++;
        if (res.enemyWin) { enemyWinB++; perRoundWin[r]++; }
        totalB++;
    }
}
console.log('\n===== B. 连续 4 局一桌（含交牌）=====');
console.log(`  样本 ${TABLES} 桌 / ${totalB} 局`);
console.log(`  敌人总胜率      : ${(enemyWinB / totalB * 100).toFixed(1)}%`);
for (let r = 0; r < 4; r++) {
    console.log(`  第 ${r + 1} 局敌人胜率 : ${(perRoundWin[r] / perRoundCount[r] * 100).toFixed(1)}%`);
}
console.log('\n  说明：若第 2~4 局敌人胜率明显高于第 1 局，说明交牌机制让敌人滚雪球，');
console.log('       可通过「敌人归还时给次大牌」或「限制交牌轮数」来平衡。');
