/**
 * 乌龟4 规则测试：牌型识别、大小比较、发牌、完整对局模拟
 * 运行方式：先 tsc 编译，再 node 执行
 */

import { createDeck, Card, sortCards } from '../assets/scripts/core/Card';
import { parsePattern, canBeat, PatternType, Pattern } from '../assets/scripts/core/Pattern';
import { GameEngine, Phase, SEAT_COUNT } from '../assets/scripts/core/GameEngine';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra: string = ''): void {
    if (cond) { pass++; console.log(`  [OK] ${name}`); }
    else { fail++; console.log(`  [FAIL] ${name} ${extra}`); }
}

/** 按牌名取牌（如 "梅花4" "大王"） */
function card(deck: Card[], name: string): Card {
    const c = deck.find((x) => x.name === name);
    if (!c) throw new Error('找不到牌: ' + name);
    return c;
}
function cards(deck: Card[], names: string[]): Card[] {
    return names.map((n) => card(deck, n));
}

console.log('\n===== 1. 牌堆与牌力 =====');
const deck = createDeck();
check('共 54 张', deck.length === 54, `实际 ${deck.length}`);
check('最小为方块4', deck[0].name === '方块4', deck[0].name);
check('最大为大王', deck[53].name === '大王', deck[53].name);
check('小王 id=53', card(deck, '小王').id === 53);
check('方块4 最小', card(deck, '方块4').id === 1);
check('黑桃3 大于 方块A', card(deck, '黑桃3').id > card(deck, '方块A').id);
check('黑桃2 小于 方块3', card(deck, '黑桃2').id < card(deck, '方块3').id);
check('同点数 方块<梅花<红桃<黑桃',
    card(deck, '方块7').id < card(deck, '梅花7').id
    && card(deck, '梅花7').id < card(deck, '红桃7').id
    && card(deck, '红桃7').id < card(deck, '黑桃7').id);

console.log('\n===== 2. 牌型识别 =====');
const t = (names: string[]) => parsePattern(cards(deck, names));
check('单张', t(['方块8'])?.type === PatternType.SINGLE);
check('对子', t(['方块8', '红桃8'])?.type === PatternType.PAIR);
check('王对：大王+小王算一对', t(['小王', '大王'])?.type === PatternType.PAIR);
check('不同点数两张非法', t(['方块8', '红桃9']) === null);
check('三张', t(['方块8', '梅花8', '红桃8'])?.type === PatternType.TRIO);
check('鸡(四张)', t(['方块8', '梅花8', '红桃8', '黑桃8'])?.type === PatternType.CHICKEN);
check('三带二', t(['方块8', '梅花8', '红桃8', '方块9', '红桃9'])?.type === PatternType.TRIO_PAIR);
check('顺子 45678', t(['方块4', '梅花5', '红桃6', '黑桃7', '方块8'])?.type === PatternType.STRAIGHT);
check('顺子 10JQKA', t(['方块10', '梅花J', '红桃Q', '黑桃K', '方块A'])?.type === PatternType.STRAIGHT);
check('含 2 不算顺子', t(['方块10', '梅花J', '红桃Q', '黑桃K', '方块2']) === null);
check('含 3 不算顺子', t(['方块10', '梅花J', '红桃Q', '黑桃K', '方块3']) === null);
check('同一花色(全红桃,不连续)',
    t(['红桃4', '红桃9', '红桃10', '红桃K', '红桃6'])?.type === PatternType.SAME_SUIT);
// 回归：方块+红桃混着（红黑都有但花色不统一）绝不能算同一花色
check('方块红桃混凑不算同一花色',
    t(['方块4', '红桃9', '方块10', '方块K', '红桃6'])?.type !== PatternType.SAME_SUIT);
check('一条龙(同色且连续)',
    t(['红桃4', '红桃5', '红桃6', '红桃7', '红桃8'])?.type === PatternType.DRAGON);
check('4带1', t(['方块8', '梅花8', '红桃8', '黑桃8', '方块K'])?.type === PatternType.FOUR_ONE);
check('杂牌 5 张非法', t(['方块4', '梅花8', '红桃J', '黑桃K', '方块2']) === null);

