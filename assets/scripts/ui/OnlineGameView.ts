/**
 * 乌龟4 —— 联机牌局界面（纯消息驱动）
 *
 * 与单机 GameScene 的本质区别：
 *   - 本地不跑 GameEngine，一切以服务器消息为准（服务器权威，防作弊）；
 *   - 自己的手牌来自私密消息 hand，别人只剩「张数」；
 *   - 出牌/跳过/交牌都只是发 act 消息，能不能做由服务器判定，
 *     被拒绝时服务器回 error，界面飘字提示即可。
 *
 * 进入方式：GameScene.onLoad 检测到 NetClient 已连接时，自动把本组件挂到
 * 同一个节点上并销毁自己——所以不需要新场景，game 场景一条进两条出。
 *
 * 座位显示约定：无论服务器分给你几号位，界面上「自己永远在下方」，
 * 其余三家按 (服务器座位 - 我的座位 + 4) % 4 旋转到 右/上/左。
 */

import { Card, createDeck, sortCards, sortCardsDesc } from '../core/Card';
import { decideRevealLead, decidePlay } from '../core/AI';
import { parsePattern, Pattern } from '../core/Pattern';
import {
    createCardNode, createLabel, createButton, createPanel, createMultiline,
    setButtonText, CARD_W, CARD_H,
} from './CardView';
import { NetClient, ServerMsg } from '../net/NetClient';

const { ccclass } = cc._decorator;

const W = 1280;
const H = 720;

/** 显示座位锚点：0 自己（下） 1 右家 2 对家 3 左家 —— 方位固定，只由「我」这个座位锚定 */
const SEAT_ANCHOR = [
    cc.v2(0, -H / 2 + 96),
    cc.v2(W / 2 - 118, 10),
    cc.v2(0, H / 2 - 96),
    cc.v2(-W / 2 + 118, 10),
];
/** 显示座位名（相对自己）：自己永远在下 */
const SEAT_NAME = ['我', '右家', '对家', '左家'];

/** 每家出牌摆放位置（与 SEAT_ANCHOR 同向，靠近桌心） */
const PLAY_POS = [
    cc.v2(0, -112),
    cc.v2(316, 6),
    cc.v2(0, 118),
    cc.v2(-316, 6),
];

const TABLE_RX = 430;
const TABLE_RY = 190;
const TABLE_CARD_GAP = 74;
const TABLE_CARD_Y = 96;

/** 54 张牌的固定对照表：服务器只发 id，本地用它还原整张牌 */
const DECK: Map<number, Card> = (() => {
    const m = new Map<number, Card>();
    for (const c of createDeck()) m.set(c.id, c);
    return m;
})();

interface ExchangeTurn {
    kind: string;           // ENEMY_PUT / TOURIST_PICK / TOURIST_RETURN / LOSER_GIVE / LOSER_PICK / ENEMY_RETURN
    hint: string;
    count: number;
    tableCards: number[];
    rank?: number;          // 游客名次 1=导游 2=中游 3=尾游
    loserPickOrder?: number[];
}

/** 全场可见的「现在轮到谁交牌」 */
interface ExTurnInfo {
    seat: number;
    kind: string;
    count: number;
    rank: number;
}

/** 一条交牌记录（服务器广播，四家一起播动画） */
interface ExRecord {
    from: number;
    to: number;
    cardId: number;
    cardName: string;
    kind: string;
    index: number;
}

/**
 * 一条「正在飞」的牌：用真实墙钟驱动，四个网页/四台设备在同一时刻
 * 算出同一个进度 → 全局 4 人同时看到同一张牌在同一位置移动。
 * 轨迹：从交牌人手里直接慢慢飞到拿牌人手里（一对一无停顿）；
 * 只有 ENEMY_PUT / ENEMY_RETURN 落在台上等人挑。
 */
interface ExFly {
    rec: ExRecord;
    /** 这条移动开始播放的墙钟时刻（收到广播时取本地 Date.now，四家误差仅几十毫秒） */
    startAt: number;
    /** 动画总时长（秒） */
    total: number;
    /** 时间轴节点：浮现 / 起点停留（谁交出）/ 到达终点 */
    t0: number; t1: number; t2: number;
    rest: number; fade: number;
    fromPos: cc.Vec3; toPos: cc.Vec3;
    flyFrom: number; endScale: number;
    isBig: boolean; toTable: boolean;
    fromD: number; toD: number;
    /** 牌节点（切回前台时才按当前进度补建，后台不浪费） */
    node: cc.Node | null;
    /** 「收到」飘字是否已触发（避免切窗补齐时重复弹） */
    tipDone: boolean;
}

@ccclass
export default class OnlineGameView extends cc.Component {

    // ---- 连接状态 ----
    private net = NetClient.inst;
    private mySeat = 0;                 // 服务器座位号（roomOk 里下发）
    private members: any[] = [];
    private roomId = '';
    /** 已暴露的敌人座位（-1 = 还没暴露） */
    private revealedEnemy = -1;
    /** 自己的身份：开局时服务器私发给本人（敌人 = 自己持有方块4） */
    private iAmEnemy = false;
    /** 各家名次：1 导游 / 2 中游 / 3 尾游 / 0 未出完 */
    private ranks: number[] = [0, 0, 0, 0];

    // ---- 牌局状态 ----
    private myHand: Card[] = [];
    private handCounts: number[] = [0, 0, 0, 0];   // 服务器座位序的张数
    private phase = '';
    private lastPlaySeat = -1;          // 服务器座位序
    private turnPlay: { mustLead: boolean } | null = null;
    /** 已点「出牌」等服务器回执（防止连点，也用于被拒绝后恢复按钮） */
    private pendingPlay = false;
    /** 交牌提交锁（与单机版 exchangeLock 同义） */
    private exchangeLock = false;
    /** 上一手的牌型（用于「提示」判断），null = 自己领出 */
    private lastPatternObj: Pattern | null = null;
    private turnEx: ExchangeTurn | null = null;

    // ---- 交牌过程（全场可见，与单机版一致） ----
    /** 当前轮到谁交牌（包括别人）——用于显示「导游正在选牌…」 */
    private exTurn: ExTurnInfo | null = null;
    /** 桌面牌（服务器权威下发，无论轮不轮到我都要显示） */
    private tableCardIds: number[] = [];
    /**
     * 在途飞牌表：按「真实墙钟时刻」驱动（与发牌 dealTick 同一套思路）。
     * 四家在同一广播时刻算出同一进度 → 全局 4 人同时看到牌在同一位置移动；
     * 后台网页也保留记录，切回前台按当前进度补齐（还在飞就继续看，已飞完就只看结果，
     * 绝不从头重播）。同一批 N 张只错开 0.4s 几乎同时起飞。
     */
    private exActive: Map<number, ExFly> = new Map();
    /** 是否有飞牌动画正在进行（桌面/手牌刷新与按钮门控都看它） */
    private exFlying = false;
    /** 同一批多张牌的错峰起飞时刻（墙钟 ms） */
    private exNextStart = 0;
    /** 交牌动画播放进度（已播到第几条 index） */
    private exPlayed = 0;
    /** exTick 是否已挂在调度器上 */
    private exTickOn = false;
    /**
     * 飞牌动画期间服务器下发的新手牌：先缓存不渲染。
     * 否则牌还没飞过去，手牌就先变好了，看起来像「系统自动帮我们换完了」。
     * 等队列播完、牌落定再一次性翻牌。
     */
    private pendingHand: Card[] | null = null;
    /** 交牌提示条节点 */
    private nodeExBanner: cc.Node = null!;
    /** 是否已播过发牌动画（每局一次） */
    private dealAnimDone = false;
    /** 「再来一局」我是否已投票 / 当前投票数 */
    private votedNext = false;
    private nextVoteCount = 0;
    /** 结算面板上的投票进度文字 */
    private lblNextVote: cc.Label = null!;

    // ---- 选择状态 ----
    private selected: Set<number> = new Set();
    private tableSelId = -1;

    // ---- 层与控件 ----
    private layerBg: cc.Node = null!;
    private layerTable: cc.Node = null!;
    private layerOpp: cc.Node = null!;
    private layerHand: cc.Node = null!;
    private layerSeat: cc.Node = null!;
    private layerUi: cc.Node = null!;
    private layerPop: cc.Node = null!;
    /** 全局飞牌层：zIndex 高于手牌/座位/UI，保证 4 个视角都看得见牌在飞，不被遮挡 */
    private layerFly: cc.Node = null!;
    private nodeTableCards: cc.Node = null!;

    private lblRound: cc.Label = null!;
    private lblStatus: cc.Label = null!;
    private lblHint: cc.Label = null!;
    private lblMyCount: cc.Label = null!;
    private btnPlay: cc.Node = null!;
    private btnPass: cc.Node = null!;
    private btnHint: cc.Node = null!;
    private btnExSubmit: cc.Node = null!;
    private roundNo = 0;

    // ---- 倒计时 ----
    /** 当前倒计时所属的服务器座位（-1 无） */
    private timerSeat = -1;
    /** 截止时间（本机时间轴换算，见 onTimer） */
    private timerDeadline = 0;
    private timerTotal = 20;
    private nodeTimer: cc.Node = null!;
    private lblTimer: cc.Label = null!;
    private timerGfx: cc.Graphics = null!;

    // ================= 生命周期 =================

    onLoad(): void {
        cc.view.resizeWithBrowserSize(true);
        cc.view.setDesignResolutionSize(W, H, cc.ResolutionPolicy.SHOW_ALL);
        this.buildUI();

        // 菜单阶段就已经知道自己的座位号（roomOk），先带上；
        // 之后快照/起局消息里如果带 seat 再覆盖
        this.mySeat = this.net.mySeat >= 0 ? this.net.mySeat : 0;

        // 消息接管
        this.net.onMsg = (m: ServerMsg) => this.onServerMsg(m);
        this.net.onClosed = () => this.showDisconnected();
        // 断线自动重连：手机上切后台、锁屏、地铁断网都会走这里，重连成功会自动 sync 恢复牌局
        this.net.onReconnecting = (tries: number) => {
            this.flash(`网络不稳，正在重连（${tries}/5）…`, 3);
        };

        // 后台标签页 rAF 会暂停。飞牌与发牌都用「真实墙钟」驱动：
        // 切回前台时按当前时刻补齐进度——还在飞的牌显示在它此刻该在的位置并继续飞完，
        // 已经飞完的直接落定（不从头重播）。这样四台设备同一时刻看到同一次移动。
        try {
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden) return;
                    if (this.dealing) this.dealTick();
                    if (this.exActive.size) this.exTick();   // 按当前墙钟补齐飞牌进度
                    if (this.pendingHand && !this.exFlying) {
                        this.myHand = this.pendingHand;
                        this.pendingHand = null;
                    }
                    this.refreshExchangeTable();
                    this.renderHand(false);
                    this.renderOpponents();
                    this.refreshStatus();
                });
            }
        } catch (e) { /* ignore */ }

        // 进场先向服务器要一份快照：
        //  1) 解决场景切换间隙丢消息（菜单收到 roundStart 才切场景，发牌消息赶不上）；
        //  2) 断线重连时恢复牌局也走同一条路。
        this.net.sync();

        this.refreshLobby('已进入联机牌局，等待开局…');
    }

    onDestroy(): void {
        if (this.net.onMsg) this.net.onMsg = null;
    }

    /** 服务器座位 → 显示座位 */
    private disp(serverSeat: number): number {
        return (serverSeat - this.mySeat + 4) % 4;
    }

    private nameOf(serverSeat: number): string {
        const d = this.disp(serverSeat);
        if (d === 0) return '你';
        const m = this.members[serverSeat];
        return m && m.nickname ? m.nickname : SEAT_NAME[d];
    }

    // ================= 消息分发 =================

    private onServerMsg(m: ServerMsg): void {
        try {
            switch (m.t) {
                case 'roomOk':
                    this.mySeat = m.seat;
                    this.roomId = m.roomId;
                    this.members = m.members || [];
                    this.showRoomPanel();
                    break;
                case 'memberUpdate':
                    this.members = m.members || [];
                    this.showRoomPanel();
                    break;
                case 'readyCount':
                    this.updateReadyCount(m.ready, m.need);
                    break;
                case 'dealDone':
                    // 服务器发牌动画时间到：后台标签页动画被暂停的，到点强制翻牌对齐
                    this.finishDealNow();
                    break;
                case 'roundStart':
                    this.roundNo = m.roundNo;
                    if (typeof m.seat === 'number') this.mySeat = m.seat;   // 快照恢复时校准座位
                    this.revealedEnemy = -1;                                 // 新一局重新隐藏敌人
                    this.ranks = [0, 0, 0, 0];
                    this.members = m.members || this.members;
                    if (m.handCounts) this.handCounts = m.handCounts;
                    // 自己的身份：手上有没有方块4（私发字段，别人拿不到）
                    this.iAmEnemy = !!m.iAmEnemy;
                    this.onRoundStart();
                    break;
                case 'identity':
                    // 服务器私发：你是不是敌人
                    this.iAmEnemy = !!m.isEnemy;
                    this.renderSeats();
                    break;
                case 'enemyRevealed':
                    // 敌人（方块4 持有者）第一次出牌，身份公开
                    this.revealedEnemy = m.seat;
                    this.renderSeats();
                    this.flash(`${this.nameOf(m.seat)} 是敌人！`, 3);
                    break;
                case 'timer':
                    // 服务器下发 deadline（服务器时间戳）。用它减去本机时钟会有时区/偏差问题，
                    // 所以改成「剩余秒数」本地倒推，四家看到的秒数一致、不会因本机时钟不准而错乱。
                    this.timerSeat = m.seat;
                    this.timerTotal = m.total || m.seconds || 20;
                    this.timerDeadline = cc.director.getTotalTime() / 1000 + (m.seconds || 0);
                    this.renderTimer();
                    break;
                case 'tip':
                    this.flash(m.msg || '', 2);
                    break;
                case 'hand': {
                    const hand = sortCards((m.cards || [])
                        .map((c: any) => {
                            const base = DECK.get(c.id);
                            if (!base) return null;
                            // 服务器权威下发「本局已换过」标记，客户端据此压暗/拦截
                            const copy: Card = Object.assign({}, base);
                            copy.exchanged = !!c.exchanged;
                            return copy;
                        })
                        .filter((c: Card | null): c is Card => !!c));
                    // 第一次拿到 13 张 = 刚开局 → 先播逐张发牌动画，发完再亮手牌
                    if (hand.length >= 13 && this.phase === 'DEAL' && !this.dealAnimDone) {
                        this.myHand = hand;
                        this.playDealAnim();
                        break;               // 动画结束后由 playDealAnim 统一渲染
                    }
                    // 交牌飞牌动画还在播：先缓存，牌飞到位后才翻牌
                    if (this.exFlying) {
                        this.pendingHand = hand;
                        break;
                    }
                    this.myHand = hand;
                    if (!this.dealing) {     // 发牌动画期间不提前亮牌
                        this.renderHand();
                        this.renderOpponents();
                    }
                    break;
                }
                case 'exTurn': {
                    // 全场广播：现在轮到谁交牌（不管是不是我）
                    this.exTurn = {
                        seat: m.seat, kind: m.kind, count: m.count || 1, rank: m.rank || 0,
                    };
                    this.tableCardIds = m.tableCards || [];
                    if (m.seat !== this.mySeat) {
                        // 别人在操作：自己的交牌界面收起来，只当观察者
                        this.turnEx = null;
                        this.selected.clear();
                        this.tableSelId = -1;
                    }
                    this.refreshExchangeTable();
                    this.refreshStatus();
                    break;
                }
                case 'ex': {
                    // 一条交牌记录：四家一起播飞牌动画
                    this.enqueueExchange({
                        from: m.from, to: m.to,
                        cardId: m.card.id, cardName: m.card.name,
                        kind: m.kind, index: m.index,
                    });
                    break;
                }
                case 'turn':
                    if (m.kind === 'PLAY') {
                        this.turnPlay = { mustLead: !!m.mustLead };
                        this.turnEx = null;
                        this.selected.clear();
                        this.tableSelId = -1;
                        // 用上一手的牌重建牌型，供「提示」使用
                        const lastCards: Card[] = (m.lastCards || [])
                            .map((id: number) => DECK.get(id))
                            .filter((c: Card | undefined): c is Card => !!c);
                        this.lastPatternObj = m.mustLead || !lastCards.length
                            ? null : parsePattern(lastCards);
                    } else {
                        // 换了一步交牌：旧的选择和提交锁都作废
                        const sameStep = !!this.turnEx && this.turnEx.kind === m.kind;
                        this.exchangeLock = false;
                        this.unschedule(this.releaseExchangeLock);
                        this.turnEx = {
                            kind: m.kind, hint: m.hint || '', count: m.count || 1,
                            tableCards: m.tableCards || [],
                            rank: m.rank || 0,
                            loserPickOrder: m.loserPickOrder || [],
                        };
                        this.exTurn = {
                            seat: this.mySeat, kind: m.kind, count: m.count || 1, rank: m.rank || 0,
                        };
                        this.tableCardIds = m.tableCards || [];
                        this.turnPlay = null;
                        this.selected.clear();
                        this.tableSelId = -1;
                        // 不自动交牌！和单机一样：玩家自己点牌，再点按钮提交。
                        // 同一步逐张交时只提示一次，别每张都弹
                        if (!sameStep) this.flash('轮到你交牌：先点牌，再点下方按钮', 2.2);
                    }
                    this.renderHand();
                    this.refreshExchangeTable();
                    this.refreshStatus();
                    break;
                case 'played': {
                    const seat: number = m.seat;
                    if (seat === this.mySeat) {
                        this.pendingPlay = false;
                        this.unschedule(this.restoreAfterPending);
                        this.turnPlay = null;
                        this.selected.clear();
                    }
                    if (m.pass) {
                        this.showSkip(seat);
                    } else {
                        const cards: Card[] = (m.cards || [])
                            .map((id: number) => DECK.get(id))
                            .filter((c: Card | undefined): c is Card => !!c);
                        if (seat === this.mySeat) {
                            const ids = new Set(cards.map((c) => c.id));
                            this.myHand = this.myHand.filter((c) => !ids.has(c.id));
                            this.renderHand();
                        }
                        // 张数以服务器随后下发的 state.handCounts 为准，这里不本地估算，
                        // 避免多个窗口的计数慢慢跑偏
                        this.showPlayed(seat, cards);
                    }
                    this.renderSeats();
                    break;
                }
                case 'state':
                    this.phase = m.phase;
                    if (Array.isArray(m.ranks)) this.ranks = m.ranks;
                    if (typeof m.enemySeat === 'number' && m.enemySeat >= 0) this.revealedEnemy = m.enemySeat;
                    // 桌面牌（交牌阶段全场显示）
                    if (Array.isArray(m.tableCards)) {
                        this.tableCardIds = m.tableCards;
                        // 飞牌动画还在播时不要抢着重建，等播完 refreshExchangeTable 会补上
                        if (!this.exFlying) this.refreshExchangeTable();
                    }
                    // 交牌结束 → 桌面清空、观察态收掉
                    if (m.phase !== 'EXCHANGE') {
                        this.exTurn = null;
                        if (m.phase === 'PLAYING') {
                            this.turnEx = null;
                            this.tableSelId = -1;
                            this.tableCardIds = [];
                            if (!this.exFlying) this.refreshExchangeTable();
                        }
                    }
                    // lastPlaySeat 由 played 消息维护；只有服务器明确说「没人领出」时才清零
                    if (typeof m.lastPlaySeat === 'number') {
                        if (m.lastPlaySeat < 0) {
                            this.lastPlaySeat = -1;
                            this.clearTableCards();
                        } else {
                            this.lastPlaySeat = m.lastPlaySeat;
                        }
                    }
                    if (m.handCounts) {
                        this.handCounts = m.handCounts;
                        if (!this.exFlying) this.renderOpponents();   // 飞牌中先不刷新张数
                    }
                    this.renderSeats();
                    this.refreshStatus();
                    break;
                case 'roundEnd':
                    this.phase = 'ROUND_END';
                    this.turnPlay = null;
                    this.turnEx = null;
                    this.votedNext = false;      // 新一轮投票
                    this.nextVoteCount = 0;
                    this.refreshStatus();
                    this.showResult(m.result);
                    break;
                case 'nextVote':
                    // 「再来一局」全员确认进度：4 人都点了服务器才发牌
                    this.nextVoteCount = m.count || 0;
                    if (this.lblNextVote && this.lblNextVote.isValid) {
                        this.lblNextVote.string = `已点「再来一局」：${m.count}/${m.need}`;
                    }
                    break;
                case 'roomClosed':
                    // 有人退出，房间解散：回到主菜单重新匹配（新一波从第 1 局开始）
                    this.flash(m.msg || '房间已解散', 3);
                    this.net.onMsg = null;
                    this.scheduleOnce(() => {
                        this.net.close();
                        this.backToMenu();
                    }, 1.2);
                    break;
                case 'loginOk':
                    this.net.userId = m.userId;
                    break;
                case 'error':
                    // 出牌/交牌被拒绝：提示原因并立刻恢复操作，绝不留在「卡住」状态
                    this.pendingPlay = false;
                    this.exchangeLock = false;
                    this.unschedule(this.restoreAfterPending);
                    this.unschedule(this.releaseExchangeLock);
                    this.flash(m.msg || '操作被拒绝', 2.5);
                    if (this.turnEx) this.refreshExchangeTable();
                    this.refreshStatus();
                    break;
                default:
                    break;
            }
        } catch (err) {
            cc.error('[乌龟4] 处理服务器消息出错: ' + m.t + ' :: ' + err);
        }
    }

    // ================= UI 构建 =================

    private buildUI(): void {
        this.layerBg = this.mkLayer('bg', 0);
        const bg = this.layerBg.addComponent(cc.Graphics);
        bg.rect(-W / 2, -H / 2, W, H);
        bg.fillColor = cc.color(24, 28, 26);
        bg.fill();
        bg.ellipse(0, 4, TABLE_RX + 26, TABLE_RY + 26);
        bg.fillColor = cc.color(96, 62, 32);
        bg.fill();
        bg.ellipse(0, 4, TABLE_RX, TABLE_RY);
        bg.fillColor = cc.color(26, 96, 64);
        bg.fill();

        this.layerTable = this.mkLayer('table', 10);
        this.nodeTableCards = this.mkLayer('ex_table', 14);
        this.layerOpp = this.mkLayer('opp', 20);
        this.layerSeat = this.mkLayer('seat', 26);
        this.layerHand = this.mkLayer('hand', 30);
        this.layerUi = this.mkLayer('ui', 40);
        this.layerPop = this.mkLayer('pop', 50);
        // 飞牌专用层：放在所有层之上。以前飞行牌画在 layerTable(10) 里，
        // 会被手牌(30)/UI(40) 盖住，导致只有交换两方附近看得见、其它家只剩文字条。
        this.layerFly = this.mkLayer('fly', 60);

        this.lblRound = this.mkText(this.layerUi, '联机牌局', 22, cc.color(255, 235, 160), -W / 2 + 24, H / 2 - 28, 'left');
        this.mkText(this.layerUi, '房间 ' + (this.net.roomId || '…'), 18, cc.color(170, 215, 185), -W / 2 + 24, H / 2 - 56, 'left');

        const btnBack = createButton('≡', {
            fill: cc.color(40, 52, 48), fontSize: 24, width: 52, height: 46,
        }, () => this.confirmExit());
        btnBack.parent = this.layerUi;
        btnBack.setPosition(-W / 2 + 52, H / 2 - 90);

        this.lblStatus = this.mkText(this.layerUi, '', 22, cc.Color.WHITE, 0, H / 2 - 30, 'center');
        this.lblHint = this.mkText(this.layerUi, '', 18, cc.color(255, 200, 120), 0, H / 2 - 62, 'center');
        this.lblMyCount = this.mkText(this.layerUi, '', 22, cc.color(255, 240, 190), 300, -H / 2 + 118, 'center');

        this.btnPlay = createButton('出牌', { fill: cc.color(214, 76, 52), fontSize: 26, width: 150, height: 58 }, () => this.onPlayClick());
        this.btnPlay.parent = this.layerUi;
        this.btnPlay.setPosition(-230, -H / 2 + 46);
        this.btnPlay.active = false;

        this.btnPass = createButton('跳过', { fill: cc.color(96, 100, 112), fontSize: 26, width: 150, height: 58 }, () => this.onPassClick());
        this.btnPass.parent = this.layerUi;
        this.btnPass.setPosition(-60, -H / 2 + 46);
        this.btnPass.active = false;

        // 提示：与单机版同一套 AI 决策（decidePlay），只帮你选中，不替你出牌
        this.btnHint = createButton('提示', { fill: cc.color(56, 120, 186), fontSize: 26, width: 150, height: 58 }, () => this.onHintClick());
        this.btnHint.parent = this.layerUi;
        this.btnHint.setPosition(110, -H / 2 + 46);
        this.btnHint.active = false;

        this.btnExSubmit = createButton('确定', { fill: cc.color(226, 150, 50), fontSize: 24, width: 170, height: 52 }, () => this.onExchangeSubmit());
        this.btnExSubmit.parent = this.layerUi;
        this.btnExSubmit.setPosition(-70, -H / 2 + 30);
        this.btnExSubmit.active = false;

        // ---- 倒计时圆环（挂到座位框上，按座位移动，见 renderTimer） ----
        this.nodeTimer = new cc.Node('timer');
        this.nodeTimer.parent = this.layerUi;
        this.nodeTimer.active = false;
        this.timerGfx = this.nodeTimer.addComponent(cc.Graphics);
        const tNode = createLabel('20', 22, cc.Color.WHITE, 0, 0);
        tNode.parent = this.nodeTimer;
        this.lblTimer = tNode.getComponent(cc.Label)!;
        this.lblTimer.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
    }

    private mkLayer(name: string, z: number): cc.Node {
        const n = new cc.Node(name);
        n.parent = this.node;
        n.zIndex = z;
        n.setContentSize(W, H);
        return n;
    }

    private mkText(parent: cc.Node, text: string, size: number, color: cc.Color,
        x: number, y: number, align: 'left' | 'center' | 'right'): cc.Label {
        const n = createLabel(text, size, color, x, y);
        n.parent = parent;
        n.setAnchorPoint(align === 'left' ? 0 : (align === 'right' ? 1 : 0.5), 0.5);
        const l = n.getComponent(cc.Label)!;
        l.horizontalAlign = align === 'left'
            ? cc.Label.HorizontalAlign.LEFT
            : (align === 'right' ? cc.Label.HorizontalAlign.RIGHT : cc.Label.HorizontalAlign.CENTER);
        return l;
    }

    // ================= 房间等待面板 =================

    private lobbyPanel: cc.Node | null = null;
    private readyLabel: cc.Node | null = null;
    private readyLabelComp: cc.Label | null = null;

    private refreshLobby(status: string): void {
        this.lblStatus.string = status;
    }

    private showRoomPanel(): void {
        if (this.lobbyPanel && this.lobbyPanel.isValid) this.lobbyPanel.destroy();
        const p = createPanel(640, 420, cc.color(12, 36, 27, 248), cc.color(220, 190, 100), 16);
        p.parent = this.layerPop;
        this.lobbyPanel = p;

        const title = createLabel(`房间 ${this.net.roomId} · 你坐 ${this.mySeat + 1} 号位`,
            26, cc.color(255, 226, 140), 0, 160);
        title.parent = p;

        // 成员列表
        const lines: string[] = [];
        for (const m of this.members) {
            if (m.empty) { lines.push(`□ ${SEAT_NAME[this.disp(m.seat)] === '你' ? '（你）' : ''}空位`); continue; }
            const me = m.seat === this.mySeat ? '（你）' : '';
            const ok = m.connected === false ? '（掉线）' : '';
            lines.push(`● ${m.nickname}${me}${ok}`);
        }
        const list = createMultiline(lines.join('\n') + (this.members.length < 4 ? '\n\n等待其他玩家加入…' : ''),
            20, cc.color(225, 240, 228), 0, 30, 560);
        list.parent = p;

        this.readyLabel = createLabel('', 20, cc.color(255, 210, 120), 0, -70);
        this.readyLabel.parent = p;
        this.readyLabelComp = this.readyLabel.getComponent(cc.Label) || null;

        const btnReady = createButton('准备', {
            fill: cc.color(56, 132, 96), fontSize: 24, width: 180, height: 56,
        }, () => {
            this.net.ready();
            setButtonText(btnReady, '已准备');
        });
        btnReady.parent = p;
        btnReady.setPosition(-110, -140);

        const btnLeave = createButton('退出房间', {
            fill: cc.color(140, 74, 62), fontSize: 22, width: 160, height: 56,
        }, () => this.leaveRoom());
        btnLeave.parent = p;
        btnLeave.setPosition(110, -140);
    }

    private updateReadyCount(ready: number, need: number): void {
        if (this.readyLabelComp && this.readyLabelComp.isValid) {
            this.readyLabelComp.string = `准备进度：${ready} / ${need}`;
        }
    }

    private leaveRoom(): void {
        this.net.close();
        this.backToMenu();
    }

    private onRoundStart(): void {
        if (this.lobbyPanel && this.lobbyPanel.isValid) this.lobbyPanel.destroy();
        this.lobbyPanel = null;
        this.clearPop();
        // 清掉上一局打出去的桌面出牌（一对2、梅花6之类残留），新一局桌面必须是空的
        this.lastPlaySeat = -1;
        this.clearTableCards();
        // 上一局没出完的手牌、对手牌背堆、残留选择也立刻清空：
        // 发牌期间画面上只应该有正在发的新牌，上一局的牌一张都不留
        this.myHand = [];
        this.handCounts = [0, 0, 0, 0];
        this.turnPlay = null;
        this.pendingPlay = false;
        this.selected.clear();
        this.tableSelId = -1;
        this.renderHand(false);
        this.renderOpponents();
        this.lblRound.string = `第 ${this.roundNo} 局`;
        this.phase = 'DEAL';
        this.dealAnimDone = false;
        this.dealing = false;
        this.dealStartAt = Date.now();      // 四家同一广播、本地时刻只差几十毫秒
        this.dealShown = 0;
        this.unschedule(this.dealTick);
        this.dealStacks = [[], [], [], []];
        // 新一局：清掉上一局残留的交牌状态
        this.exTurn = null;
        this.turnEx = null;
        this.tableCardIds = [];
        this.clearExFlies();
        this.pendingHand = null;
        this.exPlayed = 0;
        this.tableSig = '';
        this.refreshExchangeTable();
        this.refreshStatus();
        this.renderSeats();
        this.renderOpponents();
    }

    /** 发牌动画进行中（期间不显示手牌与对手张数） */
    private dealing = false;
    /** 开局时刻（本地墙钟）：四个网页据此对齐发牌进度 */
    private dealStartAt = 0;
    /** 已经落下的牌背张数 */
    private dealShown = 0;
    /** 各家面前已落下的牌背（发牌过程中逐张叠加） */
    private dealStacks: cc.Node[][] = [[], [], [], []];

    /** 服务器 dealDone 到达：立刻结束发牌动画并翻牌（后台标签页动画被暂停时的对齐兜底） */
    private finishDealNow(): void {
        if (!this.dealing) return;
        this.unschedule(this.dealTick);
        // 把剩余牌背补齐再收尾，切回前台看到的画面与其它网页一致
        this.dealShown = 52;
        this.finishDealShow(false);
    }

    /**
     * 发牌动画：52 张牌背逐张轮流飞到四家面前叠成一叠，发完翻开手牌。
     *
     * 同步关键：进度由「收到 roundStart 的本地时刻 + 真实墙钟」计算，
     * 而不是靠帧回调累加。四个网页同一时刻收到开局广播，看到的是同一进度；
     * 后台标签页帧被浏览器暂停时，切回前台会一次补齐到「现在应该发到第几张」，
     * 既不会从头重播一遍，也不会只有最后一个进房的网页才看得到发牌。
     */
    private playDealAnim(): void {
        if (this.dealAnimDone || this.dealing) return;
        this.dealAnimDone = true;
        this.dealing = true;
        this.dealShown = 0;
        if (!this.dealStartAt) this.dealStartAt = Date.now();
        this.unschedule(this.dealTick);
        this.schedule(this.dealTick, 0.03);
        this.dealTick();
    }

    /** 按真实时钟推进发牌进度（后台标签页切回来时批量补齐，不重播） */
    private dealTick = (): void => {
        if (!this.dealing) return;
        const per = 0.075;                                   // 每张间隔，52 张约 3.9 秒
        const elapsed = (Date.now() - this.dealStartAt) / 1000;
        const target = Math.max(0, Math.min(52, Math.floor(elapsed / per)));
        const catchingUp = target - this.dealShown > 3;      // 补齐：直接落位，不堆几十个飞行动画

        while (this.dealShown < target) {
            const i = this.dealShown++;
            const seat = i % 4;
            const idx = Math.floor(i / 4);
            const a = SEAT_ANCHOR[seat];
            const n = new cc.Node('dealt');
            const w = CARD_W * (seat === 0 ? 0.62 : 0.5);
            const h = CARD_H * (seat === 0 ? 0.62 : 0.5);
            const g = n.addComponent(cc.Graphics);
            g.roundRect(-w / 2, -h / 2, w, h, 5);
            g.fillColor = cc.color(242, 240, 230);
            g.fill();
            g.strokeColor = cc.color(160, 138, 84);
            g.lineWidth = 1.5;
            g.stroke();
            n.parent = this.layerTable;
            n.zIndex = 55;
            if (catchingUp) {
                n.scale = seat === 0 ? 0.9 : 0.7;
                n.opacity = 255;
                n.setPosition(a.x + idx * 1.6, a.y + idx * 0.7);
            } else {
                n.scale = 0.4;
                n.opacity = 0;
                n.setPosition(0, 0);
                cc.tween(n)
                    .to(0.09, { opacity: 255, scale: 0.8 })
                    .to(0.2, { position: cc.v3(a.x + idx * 1.6, a.y + idx * 0.7, 0), scale: seat === 0 ? 0.9 : 0.7 })
                    .start();
            }
            this.dealStacks[seat].push(n);
        }

        if (elapsed >= 52 * per + 0.35) {
            this.unschedule(this.dealTick);
            this.finishDealShow(true);
        }
    };

    /** 发完牌：牌背淡出 → 亮手牌（cascade 时手牌逐张翻开） */
    private finishDealShow(cascade: boolean): void {
        if (!this.dealing) return;
        for (let d = 0; d < 4; d++) {
            for (const n of this.dealStacks[d]) {
                cc.tween(n)
                    .delay(d === 0 ? 0 : 0.12)
                    .to(0.3, { opacity: 0 })
                    .call(() => { if (n && n.isValid) n.destroy(); })
                    .start();
            }
            this.dealStacks[d] = [];
        }
        this.dealing = false;
        this.renderHand(cascade);
        this.renderOpponents();
        if (this.phase === 'DEAL') {
            this.phase = 'EXCHANGE';
            this.refreshStatus();
        }
    }

    // ================= 渲染 =================

    /** 手牌第 i 张的位置（显示座位） */
    private handPos(seat: number, i: number, n: number): cc.Vec3 {
        const anchor = SEAT_ANCHOR[seat];
        if (seat === 0) {
            const gap = Math.min(46, 620 / Math.max(n, 1));
            const totalW = gap * (n - 1);
            return cc.v3(anchor.x - totalW / 2 + i * gap, anchor.y, 0);
        }
        const gap = Math.min(18, 190 / Math.max(n, 1));
        if (seat === 1 || seat === 3) {
            const totalH = gap * (n - 1);
            return cc.v3(anchor.x, anchor.y + totalH / 2 - i * gap, 0);
        }
        const totalW = gap * (n - 1);
        return cc.v3(anchor.x - totalW / 2 + i * gap, anchor.y, 0);
    }

    private renderHand(cascade = false): void {
        if (this.dealing) return;               // 发牌动画期间手牌还没「翻开」
        this.layerHand.removeAllChildren();
        const n = this.myHand.length;
        const canSelectHand = !!this.turnPlay
            || (!!this.turnEx && (this.turnEx.kind === 'ENEMY_PUT'
                || this.turnEx.kind === 'ENEMY_RETURN'
                || this.turnEx.kind === 'TOURIST_RETURN'
                || this.turnEx.kind === 'LOSER_GIVE'));

        // 被抓龟交大牌：只有最大那张是合法的，其它牌压暗（与单机一致，玩家自己点）
        // 敌人交大牌：只有最大的 N 张是合法的，其它牌压暗且点了没反应（与单机一致）
        let onlyId = -1;
        let legalIds: Set<number> | null = null;
        if (this.turnEx && this.turnEx.kind === 'LOSER_GIVE') {
            const big = this.exchangeable(false)[0];
            onlyId = big ? big.id : -1;
        }
        if (this.turnEx && this.turnEx.kind === 'ENEMY_PUT') {
            legalIds = new Set(this.exchangeable(false).slice(0, this.turnEx.count).map((c) => c.id));
        }

        for (let i = 0; i < n; i++) {
            const card = this.myHand[i];
            const node = createCardNode(card, true);
            node.parent = this.layerHand;
            const pos = this.handPos(0, i, n);
            const picked = this.selected.has(card.id);
            node.setPosition(pos.x, pos.y + (picked ? 24 : 0));

            // 交大牌/还小牌步骤：把建议的牌高亮，其它压暗
            if (this.turnEx && (this.turnEx.kind === 'ENEMY_PUT' || this.turnEx.kind === 'ENEMY_RETURN')) {
                node.opacity = picked ? 255 : 200;
            }
            // 敌人交大牌：非最大的 N 张明显压暗（与单机一致）
            if (legalIds && !legalIds.has(card.id)) node.opacity = 130;
            if (onlyId >= 0 && card.id !== onlyId) node.opacity = 150;

            if (cascade) {
                // 发牌动画结束：手牌逐张翻开
                node.opacity = 0;
                cc.tween(node).delay(i * 0.03).to(0.15, { opacity: node.opacity || 255 }).start();
            }

            node.on(cc.Node.EventType.TOUCH_END, () => {
                if (!canSelectHand) return;
                this.onHandTap(card);
            });
        }
    }

    private onHandTap(card: Card): void {
        const now = cc.director.getTotalTime() / 1000;
        if (now - this.lastTap < 0.15) return;
        this.lastTap = now;

        if (this.turnPlay) {
            if (this.selected.has(card.id)) this.selected.delete(card.id);
            else this.selected.add(card.id);
            this.renderHand();
            return;
        }
        if (!this.turnEx) return;
        if (this.exchangeLock) return;

        // 交牌阶段：方块4 是身份牌、本局已换过的牌都不许再交（与单机版一致）
        if (card.name === '方块4') {
            this.flash('方块4 是你的身份牌，不能交出去');
            return;
        }
        if (card.exchanged) {
            this.flash('这张牌本局已经换过了，不能再交一次');
            return;
        }

        if (this.turnEx.kind === 'ENEMY_PUT' || this.turnEx.kind === 'ENEMY_RETURN') {
            // 敌人交大牌：只能交最大的 N 张（与人机模式同一套算法），点其它牌只提示不动
            if (this.turnEx.kind === 'ENEMY_PUT') {
                const legal = this.exchangeable(false).slice(0, this.turnEx.count).map((c) => c.id);
                if (legal.indexOf(card.id) < 0) {
                    this.flash(`要交的是最大的 ${this.turnEx.count} 张大牌（已压暗的牌不能交）`);
                    return;
                }
            }
            if (this.selected.has(card.id)) { this.selected.delete(card.id); this.renderHand(); this.refreshStatus(); return; }
            if (this.selected.size >= this.turnEx.count) {
                this.flash(this.turnEx.kind === 'ENEMY_PUT'
                    ? `最多只能选 ${this.turnEx.count} 张（每位游客拿走一张）`
                    : `最多只能选 ${this.turnEx.count} 张（每只被抓龟挑一张）`);
                return;
            }
            this.selected.add(card.id);
            this.renderHand();
            this.refreshStatus();
            return;
        }
        if (this.turnEx.kind === 'LOSER_GIVE') {
            const big = this.exchangeable(false)[0];
            if (big && card.id !== big.id) {
                this.flash(`被抓龟要交最大的一张（${big.name}）`);
                return;
            }
        }
        if (this.turnEx.kind === 'TOURIST_RETURN' || this.turnEx.kind === 'LOSER_GIVE') {
            this.selected.clear();
            this.selected.add(card.id);
            this.renderHand();
            this.refreshStatus();
        }
    }

    private lastTap = 0;

    /**
     * 手上「可交的牌」：排除方块4（身份牌）与本局已交换过的牌。
     * 与单机 GameEngine.exchangeableCards 完全一致，避免选了不能交的牌被服务器拒绝。
     */
    private exchangeable(asc: boolean): Card[] {
        const list = this.myHand.filter((c) => !c.exchanged && c.name !== '方块4');
        return (asc ? sortCards(list) : sortCardsDesc(list));
    }

    // ================= 倒计时显示 =================

    /** 倒计时圆环摆到「当前行动者」的座位框旁边，全场四家都能看到 */
    private renderTimer(): void {
        if (!this.nodeTimer) return;
        if (this.timerSeat < 0) { this.nodeTimer.active = false; return; }

        const d = this.disp(this.timerSeat);
        const a = SEAT_ANCHOR[d];
        let x = a.x;
        let y = a.y;
        if (d === 0) { x = -400 + 128; y = -H / 2 + 150; }
        else if (d === 1) { x = a.x - 30 + 128; y = -150; }
        else if (d === 2) { x = 128; y = H / 2 - 130; }
        else { x = a.x + 30 - 128; y = -150; }

        this.nodeTimer.active = true;
        this.nodeTimer.setPosition(x, y);
        this.paintTimer();
    }

    private paintTimer(): void {
        if (!this.nodeTimer || !this.nodeTimer.active) return;
        const left = Math.max(0, this.timerDeadline - cc.director.getTotalTime() / 1000);
        const sec = Math.ceil(left);
        this.lblTimer.string = String(sec);

        // 最后 5 秒变红 + 数字放大，提醒该出牌了
        const urgent = sec <= 5;
        this.lblTimer.node.color = urgent ? cc.color(255, 96, 76) : cc.Color.WHITE;
        this.lblTimer.node.scale = urgent ? 1.15 : 1;

        const r = 20;
        const g = this.timerGfx;
        g.clear();
        // 底环
        g.circle(0, 0, r);
        g.fillColor = cc.color(10, 24, 18, 220);
        g.fill();
        // 进度弧（顺时针减少）
        const ratio = this.timerTotal > 0 ? Math.max(0, Math.min(1, left / this.timerTotal)) : 0;
        g.lineWidth = 4;
        g.strokeColor = urgent ? cc.color(255, 96, 76) : cc.color(120, 210, 160);
        g.arc(0, 0, r - 2, Math.PI / 2, Math.PI / 2 - Math.PI * 2 * ratio, true);
        g.stroke();
    }

    update(): void {
        if (!this.nodeTimer || !this.nodeTimer.active) return;
        this.paintTimer();
        if (this.timerDeadline - cc.director.getTotalTime() / 1000 < -1) {
            this.timerSeat = -1;
            this.nodeTimer.active = false;
        }
    }

    private stopTimer(): void {
        this.timerSeat = -1;
        if (this.nodeTimer) this.nodeTimer.active = false;
    }

    private renderOpponents(): void {
        if (this.dealing) return;               // 发牌动画期间以逐张落牌为准
        this.layerOpp.removeAllChildren();
        for (let s = 0; s < 4; s++) {
            const d = this.disp(s);
            if (d === 0) continue;
            const n = this.handCounts[s] || 0;
            for (let i = 0; i < n; i++) {
                const node = createCardNode(null, false);
                node.parent = this.layerOpp;
                node.scale = 0.55;
                const pos = this.handPos(d, i, n);
                node.setPosition(pos.x, pos.y);
            }
        }
    }

    /**
     * 圆形头像：按性别配色（男 蓝 / 女 粉 / 未知 灰），中间显示昵称首字。
     * 纯代码绘制，不需要美术素材；微信头像 URL 后续接入后可直接换成图片。
     */
    private createAvatar(parent: cc.Node, nickname: string, gender: number, x: number, y: number, r = 24): void {
        const n = new cc.Node('avatar');
        n.parent = parent;
        n.setPosition(x, y);
        n.zIndex = 1;

        const g = n.addComponent(cc.Graphics);
        const fill = gender === 1 ? cc.color(64, 118, 200)
            : gender === 2 ? cc.color(206, 96, 140)
                : cc.color(96, 108, 102);
        g.circle(0, 0, r);
        g.fillColor = fill;
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = cc.color(255, 235, 170);
        g.stroke();

        const ch = nickname ? nickname.charAt(0) : '?';
        const l = createLabel(ch, Math.round(r * 1.1), cc.Color.WHITE, 0, 0);
        l.parent = n;
        l.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        // 性别符号（右下角小徽章）
        if (gender === 1 || gender === 2) {
            const badge = createLabel(gender === 1 ? '♂' : '♀', 16, cc.Color.WHITE, r * 0.72, -r * 0.72);
            badge.parent = n;
        }
    }

    /**
     * 身份角标文字（显示在头像旁边）：
     *   - 自己：永远知道自己是敌人（iAmEnemy）
     *   - 别人：只有敌人已经出过牌（revealedEnemy）才标「敌人」
     *   - 名次：先出完牌的乌龟依次是 导游 / 中游 / 尾游
     */
    private roleTagOf(serverSeat: number): { text: string; color: cc.Color } | null {
        const isEnemy = serverSeat === this.mySeat ? this.iAmEnemy : this.revealedEnemy === serverSeat;
        if (isEnemy) return { text: '敌人', color: cc.color(255, 120, 90) };

        const r = this.ranks[serverSeat] || 0;
        if (r === 1) return { text: '导游', color: cc.color(255, 220, 110) };
        if (r === 2) return { text: '中游', color: cc.color(150, 220, 180) };
        if (r === 3) return { text: '尾游', color: cc.color(180, 190, 230) };
        return null;
    }

    /** 每家信息框：圆头像 + 昵称 + 剩余张数 + 身份角标 + 轮到谁的高亮 */
    private renderSeats(): void {
        this.layerSeat.removeAllChildren();

        for (let s = 0; s < 4; s++) {
            const d = this.disp(s);
            const a = SEAT_ANCHOR[d];

            let bx = a.x;
            let by = a.y;
            if (d === 0) { bx = -400; by = -H / 2 + 150; }
            else if (d === 1) { bx = a.x - 30; by = -150; }
            else if (d === 2) { bx = 0; by = H / 2 - 130; }
            else { bx = a.x + 30; by = -150; }

            const box = new cc.Node('seat' + s);
            box.parent = this.layerSeat;
            box.setPosition(bx, by);

            const isTurn = (this.phase === 'PLAYING' && s === 0 && !!this.turnPlay)
                || ((this.phase === 'EXCHANGE' || !!this.turnEx) && s === 0 && !!this.turnEx);
            const tag = this.roleTagOf(s);
            const isEnemyTag = !!tag && tag.text === '敌人';

            const boxW = 176;
            const boxH = 58;
            const g = box.addComponent(cc.Graphics);
            g.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, 12);
            g.fillColor = isEnemyTag ? cc.color(120, 46, 38, 240)
                : isTurn ? cc.color(70, 132, 92, 235)
                    : cc.color(12, 30, 24, 200);
            g.fill();
            g.strokeColor = isEnemyTag ? cc.color(255, 120, 90)
                : isTurn ? cc.color(255, 220, 120) : cc.color(70, 110, 92);
            g.lineWidth = isEnemyTag || isTurn ? 3 : 1;
            g.stroke();

            const m = this.members[s];
            const nm = m && m.nickname ? m.nickname : SEAT_NAME[d];
            const gender = m && typeof m.gender === 'number' ? m.gender : 0;
            this.createAvatar(box, nm, gender, -boxW / 2 + 32, 0);

            const left = s === this.mySeat ? this.myHand.length : (this.handCounts[s] || 0);
            const info = createLabel(`${nm}\n${left}张`, 15, cc.color(230, 240, 228), -boxW / 2 + 62, 0);
            info.parent = box;
            info.setAnchorPoint(0, 0.5);
            info.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.LEFT;
            info.getComponent(cc.Label)!.lineHeight = 20;

            // 身份角标：贴在头像右上角
            if (tag) {
                this.createRoleBadge(box, tag.text, tag.color, -boxW / 2 + 44, boxH / 2 - 8);
            }
        }
    }

    /** 头像旁的斜角小标签（敌人 / 导游 / 中游 / 尾游） */
    private createRoleBadge(parent: cc.Node, text: string, color: cc.Color, x: number, y: number): void {
        const n = new cc.Node('role');
        n.parent = parent;
        n.setPosition(x, y);
        n.zIndex = 3;

        const w = text.length * 15 + 12;
        const h = 20;
        const g = n.addComponent(cc.Graphics);
        g.roundRect(-w / 2, -h / 2, w, h, 6);
        g.fillColor = cc.color(16, 22, 18, 240);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = color;
        g.stroke();

        const l = createLabel(text, 14, color, 0, 0);
        l.parent = n;
        l.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
    }

    private refreshStatus(): void {
        let t = '';
        let hint = '';

        if (this.phase === 'PLAYING') {
            // 交牌阶段已结束：交牌按钮必须收掉，否则挡住「跳过」
            this.show(this.btnExSubmit, false);
            if (this.turnPlay) {
                t = '轮到你出牌';
                hint = this.turnPlay.mustLead ? '本轮由你领出，任意出牌' : '跟牌：选一手能压过上家的牌';
                this.show(this.btnPlay, true);
                this.show(this.btnPass, !this.turnPlay.mustLead);
                this.show(this.btnHint, true);
            } else {
                t = '等待其他玩家出牌…';
                hint = '';
                this.show(this.btnPlay, false);
                this.show(this.btnPass, false);
                this.show(this.btnHint, false);
            }
        } else if (this.phase === 'EXCHANGE' || this.turnEx || this.exTurn) {
            const isMine = !!this.turnEx;
            const animating = this.exFlying;
            if (isMine && animating) {
                // 轮到我了，但上一步的飞牌动画还没播完：先不亮按钮，播完再出现
                t = '开局交牌 · 轮到你';
                hint = '正在播放刚才的交换过程…';
                this.show(this.btnExSubmit, false);
            } else if (isMine) {
                t = '开局交牌 · 轮到你';
                hint = this.exchangeHintText(this.turnEx!.kind);
                this.show(this.btnExSubmit, true);
                this.updateExSubmitLabel();
            } else if (this.exTurn) {
                // 观察者：清楚说出谁正在做什么，别让玩家以为界面卡住
                t = '开局交牌 · 等待中';
                hint = this.observeText(this.exTurn);
                this.show(this.btnExSubmit, false);
            } else {
                t = '开局交牌';
                hint = '正在准备交换…';
                this.show(this.btnExSubmit, false);
            }
            this.show(this.btnPlay, false);
            this.show(this.btnPass, false);
            this.show(this.btnHint, false);
        } else if (this.phase === 'ROUND_END') {
            t = '本局结束';
            this.show(this.btnPlay, false);
            this.show(this.btnPass, false);
            this.show(this.btnHint, false);
            this.show(this.btnExSubmit, false);
            this.stopTimer();
        } else if (this.phase === 'DEAL') {
            t = '发牌中…';
            this.show(this.btnExSubmit, false);
        } else {
            t = '';
        }

        if (this.hintOverride) hint = this.hintOverride;
        this.lblStatus.string = t;
        this.lblHint.string = hint;
        this.lblMyCount.string = `剩 ${this.myHand.length} 张`;
    }

    private hintOverride = '';

    /** 观察者视角：别人正在交牌时，告诉全场「他在做什么」 */
    private observeText(info: ExTurnInfo): string {
        const who = this.nameOf2(info.seat);
        const rankWord = info.rank === 1 ? '导游' : info.rank === 2 ? '中游' : info.rank === 3 ? '尾游' : '';
        const tag = rankWord ? `（${rankWord}）` : '';
        switch (info.kind) {
            case 'ENEMY_PUT': return `${who} 正在挑最大的 ${info.count} 张摆到桌上…`;
            case 'TOURIST_PICK': return `${who}${tag} 正在从桌上挑一张大牌…`;
            case 'TOURIST_RETURN': return `${who}${tag} 正在挑一张牌还给敌人…`;
            case 'LOSER_GIVE': return `${who} 正在把最大的一张交给敌人…`;
            case 'ENEMY_RETURN': return `${who} 正在挑 ${info.count} 张小牌摆到桌上…`;
            case 'LOSER_PICK': return `${who} 正在从桌上挑一张小牌…`;
            default: return `${who} 正在交牌…`;
        }
    }

    private exchangeHintText(kind: string): string {
        const c = this.turnEx ? this.turnEx.count : 1;
        switch (kind) {
            case 'ENEMY_PUT': return `你是敌人：点选最大的 ${c} 张，再点「交到桌上」，牌才飞到桌上`;
            case 'TOURIST_PICK': return `点桌上想要的那张大牌 → 点「拿牌」，牌才回到你手上`;
            case 'TOURIST_RETURN': return `点 1 张手上的牌 → 点「交出去」，牌才还给敌人（方块4 不能还）`;
            case 'LOSER_GIVE': return `你是被抓龟：点手上最大的那张（其它牌已压暗）→ 点「交出去」`;
            case 'LOSER_PICK': return `点桌上想要的那张小牌 → 点「拿牌」，牌才回到你手上`;
            case 'ENEMY_RETURN': return `你是敌人：点选 ${c} 张小牌，再点「还牌」，牌才摆到桌上`;
            default: return '请按提示操作';
        }
    }

    private updateExSubmitLabel(): void {
        if (!this.turnEx) return;
        const k = this.turnEx.kind;
        if (k === 'ENEMY_PUT') {
            setButtonText(this.btnExSubmit,
                this.selected.size > 0 ? `交到桌上(${this.selected.size}/${this.turnEx.count})` : '交到桌上');
        } else if (k === 'ENEMY_RETURN') {
            setButtonText(this.btnExSubmit,
                this.selected.size > 0 ? `还牌(${this.selected.size}/${this.turnEx.count})` : '还牌');
        } else if (k === 'TOURIST_PICK' || k === 'LOSER_PICK') {
            setButtonText(this.btnExSubmit, '拿牌');
        } else if (k === 'LOSER_GIVE') {
            setButtonText(this.btnExSubmit, '交出去');
        } else {
            setButtonText(this.btnExSubmit, '交出去');
        }
    }

    // ============ 交牌飞牌动画：全局 4 家同时可见，真实墙钟驱动 ============

    private lerp(a: number, b: number, p: number): number { return a + (b - a) * p; }

    /** 带拱起的弧线插值，让「移动过程」有清楚的飞行轨迹 */
    private arcPoint(a: cc.Vec3, b: cc.Vec3, lift: number, p: number): cc.Vec3 {
        return cc.v3(
            this.lerp(a.x, b.x, p),
            this.lerp(a.y, b.y, p) + Math.sin(Math.PI * p) * lift,
            0,
        );
    }

    /**
     * 收到一条交牌记录：登记为「按真实墙钟播放」的飞牌。
     * 四家在同一广播时刻取到各自的 Date.now（局域网误差几十毫秒），
     * exTick 每帧按 Date.now() - startAt 算进度 → 全局 4 人在同一时刻
     * 看到同一张牌在同一位置移动（不是只有交换双方看得到，也不是只有文字条）。
     * 后台网页同样登记，切回前台按当前进度补齐：还在飞就接着看，已飞完直接落定，
     * 绝不从头重播。同一批 N 张只错开 0.4s 几乎同时起飞。
     */
    private enqueueExchange(rec: ExRecord): void {
        if (rec.index < this.exPlayed) return;      // 重连时补发的旧记录，跳过
        this.exPlayed = Math.max(this.exPlayed, rec.index + 1);
        if (!DECK.get(rec.cardId)) { this.refreshExchangeTable(); this.refreshStatus(); return; }

        const now = Date.now();
        const startAt = Math.max(now, this.exNextStart);
        this.exNextStart = startAt + 400;

        const f = this.makeExFly(rec, startAt);
        this.exActive.set(rec.index, f);
        this.exFlying = true;

        // 从台上拿牌（游客挑/被抓龟挑）：拿走的瞬间台上原位置那张必须立刻消失，
        // 否则飞行途中台上还留一份（双份显示）
        if (rec.from < 0) this.removeTableCard(rec.cardId);

        // 文字类提醒只在当前可见时创建，避免后台堆积一堆冻结的 tween
        if (!this.hiddenTab()) {
            this.showExBanner(rec, f.isBig);
            if (f.fromD >= 0 && !f.toTable) {
                this.popSeatTip(f.fromD, `交出 ${rec.cardName}`,
                    f.isBig ? cc.color(255, 214, 110) : cc.color(190, 210, 200), f.isBig ? 26 : 20);
            }
            if (f.toTable) {
                this.popSeatTip(f.fromD >= 0 ? f.fromD : 2, `交到桌上`,
                    f.isBig ? cc.color(255, 214, 110) : cc.color(190, 210, 200), f.isBig ? 26 : 20);
            }
        }

        this.startExTick();
        this.exTick();          // 收到广播的这一帧就把牌摆到该在的位置
    }

    /** 从台面立刻撤走某张牌（拿牌动作开始时调用，避免「牌在飞、台上还留一份」） */
    private removeTableCard(cardId: number): void {
        const i = this.tableCardIds.indexOf(cardId);
        if (i >= 0) this.tableCardIds.splice(i, 1);
        if (this.tableSelId === cardId) this.tableSelId = -1;
        this.tableSig = '';     // 让落定后的重建一定重画
        if (!this.nodeTableCards) return;
        for (const n of this.nodeTableCards.children.slice()) {
            if (n.name === 'tb_' + cardId) {
                n.off(cc.Node.EventType.TOUCH_END);
                cc.Tween.stopAllByTarget(n);
                n.destroy();
            }
        }
    }

    /** 构造飞牌时间轴与几何：牌从交牌人手里直接慢慢飞到拿牌人手里；
     *  只有 ENEMY_PUT / ENEMY_RETURN（一次摆 N 张）终点是桌面、停在台上等人挑 */
    private makeExFly(rec: ExRecord, startAt: number): ExFly {
        const isBig = rec.kind === 'ENEMY_PUT' || rec.kind === 'LOSER_GIVE';
        const toTable = rec.kind === 'ENEMY_PUT' || rec.kind === 'ENEMY_RETURN';
        const fromD = rec.from >= 0 ? this.disp(rec.from) : -1;
        // 起点：交牌人的手牌区（从桌上拿牌则从桌面起飞）
        const fromPos = fromD >= 0
            ? cc.v3(SEAT_ANCHOR[fromD].x, SEAT_ANCHOR[fromD].y, 0)
            : cc.v3(0, TABLE_CARD_Y, 0);
        const toD = rec.to >= 0 ? this.disp(rec.to) : -1;
        // 终点：拿牌人的手牌区 / 台面（等游客或被抓龟挑）
        const toPos = toTable ? cc.v3(0, TABLE_CARD_Y, 0)
            : (toD >= 0 ? cc.v3(SEAT_ANCHOR[toD].x, SEAT_ANCHOR[toD].y, 0) : cc.v3(0, TABLE_CARD_Y, 0));

        // 慢节奏保留：起点短暂浮现（看清谁交出）→ 慢慢飞 → 到达后停一下
        const hold = isBig ? 1.4 : 1.1;
        const fly = isBig ? 2.4 : 1.9;
        const rest = toTable ? 0.7 : 0.55;
        const t0 = 0.16;                     // 浮现：牌从交牌人手里冒出来
        const t1 = t0 + hold * 0.45;         // 起点停留：全场看清是谁交的
        const t2 = t1 + fly;                 // 一条弧线直接飞到拿牌人手里/台上
        const fade = 0.16;
        const total = t2 + rest + fade;

        return {
            rec, startAt, total, t0, t1, t2, rest, fade,
            fromPos, toPos,
            flyFrom: isBig ? 1.4 : 1.1,
            endScale: toTable ? 1.0 : 0.72,  // 一对一：落到对方手牌区时缩成手牌大小
            isBig, toTable, fromD, toD,
            node: null, tipDone: false,
        };
    }

    /** 挂上墙钟驱动的逐帧更新（与发牌 dealTick 同一套思路） */
    private startExTick(): void {
        if (this.exTickOn) return;
        this.exTickOn = true;
        this.schedule(this.exTick, 0.03);
    }

    private exTick = (): void => {
        const now = Date.now();
        const done: number[] = [];
        for (const [idx, f] of Array.from(this.exActive.entries())) {
            const t = (now - f.startAt) / 1000;
            if (t >= f.total) { done.push(idx); continue; }
            if (t < 0) continue;                  // 错峰还没轮到它起飞
            if (!f.node) this.createExNode(f);
            this.applyExFrame(f, t);
            if (!f.tipDone && t >= f.t2 && f.toD >= 0) {
                f.tipDone = true;
                this.popSeatTip(f.toD, `收到 ${f.rec.cardName}`, cc.color(140, 230, 160), f.isBig ? 26 : 20);
            }
        }
        for (const idx of done) {
            const f = this.exActive.get(idx);
            if (!f) continue;
            if (f.node && f.node.isValid) {
                if (f.toTable) {
                    // 落台的牌保留在原地（改名标记），等桌面按权威数据重建时再收走
                    f.node.name = 'tb_fly_' + f.rec.index;
                } else {
                    f.node.destroy();
                }
            }
            this.exActive.delete(idx);
            this.onExDone();
        }
        if (!this.exActive.size) {
            this.unschedule(this.exTick);
            this.exTickOn = false;
        }
    };

    /** 飞行牌建在最顶层 layerFly（高于手牌/座位/UI），4 个视角都不会被挡住 */
    private createExNode(f: ExFly): void {
        const card = DECK.get(f.rec.cardId);
        if (!card) return;
        const node = createCardNode(card, true);
        node.name = 'fly_' + f.rec.index;
        node.parent = this.layerFly;
        node.zIndex = 10;
        this.addGlow(node, f.isBig);
        node.setPosition(f.fromPos.x, f.fromPos.y);
        node.scale = 0.9;
        node.opacity = 0;
        f.node = node;
    }

    /** 按时间轴把牌摆到「此刻应该在」的位置/大小/透明度（无累积误差，切窗补齐天然对齐） */
    private applyExFrame(f: ExFly, t: number): void {
        const n = f.node;
        if (!n || !n.isValid) return;
        let pos = f.fromPos;
        let scale = f.flyFrom;
        let opacity = 255;
        if (t < f.t0) {
            // 浮现：牌从交牌人手里冒出来
            const p = t / f.t0;
            scale = this.lerp(0.85, f.flyFrom, p);
            opacity = 255 * p;
        } else if (t < f.t1) {
            // 起点短暂停留：全场看清是谁交出来的
            const p = (t - f.t0) / (f.t1 - f.t0);
            scale = f.flyFrom * (1 + 0.05 * Math.sin(Math.PI * p));
        } else if (t < f.t2) {
            // 一条弧线慢慢飞到拿牌人手里 / 台面，不做中间停顿
            const p = (t - f.t1) / (f.t2 - f.t1);
            pos = this.arcPoint(f.fromPos, f.toPos, 60, p);
            scale = this.lerp(f.flyFrom, f.endScale, p);
        } else if (t < f.t2 + f.rest) {
            // 到达：对方手上停一下（台上则等桌面牌接管）
            pos = f.toPos;
            scale = f.endScale;
        } else {
            const p = (t - f.t2 - f.rest) / f.fade;
            pos = f.toPos;
            scale = f.endScale;
            // 落台的牌停在桌上等人挑，不淡出；一对一的牌在对方手上淡出即可
            opacity = f.toTable ? 255 : 255 * (1 - p);
        }
        n.setPosition(pos.x, pos.y);
        n.scale = scale;
        n.opacity = Math.max(0, Math.min(255, opacity));
    }

    /** 一条飞牌落定（或记录已过期）：全部落定后才翻手牌/刷桌面 */
    private onExDone(): void {
        if (this.exActive.size > 0) return;
        this.exFlying = false;
        // 所有牌都飞到位了，才把缓存的手牌翻出来（此前界面上牌不会自己变）
        if (this.pendingHand) {
            this.myHand = this.pendingHand;
            this.pendingHand = null;
            if (!this.dealing) this.renderHand();
        }
        this.renderOpponents();
        this.refreshExchangeTable();
        this.refreshStatus();
    }

    /** 换局/重连：清掉所有在途飞牌 */
    private clearExFlies(): void {
        this.unschedule(this.exTick);
        this.exTickOn = false;
        this.exActive.clear();
        this.exFlying = false;
        this.exNextStart = 0;
        if (this.layerFly && this.layerFly.isValid) {
            for (const n of this.layerFly.children.slice()) {
                cc.Tween.stopAllByTarget(n);
                n.destroy();
            }
        }
    }

    /** 当前标签页是否在后台（只用于避免后台创建冻结的文字 tween，飞牌记录本身照常登记） */
    private hiddenTab(): boolean {
        try { return typeof document !== 'undefined' && !!document.hidden; } catch (e) { return false; }
    }

    /** 座位旁飘字（自动上浮淡出）——放最顶层，全场看得清 */
    private popSeatTip(d: number, text: string, color: cc.Color, size: number): void {
        const a = SEAT_ANCHOR[d];
        const y = d === 0 ? a.y + 66 : (d === 2 ? a.y - 60 : a.y + 40);
        const n = createLabel(text, size, color, a.x, y);
        n.parent = this.layerFly;
        n.zIndex = 30;
        n.opacity = 0;
        cc.tween(n)
            .to(0.18, { opacity: 255, y: y + 10 })
            .delay(0.7)
            .to(0.35, { opacity: 0, y: y + 34 })
            .call(() => { if (n && n.isValid) n.destroy(); })
            .start();
    }

    /** 桌面中央的交牌流程条：一句话说清「谁 把 什么牌 交给了 谁」 */
    private showExBanner(rec: ExRecord, isBig: boolean): void {
        if (this.nodeExBanner && this.nodeExBanner.isValid) {
            cc.Tween.stopAllByTarget(this.nodeExBanner);
            this.nodeExBanner.destroy();
        }
        let text: string;
        const who = rec.from >= 0 ? this.nameOf2(rec.from) : '';
        const to = rec.to >= 0 ? this.nameOf2(rec.to) : '';
        if (rec.kind === 'ENEMY_PUT') text = `${who} 把 ${rec.cardName} 摆到桌子中间`;
        else if (rec.kind === 'TOURIST_PICK') text = `${to} 从桌上拿走 ${rec.cardName}`;
        else if (rec.kind === 'LOSER_PICK') text = `${to} 从桌上挑走 ${rec.cardName}`;
        else if (rec.kind === 'ENEMY_RETURN') text = `${who} 把 ${rec.cardName} 摆到桌上（等被抓龟挑）`;
        else if (rec.kind === 'LOSER_GIVE') text = `${who} 交出大牌 ${rec.cardName} → ${to}`;
        else text = `${who} 还牌 ${rec.cardName} → ${to}`;

        const n = new cc.Node('ex_banner');
        n.parent = this.layerUi;
        n.zIndex = 45;
        n.setPosition(0, 6);
        const w = 520;
        const h = 50;
        const g = n.addComponent(cc.Graphics);
        g.roundRect(-w / 2, -h / 2, w, h, 12);
        g.fillColor = isBig ? cc.color(58, 44, 16, 235) : cc.color(14, 34, 26, 225);
        g.fill();
        g.strokeColor = isBig ? cc.color(255, 214, 110) : cc.color(90, 150, 120);
        g.lineWidth = isBig ? 3 : 1.5;
        g.stroke();

        const t = createLabel(text, isBig ? 22 : 19,
            isBig ? cc.color(255, 226, 140) : cc.color(200, 225, 210), 0, 0);
        t.parent = n;
        t.opacity = 240;
        t.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        this.nodeExBanner = n;
        n.opacity = 0;
        cc.tween(n)
            .to(0.15, { opacity: 255 })
            .delay(3.2)
            .to(0.4, { opacity: 0 })
            .call(() => { if (n && n.isValid) n.destroy(); })
            .start();
    }

    /** 视角座位名（用于流程条/提示，显示「我/右家/对家/左家」） */
    private nameOf2(serverSeat: number): string {
        if (serverSeat === this.mySeat) return '你';
        return SEAT_NAME[this.disp(serverSeat)];
    }



    private refreshExchangeTable(): void {
        if (!this.nodeTableCards) return;
        // 飞牌动画进行中：桌面牌由动画本身呈现，别提前把结果画出来
        // （数据 tableCardIds 照常更新，动画播完后会补渲染）
        if (this.exFlying) return;
        // 收走「已停在台上」的落定飞牌：桌面马上按服务器权威数据重建
        if (this.layerFly && this.layerFly.isValid) {
            for (const n of this.layerFly.children.slice()) {
                if (n.name.indexOf('tb_fly_') === 0) n.destroy();
            }
        }
        // 只有轮到自己「拿牌」时才可点；其他时候桌面牌照样要显示（全场都能看到交换过程）
        const canPick = !!this.turnEx
            && (this.turnEx.kind === 'TOURIST_PICK' || this.turnEx.kind === 'LOSER_PICK')
            && this.exTurn !== null && this.exTurn.seat === this.mySeat;
        const list = this.tableCardIds || [];

        // 内容签名：没变化就不重建，避免重复销毁造成的重影
        const sig = list.join(',') + '|' + this.tableSelId + '|' + (canPick ? 1 : 0);
        if (sig === this.tableSig && this.nodeTableCards.children.length === list.length) return;
        this.tableSig = sig;

        for (const old of this.nodeTableCards.children.slice()) {
            cc.Tween.stopAllByTarget(old);
            old.stopAllActions();
            old.off(cc.Node.EventType.TOUCH_END);
        }
        this.nodeTableCards.removeAllChildren();
        if (!list.length) return;

        const n = list.length;
        const totalW = TABLE_CARD_GAP * (n - 1);
        for (let i = 0; i < n; i++) {
            const card = DECK.get(list[i]);
            if (!card) continue;
            const node = createCardNode(card, true);
            node.name = 'tb_' + card.id;
            node.parent = this.nodeTableCards;
            node.setPosition(-totalW / 2 + i * TABLE_CARD_GAP, TABLE_CARD_Y);
            const sel = this.tableSelId === card.id;
            node.scale = canPick ? 1.05 : 0.9;
            if (sel) node.y += 14;

            if (canPick) {
                // 可点的牌加金边 + 轻微浮动，明确告诉玩家「这张能拿」
                this.addGlow(node, true);
                node.on(cc.Node.EventType.TOUCH_END, () => {
                    if (!this.turnEx || this.exchangeLock) return;
                    this.tableSelId = card.id;
                    this.refreshExchangeTable();
                    this.refreshStatus();
                });
                const baseY = node.y;
                cc.tween(node)
                    .to(1.0, { y: baseY + 6 }, { easing: 'sineInOut' })
                    .to(1.0, { y: baseY }, { easing: 'sineInOut' })
                    .union()
                    .repeatForever()
                    .start();
            } else {
                node.opacity = 235;
            }
        }
    }

    private tableSig = '';

    /** 给牌节点套一层发光描边 */
    private addGlow(node: cc.Node, gold: boolean): void {
        const ring = new cc.Node('glow');
        ring.parent = node;
        ring.zIndex = -1;
        const g = ring.addComponent(cc.Graphics);
        const w = CARD_W + 10;
        const h = CARD_H + 10;
        g.roundRect(-w / 2, -h / 2, w, h, 9);
        g.fillColor = gold ? cc.color(255, 220, 120, 90) : cc.color(255, 255, 255, 60);
        g.fill();
        g.strokeColor = gold ? cc.color(255, 232, 160) : cc.color(200, 220, 210);
        g.lineWidth = 2;
        g.stroke();
    }

    // ================= 出牌 / 交牌提交 =================

    /**
     * 提示：与单机版（GameScene.onHintClick）完全一致的做法——
     * 用 AI 的决策函数 decidePlay 算一手最合适的牌并自动选中，玩家自己再点「出牌」。
     * 领出时：若自己是已暴露的敌人，按 decideRevealLead 带方块4 出；否则出最小那张。
     */
    private onHintClick(): void {
        if (!this.turnPlay) return;
        let best: Card[] | null = null;
        if (this.turnPlay.mustLead) {
            if (this.revealedEnemy === this.mySeat) best = decideRevealLead(this.myHand);
            else best = [sortCards(this.myHand)[0]];
        } else {
            best = decidePlay(this.myHand, this.lastPatternObj);
        }

        if (!best || !best.length) {
            this.flash('没有能压过的牌，只能跳过');
            return;
        }
        this.selected.clear();
        for (const c of best) this.selected.add(c.id);
        this.renderHand();
        this.flash('已为你选中：' + best.map((c) => c.name).join(' '));
    }

    private onPlayClick(): void {
        if (!this.turnPlay) return;
        const picked = this.myHand.filter((c) => this.selected.has(c.id));
        if (!picked.length) { this.flash('请先点选要出的牌'); return; }

        /*
         * 关键：不要在这里清 turnPlay / 藏按钮！
         * 出牌是否合法由服务器判定；如果这手压不过上家，服务器会回 error，
         * 界面必须保持「轮到你了」的状态让玩家重选。
         * 只有收到 played（出牌成功）或新的 turn/state 时才切换状态。
         */
        this.net.act('play', picked.map((c) => c.id));
        this.show(this.btnPlay, false);
        this.show(this.btnPass, false);
        this.show(this.btnHint, false);
        this.pendingPlay = true;
        this.flash('出牌中…', 3);

        // 兜底：3 秒内没有任何回应（网络问题），把按钮还回去，避免界面死锁
        this.unschedule(this.restoreAfterPending);
        this.scheduleOnce(this.restoreAfterPending, 3);
    }

    /** 出牌被拒绝/超时无响应时，把操作按钮还给玩家 */
    private restoreAfterPending = (): void => {
        if (!this.pendingPlay) return;
        this.pendingPlay = false;
        if (this.turnPlay) {
            this.show(this.btnPlay, true);
            this.show(this.btnPass, !this.turnPlay.mustLead);
            this.show(this.btnHint, true);
        }
        this.refreshStatus();
    };

    private onPassClick(): void {
        if (!this.turnPlay) return;
        if (this.turnPlay.mustLead) { this.flash('领出时不能跳过'); return; }
        this.turnPlay = null;
        this.net.act('pass');
        this.stopTimer();
        this.show(this.btnPlay, false);
        this.show(this.btnPass, false);
        this.show(this.btnHint, false);
        this.refreshStatus();
    }

    private onExchangeSubmit(): void {
        if (!this.turnEx) return;
        if (this.exchangeLock) return;   // 防连点：与单机版同一把锁
        const k = this.turnEx.kind;
        const count = this.turnEx.count;

        // 先校验，不合格直接返回、不动锁（与单机版一致）
        // 敌人交大牌/还小牌：一次按钮交 N 张（按钮显示已点 X/最多 N）
        if ((k === 'ENEMY_PUT' || k === 'ENEMY_RETURN') && this.selected.size !== count) {
            this.flash(k === 'ENEMY_PUT'
                ? `请先点选正好 ${count} 张最大的牌，再点「交到桌上」`
                : `请先点选正好 ${count} 张小牌，再点「还牌」`);
            return;
        }
        if ((k === 'TOURIST_PICK' || k === 'LOSER_PICK') && this.tableSelId <= 0) {
            this.flash('请先点桌子中间的一张牌'); return;
        }
        if (k === 'LOSER_GIVE' && !this.selected.size) {
            this.flash('请先点你最大的那张大牌，再按「交出去」'); return;
        }
        if (k === 'TOURIST_RETURN' && !this.selected.size) {
            this.flash('请先点一张要还回去的牌'); return;
        }
        // 上锁 + 立刻清空选择：连点时第二次进来会被锁挡住
        this.exchangeLock = true;
        const submitId = this.tableSelId;
        const submitIds = Array.from(this.selected);
        this.tableSelId = -1;
        this.selected.clear();
        this.refreshStatus();

        if (k === 'ENEMY_PUT' || k === 'ENEMY_RETURN') {
            this.net.act('play', submitIds);
        } else if (k === 'TOURIST_PICK' || k === 'LOSER_PICK') {
            this.net.act('play', [submitId]);
        } else if (k === 'TOURIST_RETURN') {
            this.net.act('play', submitIds);
        } else if (k === 'LOSER_GIVE') {
            // 必须自己点牌再交，无自动兜底
            this.net.act('play', submitIds);
        } else {
            this.flash('请先完成本步操作'); return;
        }

        // 失败兜底：2.5 秒没收到回执就解锁，避免界面死锁
        this.unschedule(this.releaseExchangeLock);
        this.scheduleOnce(this.releaseExchangeLock, 2.5);
    }

    private releaseExchangeLock = (): void => {
        this.exchangeLock = false;
        this.refreshStatus();
    };

    /** 提交成功后收尾（收到新的 hand/turn 时调用） */
    private finishExchangeStep(): void {
        this.exchangeLock = false;
        this.unschedule(this.releaseExchangeLock);
        this.turnEx = null;
        this.tableSelId = -1;
        this.selected.clear();
        this.show(this.btnExSubmit, false);
        if (this.nodeTableCards) this.nodeTableCards.removeAllChildren();
        this.refreshStatus();
    }

    // ================= 出牌区展示 =================

    /**
     * 显示出牌。
     *
     * 规则（防止「不管点哪个窗口都显示左家出牌」这类串位）：
     *   - 每家的牌只画在**自己显示座位**的 PLAY_POS 上，绝不共用位置；
     *   - 一轮开始时（领出）先清空全桌旧牌，所以桌面上永远只有「这一圈」的牌；
     *   - 方位完全由 (服务器座位 - 我的座位 + 4) % 4 计算，不依赖消息到达顺序。
     */
    private showPlayed(serverSeat: number, cards: Card[]): void {
        const d = this.disp(serverSeat);

        // 领出者（桌面本来没牌）→ 清空上一圈
        if (this.lastPlaySeat < 0) this.clearTableCards();
        this.lastPlaySeat = serverSeat;

        this.clearSeatCards(d);

        const pos = PLAY_POS[d];
        const gap = 30;
        const totalW = gap * (cards.length - 1);
        const anchor = SEAT_ANCHOR[d];

        for (let i = 0; i < cards.length; i++) {
            const node = createCardNode(cards[i], true);
            node.name = `p${d}_${i}`;
            node.parent = this.layerTable;
            node.setPosition(anchor.x, anchor.y);   // 从自己手牌位置飞出
            node.opacity = 0;
            node.scale = 0.62;
            const tx = pos.x - totalW / 2 + i * gap;
            cc.tween(node)
                .to(0.22, { position: cc.v3(tx, pos.y, 0), opacity: 255, scale: 0.8 })
                .start();
        }
    }

    /** 清掉某个显示座位桌面上的牌 */
    private clearSeatCards(d: number): void {
        for (const child of this.layerTable.children.slice()) {
            if (child.name.indexOf(`p${d}_`) === 0) child.destroy();
        }
    }

    /** 清空全桌（新一轮领出时）；飞牌在独立的 layerFly 层，不受影响 */
    private clearTableCards(): void {
        for (const child of this.layerTable.children.slice()) {
            cc.Tween.stopAllByTarget(child);
            child.destroy();
        }
    }

    private showSkip(serverSeat: number): void {
        const d = this.disp(serverSeat);
        const a = PLAY_POS[d];
        this.clearSeatCards(d);
        const t = createLabel('要不起', 20, cc.color(210, 210, 210), a.x, a.y);
        t.name = `p${d}_skip`;
        t.parent = this.layerTable;
        t.opacity = 220;
        cc.tween(t).by(0.5, { position: cc.v3(0, 22, 0) }).to(0.3, { opacity: 0 })
            .call(() => { if (t.isValid) t.destroy(); }).start();
    }

    // ================= 结算 =================

    private showResult(result: any): void {
        if (!result) { this.flash('本局结束'); return; }
        const r = result;
        const meIsEnemy = r.enemySeat === this.mySeat;
        const iWin = r.enemyWin ? meIsEnemy : r.finishOrder.indexOf(this.mySeat) >= 0;

        const pw = 720;
        const ph = 430;
        const panel = createPanel(pw, ph, cc.color(12, 32, 24, 245), cc.color(226, 190, 100), 18);
        panel.parent = this.layerPop;

        const title = createLabel(iWin ? '你赢了！' : '你输了', 40,
            iWin ? cc.color(255, 226, 140) : cc.color(200, 205, 210), 0, ph / 2 - 52);
        title.parent = panel;

        const sub = createLabel(r.enemyWin
            ? `敌人（${this.nameOf(r.enemySeat)}）赢了，把没出完的乌龟抓走了`
            : '乌龟方赢了，敌人被抓龟抓空了',
            20, cc.color(190, 225, 200), 0, ph / 2 - 98);
        sub.parent = panel;

        const RANKS = ['', '导游', '中游', '尾游'];
        const lines: string[] = [];
        for (let s = 0; s < 4; s++) {
            let role: string;
            if (s === r.enemySeat) role = r.enemyWin ? '敌人 · 赢' : '敌人 · 输';
            else {
                const idx = r.finishOrder.indexOf(s);
                role = idx >= 0 ? (RANKS[idx + 1] || '乌龟') : '被抓龟';
            }
            const win = r.enemyWin ? s === r.enemySeat : r.finishOrder.indexOf(s) >= 0;
            lines.push(`${this.nameOf(s)}${s === r.enemySeat ? '（敌人）' : ''}：${role}${win ? ' ✔' : ''}`);
        }
        const list = createLabel(lines.join('\n'), 21, cc.color(232, 240, 228), 0, 10);
        list.parent = panel;
        list.getComponent(cc.Label)!.lineHeight = 32;
        list.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        const next = createButton('再来一局', {
            fill: cc.color(56, 132, 96), fontSize: 22, width: 220, height: 56, stroke: cc.color(120, 210, 160),
        }, () => {
            if (this.votedNext) return;
            this.votedNext = true;
            this.net.next();        // 只是投一票：4 人都点了服务器才发牌
            setButtonText(next, '已点，等待其他人…');
        });
        next.parent = panel;
        next.setPosition(-120, -ph / 2 + 58);

        // 全员确认进度：谁点了这里能看到，不会「一个人点全体被拉进牌局」
        const voteLabel = createLabel(`已点「再来一局」：${this.nextVoteCount}/4`, 18, cc.color(170, 215, 185), 0, -ph / 2 + 30);
        voteLabel.parent = panel;
        this.lblNextVote = voteLabel.getComponent(cc.Label)!;

        const exit = createButton('退出游戏', {
            fill: cc.color(140, 74, 62), fontSize: 22, width: 200, height: 56,
        }, () => { this.net.close(); this.backToMenu(); });
        exit.parent = panel;
        exit.setPosition(120, -ph / 2 + 58);
    }

    // ================= 杂项 =================

    private show(n: cc.Node, v: boolean): void {
        if (n && n.active !== v) n.active = v;
    }

    private flash(msg: string, seconds = 2.4): void {
        this.hintOverride = msg;
        this.refreshStatus();
        this.unschedule(this.clearFlash);
        this.scheduleOnce(this.clearFlash, seconds);
    }

    private clearFlash = (): void => {
        this.hintOverride = '';
        this.refreshStatus();
    };

    private showDisconnected(): void {
        this.clearPop();
        const p = createPanel(600, 300, cc.color(12, 32, 24, 245), cc.color(226, 190, 100), 16);
        p.parent = this.layerPop;
        const t = createMultiline(
            '与服务器的连接已断开（重连 5 次都没成功）\n\n其他玩家会把你这局托管打完，\n回到主菜单重新匹配即可。',
            22, cc.color(240, 235, 215), 0, 40, 540);
        t.parent = p;
        const back = createButton('返回主菜单', {
            fill: cc.color(160, 80, 66), fontSize: 22, width: 180, height: 52,
        }, () => { this.net.close(); this.backToMenu(); });
        back.parent = p;
        back.setPosition(0, -80);
    }

    private confirmExit(): void {
        this.clearPop();
        const p = createPanel(560, 260, cc.color(12, 32, 24, 245), cc.color(226, 190, 100), 16);
        p.parent = this.layerPop;
        const t = createMultiline('确定要退出联机对局吗？', 24, cc.color(240, 235, 215), 0, 40, 500);
        t.parent = p;
        const yes = createButton('退出', { fill: cc.color(160, 80, 66), fontSize: 22, width: 150, height: 52 },
            () => { this.net.close(); this.backToMenu(); });
        yes.parent = p;
        yes.setPosition(-95, -60);
        const no = createButton('继续玩', { fill: cc.color(70, 110, 92), fontSize: 22, width: 150, height: 52 },
            () => this.clearPop());
        no.parent = p;
        no.setPosition(95, -60);
    }

    private backToMenu(): void {
        cc.director.loadScene('menu', (err) => {
            if (err) cc.error('[乌龟4] 返回主菜单失败', err);
        });
    }

    private clearPop(): void {
        this.layerPop.removeAllChildren();
        this.lobbyPanel = null;
    }
}