console.log('\n===== 3. 大小比较 =====');
const cmp = (a: string[], b: string[]) => {
    const pa = parsePattern(cards(deck, a))!;
    const pb = parsePattern(cards(deck, b))!;
    return canBeat(pa, pb);
};
check('黑桃4 > 方块4（同点比花色）', cmp(['黑桃4'], ['方块4']));
check('方块5 > 黑桃4（比点数）', cmp(['方块5'], ['黑桃4']));
check('大王 > 小王', cmp(['大王'], ['小王']));
check('方块3 > 黑桃A', cmp(['方块3'], ['黑桃A']));
// 注意：同花色的 56789 会被识别为「一条龙」，这里用杂色才是纯顺子
check('顺子 56789 > 45678', cmp(['梅花5', '红桃6', '黑桃7', '方块8', '梅花9'],
    ['方块4', '梅花5', '红桃6', '黑桃7', '方块8']));
check('对子不能压单张', !cmp(['方块8', '红桃8'], ['方块4']));
check('王对能压任何对子(33)', cmp(['小王', '大王'], ['方块3', '梅花3']));
check('王对能压任何对子(AA)', cmp(['小王', '大王'], ['方块A', '梅花A']));
check('任何对子压不过王对', !cmp(['黑桃2', '方块2'], ['小王', '大王']));
check('王对不能压三张', !cmp(['小王', '大王'], ['方块8', '梅花8', '红桃8']));
check('王对不能压单张', !cmp(['小王', '大王'], ['黑桃3']));
check('顺子不能压对子', !cmp(['方块4', '梅花5', '红桃6', '黑桃7', '方块8'], ['方块8', '红桃8']));
check('三带二只比主牌(666+33 > 555+88)',
    cmp(['方块6', '梅花6', '红桃6', '方块3', '梅花3'], ['方块5', '梅花5', '红桃5', '方块8', '梅花8']));
check('4带1 只比主牌',
    cmp(['方块9', '梅花9', '红桃9', '黑桃9', '方块4'], ['方块8', '梅花8', '红桃8', '黑桃8', '大王']));

console.log('\n===== 3.5 五张牌型互相可吃 =====');
// 统一大小序：一条龙 > 4带1 > 三带二 > 顺子 > 同一花色
check('三带二 > 顺子',
    cmp(['方块8', '梅花8', '红桃8', '方块9', '红桃9'], ['方块4', '梅花5', '红桃6', '黑桃7', '方块8']));
check('顺子不能压三带二',
    !cmp(['方块4', '梅花5', '红桃6', '黑桃7', '方块8'], ['方块8', '梅花8', '红桃8', '方块9', '红桃9']));
check('4带1 > 三带二',
    cmp(['方块8', '梅花8', '红桃8', '黑桃8', '方块K'], ['方块5', '梅花5', '红桃5', '方块9', '梅花9']));
check('三带二不能压4带1',
    !cmp(['方块5', '梅花5', '红桃5', '方块9', '梅花9'], ['方块8', '梅花8', '红桃8', '黑桃8', '方块K']));
check('一条龙 > 4带1',
    cmp(['红桃4', '红桃5', '红桃6', '红桃7', '红桃8'], ['方块8', '梅花8', '红桃8', '黑桃8', '方块K']));
check('4带1不能压一条龙',
    !cmp(['方块8', '梅花8', '红桃8', '黑桃8', '方块K'], ['红桃4', '红桃5', '红桃6', '红桃7', '红桃8']));
check('顺子 > 同一花色',
    cmp(['梅花5', '红桃6', '黑桃7', '方块8', '梅花9'], ['红桃4', '红桃9', '红桃10', '红桃K', '红桃6']));
check('同一花色不能压顺子',
    !cmp(['红桃4', '红桃9', '红桃10', '红桃K', '红桃6'], ['梅花5', '红桃6', '黑桃7', '方块8', '梅花9']));
check('一条龙 > 同一花色',
    cmp(['红桃4', '红桃5', '红桃6', '红桃7', '红桃8'], ['梅花4', '梅花9', '梅花10', '梅花K', '梅花6']));
check('同一花色比花色: 红桃 > 方块',
    cmp(['红桃4', '红桃9', '红桃10', '红桃K', '红桃6'], ['方块4', '方块9', '方块10', '方块K', '方块6']));
check('同一花色同花色比最大牌: 方块56789 > 方块45678',
    cmp(['方块5', '方块6', '方块7', '方块8', '方块9'], ['方块4', '方块6', '方块7', '方块8', '方块5']));
// 鸡是 4 张，张数不同，5 张牌型不能压它
check('5张牌型不能压鸡(张数不同)',
    !cmp(['方块4', '梅花5', '红桃6', '黑桃7', '方块8'], ['方块8', '梅花8', '红桃8', '黑桃8']));

console.log('\n===== 4. 发牌规则 =====');
{
    const eng = new GameEngine({ humanSeat: 0, minRounds: 2 });
    eng.startRound();
    const counts = eng.players.map((p) => p.cards.length);
    const total = counts.reduce((a, b) => a + b, 0);
    check('发牌总数 54', total === 54, `实际 ${total}`);
    check('有两人 14 张、两人 13 张',
        counts.filter((c) => c === 14).length === 2 && counts.filter((c) => c === 13).length === 2,
        counts.join(','));
    const enemy = eng.players[eng.enemySeat];
    check('敌人持有方块4', enemy.cards.some((c) => c.id === 1));
    check('敌人唯一', eng.players.filter((p) => p.isEnemy).length === 1);
    const first = eng.players.findIndex((p) => p.cards.some((c) => c.id === 2));
    check('首局由持梅花4者先出', eng.currentSeat === first, `current=${eng.currentSeat} club4=${first}`);
}

console.log('\n===== 5. 完整对局模拟（4 个 AI 自动打） =====');
{
    let roundsFinished = 0;
    let stuck = false;
    const eng = new GameEngine({ humanSeat: 0, minRounds: 2 });

    for (let r = 1; r <= 3; r++) {
        eng.startRound();
        // 交牌阶段全部交给 AI 自动完成（真人步骤用系统建议推过去）
        let guard = 0;
        while (eng.phase === Phase.EXCHANGE && guard++ < 200) {
            if (!eng.advanceExchange()) {
                const ids = eng.pendingGiveCards().map((c) => c.id);
                const accepted = eng.submitExchange(ids.length ? ids : -1);
                if (!accepted) {
                    console.log(`  [FAIL] 第${r}局 交牌步骤被拒 kind=${eng.currentExchange?.kind}`);
                    stuck = true;
                    break;
                }
            }
        }
        if (stuck) break;

        let steps = 0;
        while (eng.phase === Phase.PLAYING && steps++ < 4000) {
            const seat = eng.currentSeat;
            const act = eng.aiAction();
            if (act.action === 'play' && act.cards && act.cards.length > 0) {
                const ok = eng.playCards(seat, act.cards);
                if (!ok) { console.log(`  [FAIL] 第${r}局 AI 出牌被拒 seat=${seat}`); stuck = true; break; }
            } else {
                const ok = eng.pass(seat);
                if (!ok) { console.log(`  [FAIL] 第${r}局 AI 跳过被拒 seat=${seat} last=${eng.lastPattern}`); stuck = true; break; }
            }
        }
        if (steps >= 4000) { stuck = true; console.log(`  [FAIL] 第${r}局疑似死循环`); break; }
        if (eng.phase !== Phase.ROUND_END) { console.log(`  [FAIL] 第${r}局未正常结束 phase=${eng.phase}`); break; }

        roundsFinished++;
        const res = eng.lastResult!;
        const alive = eng.players.filter((p) => !p.finished).length;
        console.log(`  第${r}局: 敌人=座${res.enemySeat} ${res.enemyWin ? '敌人赢' : '乌龟方赢'} ` +
            `出完顺序=[${res.finishOrder.join(',')}] 名次=${JSON.stringify(res.rankNames)}`);
        check(`第${r}局有人出完牌`, res.finishOrder.length > 0);
        check(`第${r}局胜负自洽`, res.enemyWin
            ? eng.players[res.enemySeat].finished
            : eng.players.filter((p) => !p.isEnemy).every((p) => p.finished));
    }

    check('完成 3 局无死循环', roundsFinished === 3 && !stuck);
    check('局数计数正确', eng.roundNo === 3);
    check('打够 2 局后可结束', eng.canEndGame());
    check('历史记录完整', eng.history.length === 3);
}

console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====\n`);
if (fail > 0) throw new Error(`规则测试失败 ${fail} 项`);
