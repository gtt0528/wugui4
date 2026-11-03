/**
 * 乌龟4 —— 牌局场景（单机：1 真人 + 3 AI）
 *
 * 全部 UI 由代码动态构建，不需要预先摆放节点，也不需要美术素材。
 * 使用方式：Canvas 下建一个空节点，把本脚本挂上去。
 *
 * 座位布局（横屏 1280x720，逆时针）：
 *   0 = 自己（下方）  1 = 右  2 = 上  3 = 左
 *
 * 坐标以屏幕中心为原点：x ∈ [-640, 640]，y ∈ [-360, 360]。
 */

import { Card, sortCards, DIAMOND_4_ID } from '../core/Card';
import {
    GameEngine, Phase, SEAT_COUNT, ExchangeRecord, ExchangeStep, RANK_NAME, turtleRankOf,
} from '../core/GameEngine';
import { decideRevealLead, decidePlay } from '../core/AI';
import {
    createCardNode, createLabel, createButton, createPanel, createMultiline,
    setButtonText, CARD_W, CARD_H,
} from './CardView';
import { loadProfile, applyRoundResult } from '../core/Profile';
import { NetClient } from '../net/NetClient';
import OnlineGameView from './OnlineGameView';

const { ccclass } = cc._decorator;

const W = 1280;
const H = 720;

/** 各座位手牌锚点 */
const SEAT_ANCHOR = [
    cc.v2(0, -H / 2 + 96),    // 0 自己（下）
    cc.v2(W / 2 - 118, 10),   // 1 右
    cc.v2(0, H / 2 - 96),     // 2 上
    cc.v2(-W / 2 + 118, 10),  // 3 左
];
const SEAT_NAME = ['你', '右家', '对家', '左家'];

/** 出牌区（各家出的牌摆放位置） */
const PLAY_POS = [
    cc.v2(0, -112),    // 0 自己出的牌
    cc.v2(316, 6),     // 1 右
    cc.v2(0, 118),     // 2 上
    cc.v2(-316, 6),    // 3 左
];

/** 牌桌椭圆半径（用于画"正在思考"高亮） */
const TABLE_RX = 430;
const TABLE_RY = 190;

/**
 * 交牌动画的整体速度倍率。
 * 1.0 = 当前速度；调小更快（0.6 = 快 40%），调大更慢（1.5 = 慢一半）。
 * 觉得看不清就把这里调大，觉得拖沓就调小。
 */
const EXCHANGE_SPEED = 1.0;

/**
 * 桌上大牌停留多久才自动进入下一步（秒）。
 * 单机阶段给 1.5 秒，够看清；联网上线后每个玩家的每次选择限时 10 秒，
 * 到时候把这里换成 10（并按玩家计时，超时自动选择）。
 */
const TABLE_WAIT_SEC = 1.5;

/** 桌子正中间「待认领大牌」的摆放参数 */
const TABLE_CARD_GAP = 74;
/** 桌中待认领牌的摆放高度：偏上，避让桌面中央的流程提示条 */
const TABLE_CARD_Y = 96;

@ccclass
export default class GameScene extends cc.Component {

    private engine: GameEngine = new GameEngine({ humanSeat: 0, minRounds: 999 });

    private layerBg: cc.Node = null!;
    private layerTable: cc.Node = null!;
    private layerOpp: cc.Node = null!;
    private layerHand: cc.Node = null!;
    private layerSeat: cc.Node = null!;
    private layerUi: cc.Node = null!;
    private layerPop: cc.Node = null!;

    private lblRound: cc.Label = null!;
    private lblRole: cc.Label = null!;
    private lblStatus: cc.Label = null!;
    private lblHint: cc.Label = null!;
    private lblMyCount: cc.Label = null!;

    /** 主操作按钮（出牌 / 跳过 / 提示）—— 拉开间距摆放 */
    private btnPlay: cc.Node = null!;
    private btnPass: cc.Node = null!;
    private btnHint: cc.Node = null!;
    /** 交牌阶段专用按钮：交到桌上（敌人拍大牌） */
    private btnExchange: cc.Node = null!;
    /** 交牌阶段专用按钮：拿牌（游客认领 / 交最大牌 / 还牌） */
    private btnPick: cc.Node = null!;
    /** 返回主菜单（左上角） */
    private btnBack: cc.Node = null!;

    /** 已选中的牌 id */
    private selected: Set<number> = new Set();
    private busy = false;
    /** 交牌阶段玩家已选中的牌 id（-1 = 未选） */
    private exchangeSelId = -1;
    /** 敌人交大牌时选中的多张牌（按点击顺序） */
    private exchangeSelIds: number[] = [];
    /** exchangeLog 里已经播过动画的条数 */
    private logPlayed = 0;
    /** 正在飞的那张牌已经播过日志了（防止到达后又重复播一次） */
    private lastPlayedRec: ExchangeRecord | null = null;
    /** 桌面中央那几张大牌的容器 */
    private nodeTableCards: cc.Node = null!;
    /** 交牌流程正在等待/播动画（防止重入导致重复计时器） */
    private exchangeBusy = false;
    /**
     * 交牌提交锁：从「点了提交按钮」到「引擎真正把这一步处理完」之间，锁住所有输入。
     * 手机上一次点击容易触发连点/双击，没有这把锁就会出现"同一张牌被搬好几次"的重影。
     */
    private exchangeLock = false;
    /** 出牌/跳过/提示 的提交锁，同理防止连点打出两手牌 */
    private playLock = false;
    /**
     * 点击节流：记录上一次有效点击的时间（秒）。
     * 手机端一次触摸常被识别成 2-3 次 TOUCH_END，靠这个时间窗挡掉。
     */
    private lastTapTime = 0;
    /** 两次点击之间的最小间隔（秒）——低于这个值视为同一次触摸的重复触发 */
    private static readonly TAP_THROTTLE = 0.18;
    /** 提示语临时覆盖 */
    private hintOverride = '';
    /** 敌人暴露是否已经播报过（避免重复弹） */
    private revealedAnnounced = false;

    /** 桌上正在显示的出牌：记录是第几"轮"，用于清理 */
    private tableOwner: number[] = [-1, -1, -1, -1];
    /** 本圈是否已经有人领出（用于清理上一圈） */
    private trickIndex = 0;

    // ================= 生命周期 =================

    onLoad(): void {
        cc.view.resizeWithBrowserSize(true);
        cc.view.setDesignResolutionSize(W, H, cc.ResolutionPolicy.SHOW_ALL);

        /*
         * 联机入口：从主菜单「开始匹配」进来的玩家带着一条活的 WebSocket 连接，
         * 牌局由服务器消息驱动（OnlineGameView），本地引擎完全不参与。
         * 单机路径一行不改——没有连接时走原来的 startGame。
         */
        if (NetClient.inst.connected) {
            this.node.addComponent(OnlineGameView);
            this.destroy();
            return;
        }

        this.buildUI();
        // 看门狗：每秒喂一次，交牌链长时间无进展就强行解锁重推
        this.schedule(this.exchangeWatchdog, 1);
        try {
            this.startGame();
        } catch (err) {
            cc.error('[乌龟4] 开局失败，1 秒后重试: ' + err);
            this.busy = false;
            this.exchangeBusy = false;
            this.scheduleOnce(() => {
                try { this.startGame(); } catch (e2) { cc.error('[乌龟4] 重试开局仍失败: ' + e2); }
            }, 1.0);
        }
    }

    /**
     * 交牌看门狗。
     *
     * 作用：链式动画最怕「某个回调再也没回来」——节点被销毁、tween 被打断、
     * 极端时序下 scheduleOnce 丢失等。一旦发生，exchangeChainAlive 会永远为 true，
     * 之后所有 processExchange 都被忽略，界面就永久停住。
     * 这里在「交牌阶段 + 链还活着」的前提下累计时间，超过阈值就强行拆链重推。
     */
    private exchangeWatchdog(): void {
        const e = this.engine;
        if (!e) return;

        // ---------- 等待开局：玩家点了「继续留在房间」但开局的定时器丢了 ----------
        if (e.phase === Phase.ROUND_WAIT) {
            this.exchangeWatchTime = 0;
            this.playWatchTime = 0;
            this.waitWatchTime += 1;
            if (this.waitWatchTime >= GameScene.WAIT_WATCHDOG) {
                cc.warn('[乌龟4] 等待开局超时，看门狗自动开下一局');
                this.waitWatchTime = 0;
                this.startRound();
            }
            return;
        }
        this.waitWatchTime = 0;

        // ---------- 出牌阶段：busy 卡住 = AI 链断了，必须救回来 ----------
        if (e.phase === Phase.PLAYING) {
            this.exchangeWatchTime = 0;
            this.exchangeWatchLog = this.logPlayed;
            if (this.busy) {
                this.playWatchTime += 1;
                if (this.playWatchTime >= GameScene.PLAY_WATCHDOG) {
                    cc.warn('[乌龟4] 出牌阶段卡住（busy 未复位），看门狗强制恢复');
                    this.playWatchTime = 0;
                    this.busy = false;
                    this.playLock = false;
                    this.refreshAll();
                    this.checkTurn();
                }
            } else {
                this.playWatchTime = 0;
            }
            return;
        }
        this.playWatchTime = 0;

        // ---------- 交牌阶段：链长时间无进展 = 死锁 ----------
        if (e.phase !== Phase.EXCHANGE) {
            this.exchangeWatchTime = 0;
            this.exchangeWatchLog = this.logPlayed;
            return;
        }
        // 有进展（logPlayed 变了）就清零
        if (this.exchangeWatchLog !== this.logPlayed) {
            this.exchangeWatchLog = this.logPlayed;
            this.exchangeWatchTime = 0;
            return;
        }
        // 停在等真人输入：链已结束，正常情况下不算卡死。
        // 但如果此时 exchangeLock 还残留着（提交后走到等真人步骤却没解锁），
        // 按钮会永远显示「处理中…」——这就是"拿牌后一直处理中"的锁残路径，必须强制解开。
        if (!this.exchangeChainAlive) {
            const st = e.currentExchange;
            if (st && st.from === 0 && this.exchangeLock && !this.exchangeBusy) {
                this.exchangeWatchTime += 1;
                if (this.exchangeWatchTime >= 2) {
                    cc.warn('[乌龟4] 等真人输入但提交锁残留，看门狗强制解锁');
                    this.exchangeWatchTime = 0;
                    this.exchangeLock = false;
                    this.refreshAll();
                }
            } else {
                this.exchangeWatchTime = 0;
            }
            return;
        }
        this.exchangeWatchTime += 1;
        if (this.exchangeWatchTime < GameScene.EXCHANGE_WATCHDOG) return;

        // ---- 判定卡死：强行拆链，把状态复位后重新推进 ----
        cc.warn('[乌龟4] 交牌链超时无进展，看门狗强制复位：logPlayed='
            + this.logPlayed + '/' + e.exchangeLog.length);
        this.exchangeWatchTime = 0;
        this.flyingRecord = false;
        this.exchangeBusy = false;
        this.exchangeLock = false;
        this.exchangeChainAlive = false;
        // 还没播完的记录直接标记为已播（宁可少一段动画，也不能让流程停死）
        if (this.logPlayed < e.exchangeLog.length) this.logPlayed = e.exchangeLog.length;
        this.clearFlyingCards();
        this.processExchange();
    }

    // ================= UI 构建 =================

    private buildUI(): void {
        // ---- 背景层 ----
        this.layerBg = this.mkLayer('bg', 0);
        const bg = this.layerBg.addComponent(cc.Graphics);
        bg.rect(-W / 2, -H / 2, W, H);
        bg.fillColor = cc.color(24, 28, 26);
        bg.fill();
        // 牌桌：外圈 + 内圈
        bg.ellipse(0, 4, TABLE_RX + 26, TABLE_RY + 26);
        bg.fillColor = cc.color(96, 62, 32);
        bg.fill();
        bg.ellipse(0, 4, TABLE_RX, TABLE_RY);
        bg.fillColor = cc.color(26, 96, 64);
        bg.fill();
        bg.ellipse(0, 4, TABLE_RX - 40, TABLE_RY - 26);
        bg.strokeColor = cc.color(46, 128, 88);
        bg.lineWidth = 2;
        bg.stroke();

        this.layerTable = this.mkLayer('table', 10);
        // 桌面中央的「待认领大牌」单独一层，压在出牌区之上，方便点击
        this.nodeTableCards = this.mkLayer('ex_table', 14);
        this.layerOpp = this.mkLayer('opp', 20);
        this.layerSeat = this.mkLayer('seat', 26);
        this.layerHand = this.mkLayer('hand', 30);
        this.layerUi = this.mkLayer('ui', 40);
        this.layerPop = this.mkLayer('pop', 50);

        // ---- 顶部信息 ----
        this.lblRound = this.mkText(this.layerUi, '第 1 局', 22, cc.color(255, 235, 160), -W / 2 + 24, H / 2 - 28, 'left');
        this.lblRole = this.mkText(this.layerUi, '', 22, cc.color(255, 215, 120), W / 2 - 24, H / 2 - 28, 'right');

        // 左上角返回按钮（小）
        this.btnBack = createButton('≡', {
            fill: cc.color(40, 52, 48), fontSize: 24, width: 52, height: 46,
        }, () => this.confirmExit());
        this.btnBack.parent = this.layerUi;
        this.btnBack.setPosition(-W / 2 + 52, H / 2 - 84);

        // ---- 状态 / 提示 ----
        this.lblStatus = this.mkText(this.layerUi, '', 22, cc.Color.WHITE, 0, H / 2 - 30, 'center');
        this.lblHint = this.mkText(this.layerUi, '', 18, cc.color(255, 200, 120), 0, H / 2 - 62, 'center');

        // 自己的剩余张数（固定显示在按钮组右侧，局面再乱也看得见）
        this.lblMyCount = this.mkText(this.layerUi, '', 22, cc.color(255, 240, 190), 300, -H / 2 + 118, 'center');

        // ---- 主操作按钮：间距 200（原来 110，挤在一起）----
        this.btnPlay = createButton('出牌', { fill: cc.color(214, 76, 52), fontSize: 26, width: 150, height: 58 }, () => this.onPlayClick());
        this.btnPlay.parent = this.layerUi;
        this.btnPlay.setPosition(-200, -H / 2 + 46);

        this.btnPass = createButton('跳过', { fill: cc.color(96, 100, 112), fontSize: 26, width: 150, height: 58 }, () => this.onPassClick());
        this.btnPass.parent = this.layerUi;
        this.btnPass.setPosition(0, -H / 2 + 46);

        this.btnHint = createButton('提示', { fill: cc.color(56, 120, 186), fontSize: 26, width: 150, height: 58 }, () => this.onHintClick());
        this.btnHint.parent = this.layerUi;
        this.btnHint.setPosition(200, -H / 2 + 46);

        // ---- 交牌阶段按钮（默认隐藏）----
        // 敌人把大牌拍到桌上
        this.btnExchange = createButton('交到桌上', {
            fill: cc.color(226, 150, 50), fontSize: 24, width: 190, height: 52,
        }, () => this.onPutToTable());
        this.btnExchange.parent = this.layerUi;
        this.btnExchange.setPosition(-110, -H / 2 + 26);
        this.btnExchange.active = false;

        // 游客从桌上拿走一张 / 被抓龟交最大牌 / 挑一张还回去
        this.btnPick = createButton('拿牌', {
            fill: cc.color(64, 156, 112), fontSize: 22, width: 160, height: 48,
        }, () => this.onExchangeButton());
        this.btnPick.parent = this.layerUi;
        this.btnPick.setPosition(110, -H / 2 + 24);
        this.btnPick.active = false;
    }

    private mkLayer(name: string, z: number): cc.Node {
        const n = new cc.Node(name);
        n.parent = this.node;
        n.zIndex = z;
        n.setContentSize(W, H);
        return n;
    }

    /** 递归停掉某个节点树下所有 tween / action（清层前必须调用） */
    private stopAllTweensIn(root: cc.Node): void {
        if (!root || !root.isValid) return;
        const visit = (n: cc.Node): void => {
            if (!n || !n.isValid) return;
            cc.Tween.stopAllByTarget(n);
            n.stopAllActions();
            for (const c of n.children.slice()) visit(c);
        };
        for (const c of root.children.slice()) visit(c);
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

    // ================= 游戏流程 =================

    private startGame(): void {
        this.engine = new GameEngine({ humanSeat: 0, minRounds: 999 });
        this.startRound();
    }

    private startRound(): void {
        this.selected.clear();
        this.exchangeSelId = -1;
        this.exchangeSelIds = [];
        this.logPlayed = 0;
        this.lastPlayedRec = null;
        this.exchangeBusy = false;
        // 上一局万一因为什么原因锁没收回来，这里强制复位，绝不让锁跨局残留
        this.exchangeLock = false;
        this.playLock = false;
        this.lastTapTime = 0;
        this.tableCardsSig = '';
        this.tableFadePending = false;
        this.tableFadeDelay = 0;
        this.flyingRecord = false;
        // 交牌链与看门狗状态也要跨局清干净，否则上一局没走完的链会挡住新一局
        this.unscheduleAllCallbacks();
        this.schedule(this.exchangeWatchdog, 1);
        this.exchangeChainAlive = false;
        this.exchangeChain++;
        this.exchangeWatchTime = 0;
        this.exchangeWatchLog = 0;
        this.playWatchTime = 0;
        this.waitWatchTime = 0;
        this.resultShown = false;
        this.revealedAnnounced = false;
        this.tableOwner = [-1, -1, -1, -1];
        this.trickIndex = 0;
        // 清层之前先把所有 tween 停掉：残留的飞牌/浮动动画如果继续跑在已销毁的
        // 节点上，会报错，在手机上还可能留下残影。
        this.stopAllTweensIn(this.layerTable);
        this.stopAllTweensIn(this.nodeTableCards);
        const oldBanner = this.layerTable.getChildByName('ex_banner');
        if (oldBanner && oldBanner.isValid) oldBanner.destroy();
        this.layerTable.removeAllChildren();
        this.nodeTableCards.removeAllChildren();
        this.layerHand.removeAllChildren();
        this.layerOpp.removeAllChildren();
        this.layerSeat.removeAllChildren();
        this.clearPop();

        this.engine.startRound();
        this.lblRound.string = `第 ${this.engine.roundNo} 局`;
        this.updateRole();

        this.dealAnimation(() => this.afterDeal());
    }

    private afterDeal(): void {
        this.refreshAll();
        if (this.engine.phase === Phase.EXCHANGE) {
            this.processExchange();
        } else {
            this.checkTurn();
        }
    }

    /** 发牌动画：牌从中心飞向各家 */
    private dealAnimation(done: () => void): void {
        this.busy = true;
        const center = cc.v3(0, 10, 0);
        let delay = 0;
        let count = 0;
        let total = 0;
        for (let s = 0; s < SEAT_COUNT; s++) total += this.engine.players[s].cards.length;

        /*
         * 完成回调可能被两个地方触发（最后一张牌的 tween、下面的兜底定时器），
         * 用 finished 保证只执行一次：重复执行会把交牌流程/出牌流程各推一遍，
         * 两条流程叠在一起就会互相卡住。
         */
        let finished = false;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            this.busy = false;
            try {
                done();
            } catch (err) {
                cc.error('[乌龟4] 发牌后流程异常（尝试兜底推进）: ' + err);
                // 兜底：不管 afterDeal 里哪一步炸了，都要把牌局推起来，不能停在发完牌的空桌
                this.scheduleOnce(() => {
                    try {
                        if (this.engine.phase === Phase.EXCHANGE) this.processExchange();
                        else this.checkTurn();
                    } catch (e2) {
                        cc.error('[乌龟4] 兜底推进失败: ' + e2);
                    }
                }, 0.2);
            }
        };

        for (let s = 0; s < SEAT_COUNT; s++) {
            const p = this.engine.players[s];
            const n = p.cards.length;
            for (let i = 0; i < n; i++) {
                // 单张牌画不出来不能拖垮整局：跳过这一张继续，最后靠兜底定时器收尾
                try {
                    const node = createCardNode(p.cards[i], s === 0);
                    node.parent = this.layerHand;
                    node.setPosition(center);
                    node.scale = 0.4;
                    const target = this.handPos(s, i, n);
                    cc.tween(node)
                        .delay(delay)
                        .to(0.18, { position: target, scale: s === 0 ? 1 : 0.55 })
                        .call(() => {
                            count++;
                            if (count >= total) finish();
                        })
                        .start();
                } catch (err) {
                    cc.error('[乌龟4] 发牌绘制异常（已跳过该张）: ' + err);
                    count++;
                }
                delay += 0.01;
            }
        }
        if (total === 0) { finish(); return; }
        // 兜底：tween 万一被打断，count 到不了 total，这里保证流程一定能往下走
        this.scheduleOnce(finish, delay + 0.18 + 1.5);
    }

    /** 手牌第 i 张的位置 */
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

    // ================= 渲染 =================

    private refreshAll(): void {
        this.announceReveal();
        this.updateRole();       // 身份标签实时刷新，不只在发牌时算一次
        this.refreshHand();
        this.refreshOpponents();
        this.refreshSeats();
        this.refreshStatus();
    }

    /** 敌人身份暴露时播报一次 */
    private announceReveal(): void {
        if (this.engine.enemyRevealed && !this.revealedAnnounced) {
            this.revealedAnnounced = true;
            const enemy = this.engine.enemySeat;
            if (enemy !== 0) {
                this.flash(`${SEAT_NAME[enemy]} 是敌人（方块4暴露）！接下来他领出必须带方块4`, 3.2);
            } else {
                this.flash('你的身份已暴露！领出时必须打出含方块4的牌型', 3.2);
            }
        }
    }

    private refreshHand(): void {
        this.layerHand.removeAllChildren();
        const me = this.engine.players[0];
        const n = me.cards.length;
        const e = this.engine;
        const inExchange = e.phase === Phase.EXCHANGE && e.currentExchange !== null
            && e.currentExchange.from === 0;
        // 当前步骤允许点选的牌（交牌阶段用来区分"能点"和"点了也没用"）
        const allow: Set<number> = inExchange
            ? new Set(e.selectableCards(0).map((c) => c.id))
            : new Set<number>();

        for (let i = 0; i < n; i++) {
            const card = me.cards[i];
            const node = createCardNode(card, true);
            node.parent = this.layerHand;
            const pos = this.handPos(0, i, n);

            if (inExchange) {
                const picked = this.exchangeSelIds.indexOf(card.id) >= 0
                    || this.exchangeSelId === card.id;
                node.setPosition(pos.x, pos.y + (picked ? 24 : 0));
                // 不可选的牌压暗，玩家一眼就知道哪些能交
                if (!allow.has(card.id)) node.opacity = 110;
                else if (e.currentExchange!.kind === 'ENEMY_PUT' && !picked) {
                    // 敌人挑大牌时，把"候选那几张"描一下金边，降低误点
                    node.opacity = 255;
                }
            } else {
                const picked = this.selected.has(card.id);
                node.setPosition(pos.x, pos.y + (picked ? 22 : 0));
            }

            node.on(cc.Node.EventType.TOUCH_END, () => this.onCardTap(card));
        }
    }

    private onCardTap(card: Card): void {
        const ph = this.engine.phase;

        if (ph === Phase.EXCHANGE) {
            this.onExchangePick(card);
            return;
        }
        if (ph !== Phase.PLAYING) return;
        if (this.engine.currentSeat !== 0 || this.busy || this.playLock) return;
        if (!this.passTapThrottle()) return;

        if (this.selected.has(card.id)) this.selected.delete(card.id);
        else this.selected.add(card.id);
        this.refreshHand();
    }

    /**
     * 点击节流：手机上一次触摸常被识别成多次 TOUCH_END，
     * 也常有玩家习惯连点。这个时间窗内的重复触发直接忽略。
     * 返回 true 表示这次点击有效，可以继续处理。
     */
    private passTapThrottle(): boolean {
        const now = cc.director.getTotalTime() / 1000;
        if (now - this.lastTapTime < GameScene.TAP_THROTTLE) return false;
        this.lastTapTime = now;
        return true;
    }

    private refreshOpponents(): void {
        this.layerOpp.removeAllChildren();
        for (let s = 1; s < SEAT_COUNT; s++) {
            const p = this.engine.players[s];
            const n = p.cards.length;
            for (let i = 0; i < n; i++) {
                const node = createCardNode(null, false);
                node.parent = this.layerOpp;
                node.scale = 0.55;
                const pos = this.handPos(s, i, n);
                node.setPosition(pos.x, pos.y);
            }
        }
    }

    /** 每家头像框 + 剩余张数 + 身份/名次标记 */
    private refreshSeats(): void {
        this.layerSeat.removeAllChildren();
        const e = this.engine;

        for (let s = 0; s < SEAT_COUNT; s++) {
            const p = e.players[s];
            const a = SEAT_ANCHOR[s];
            const boxW = 128;
            const boxH = 54;

            // 自己的信息框放在左下角，避开底部按钮区（按钮在 y=-314，高 58）
            let bx = a.x;
            let by = a.y;
            if (s === 0) { bx = -420; by = -H / 2 + 150; }
            else if (s === 1) { bx = a.x - 24; by = -150; }
            else if (s === 2) { bx = 0; by = H / 2 - 130; }
            else { bx = a.x + 24; by = -150; }

            const box = new cc.Node('seat' + s);
            box.parent = this.layerSeat;
            box.setPosition(bx, by);
            box.setContentSize(boxW, boxH);

            const g = box.addComponent(cc.Graphics);
            g.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, 10);
            const isTurn = e.phase === Phase.PLAYING && e.currentSeat === s;
            g.fillColor = isTurn ? cc.color(70, 132, 92, 235) : cc.color(12, 30, 24, 200);
            g.fill();
            g.strokeColor = isTurn ? cc.color(255, 220, 120) : cc.color(70, 110, 92);
            g.lineWidth = isTurn ? 3 : 1;
            g.stroke();

            // 名字
            const nameTxt = SEAT_NAME[s];
            const nm = createLabel(nameTxt, 17, cc.color(220, 235, 220), -boxW / 2 + 10, 12);
            nm.parent = box;
            nm.setAnchorPoint(0, 0.5);
            nm.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.LEFT;

            // 剩余张数（大字，实时跟随手牌变化）
            const left = p.cards.length;
            const cnt = createLabel(`${left} 张`, 22,
                left === 0 ? cc.color(150, 160, 155) : cc.color(255, 225, 140),
                -boxW / 2 + 10, -11);
            cnt.parent = box;
            cnt.setAnchorPoint(0, 0.5);
            cnt.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.LEFT;

            // 出完了 / 名次 / 被抓走
            let tag = '';
            if (p.finished) {
                tag = p.isEnemy ? '已出完' : (RANK_NAME[p.rank] || '游客');
            } else if (!p.isEnemy
                && (e.phase === Phase.ROUND_END || e.phase === Phase.ROUND_WAIT)) {
                // 局末还没出完的乌龟 = 被敌人抓走
                tag = '被抓龟';
            }
            if (tag) {
                const tn = createLabel(tag, 16, cc.color(140, 230, 160), boxW / 2 - 8, 0);
                tn.parent = box;
                tn.setAnchorPoint(1, 0.5);
                tn.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.RIGHT;
            }

            // 自己身份的角标（敌人/乌龟在每局结束时才公开，这里只标自己）
            if (s === 0) {
                const isEnemy = p.isEnemy;
                const idNode = createLabel(isEnemy ? '敌人' : '乌龟', 15,
                    isEnemy ? cc.color(255, 140, 120) : cc.color(150, 220, 170), boxW / 2 - 8, -16);
                idNode.parent = box;
                idNode.setAnchorPoint(1, 0.5);
                idNode.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.RIGHT;
            }
        }
    }

    private refreshStatus(): void {
        const e = this.engine;
        let t = '';
        let hint = '';

        if (e.phase === Phase.PLAYING) {
            t = e.currentSeat === 0 ? '轮到你出牌' : `${SEAT_NAME[e.currentSeat]} 思考中…`;
            if (e.lastPattern) {
                hint = `上家：${e.lastPattern.name} ${e.lastPattern.cards.map((c) => c.name).join(' ')}`;
            } else if (e.enemyRevealed && e.currentSeat === e.enemySeat) {
                hint = e.enemySeat === 0
                    ? '你已暴露：必须打出含方块4的牌型'
                    : `${SEAT_NAME[e.enemySeat]} 已暴露，领出必须带方块4`;
            } else {
                hint = '本轮由你领出，任意出牌';
            }
        } else if (e.phase === Phase.EXCHANGE) {
            t = '开局交牌';
            const step = e.currentExchange;
            if (step && step.from === 0) {
                // 具体文案由 refreshExchangeHint 写入 hintOverride，这里给兜底
                const rw = this.exchangeRoleText(step);
                if (step.kind === 'ENEMY_PUT') hint = `你是敌人：点选最大的 ${step.count} 张，再点「交到桌上」`;
                else if (step.kind === 'TOURIST_PICK') hint = `你是${rw}：点桌上的一张，再点「拿牌」`;
                else if (step.kind === 'TOURIST_RETURN') hint = `你是${rw}：挑一张牌还回去，再点「还牌」`;
                else if (step.kind === 'LOSER_GIVE') hint = '你是被抓龟：点最大的一张，再点「交出大牌」';
                else if (step.kind === 'LOSER_PICK') hint = '你是被抓龟：点桌上的一张小牌，再点「拿牌」';
                else hint = '你是敌人：点选小牌摆到桌上，再点「还牌」';
            } else {
                hint = '其他玩家正在交牌…';
            }
        } else if (e.phase === Phase.ROUND_END) {
            t = '本局结束';
        } else if (e.phase === Phase.ROUND_WAIT) {
            t = '等待开局';
            hint = '正在等待其他玩家进入房间...';
        }

        if (this.hintOverride) { hint = this.hintOverride; }

        this.lblStatus.string = t;
        this.lblHint.string = hint;

        // 自己剩余张数
        this.lblMyCount.string = `剩 ${e.players[0].cards.length} 张`;

        // 按钮状态
        const ph = e.phase;
        const myTurn = ph === Phase.PLAYING && e.currentSeat === 0 && !this.busy;
        const step = e.currentExchange;
        const exchanging = ph === Phase.EXCHANGE && step !== null && step.from === 0;
        /*
         * 交牌记录还在播放时（exchangeBusy），引擎可能已经切到 PLAYING，
         * 但桌面动画没播完前绝不能出牌——否则出牌链和交牌动画链交叉，
         * 轻则桌面牌显示错乱，重则两条链互相等待直接卡死。
         */
        const canAct = ph === Phase.PLAYING && !this.exchangeBusy;

        this.show(this.btnPlay, canAct);
        this.show(this.btnPass, canAct);
        this.show(this.btnHint, canAct);

        // 交牌阶段：ENEMY_PUT 用左边「交到桌上」，其余步骤用右边「拿牌/还牌」
        this.show(this.btnExchange, exchanging && step!.kind === 'ENEMY_PUT');
        this.show(this.btnPick, exchanging && step!.kind !== 'ENEMY_PUT');

        this.btnPlay.opacity = myTurn ? 255 : 110;
        this.btnPass.opacity = (myTurn && e.lastPattern !== null) ? 255 : 110;
        this.btnHint.opacity = myTurn ? 255 : 110;

        if (exchanging) {
            const k = step!.kind;
            // 提交锁生效期间，按钮统一压暗到 90，视觉上告诉玩家"已经点到了，别连点"
            const locked = this.exchangeLock;
            if (k === 'ENEMY_PUT') {
                const n = this.exchangeSelIds.length;
                const need = step!.count;
                setButtonText(this.btnExchange, n > 0 ? `交到桌上(${n}/${need})` : '交到桌上');
                this.btnExchange.opacity = locked ? 90 : (n === need ? 255 : 120);
            } else if (k === 'ENEMY_RETURN') {
                // 和交大牌完全对称：多选 N 张一起摆到桌中间，按钮显示已选张数
                const n = this.exchangeSelIds.length;
                const need = step!.count;
                setButtonText(this.btnPick, locked ? '处理中…'
                    : (n > 0 ? `还牌(${n}/${need})` : '还牌'));
                this.btnPick.opacity = locked ? 90 : (n === need ? 255 : 120);
            } else {
                const word = (k === 'TOURIST_PICK' || k === 'LOSER_PICK') ? '拿牌'
                    : (k === 'LOSER_GIVE' ? '交出大牌' : '还牌');
                setButtonText(this.btnPick, locked ? '处理中…' : word);
                const ready = k === 'LOSER_GIVE' || this.exchangeSelId > 0;
                this.btnPick.opacity = locked ? 90 : (ready ? 255 : 120);
            }
        }
    }

    private show(n: cc.Node, v: boolean): void {
        if (n && n.active !== v) n.active = v;
    }

    private updateRole(): void {
        const me = this.engine.players[0];
        const isEnemy = me.cards.some((c) => c.id === DIAMOND_4_ID);
        this.lblRole.string = isEnemy ? '你的身份：敌人（方块4）' : '你的身份：乌龟';
    }

    // ================= 出牌区 =================

    /**
     * 把一手牌放到某座位面前。
     * 如果该座位之前已经出过牌（即上一圈遗留），先清掉。
     */
    private showPlayed(seat: number, cards: Card[], clearOtherSeats = false): void {
        this.clearPlayed(seat, clearOtherSeats);
        const pos = PLAY_POS[seat];
        const gap = 30;
        const totalW = gap * (cards.length - 1);

        // 同一个座位这一圈的牌：先清掉它自己之前的（跟牌时替换）
        for (const child of this.layerTable.children.slice()) {
            if (child.name.indexOf(`p${seat}_`) === 0) {
                cc.tween(child).to(0.1, { opacity: 0 }).call(() => { if (child.isValid) child.destroy(); }).start();
            }
        }

        for (let i = 0; i < cards.length; i++) {
            const node = createCardNode(cards[i], true);
            node.name = `p${seat}_${i}`;
            node.parent = this.layerTable;
            /*
             * 起点改成「出牌者自己的手牌位置」，而不是台桌中心——
             * 视觉上就是：牌从他的手里飞出来，落到他面前的出牌区。
             * 之前从中心向四方飞，看起来像"牌从桌子底下冒出来"，方向感是反的。
             */
            const anchor = SEAT_ANCHOR[seat];
            const start = cc.v3(anchor.x, anchor.y, 0);
            node.setPosition(start);
            node.opacity = 0;
            node.scale = 0.62;              // 从手里"抽出来"：起点略小
            const tx = pos.x - totalW / 2 + i * gap;
            const ty = pos.y;
            cc.tween(node)
                .to(0.22, { position: cc.v3(tx, ty, 0), opacity: 255, scale: 0.8 })
                .start();
        }
        this.tableOwner[seat] = this.trickIndex;
    }

    /** 清掉指定座位的出牌 */
    private clearPlayed(seat: number, clearOther = true): void {
        for (const child of this.layerTable.children.slice()) {
            const m = /^p(\d)_/.exec(child.name);
            if (!m) continue;
            const s = parseInt(m[1], 10);
            if (s === seat || clearOther) {
                cc.tween(child).to(0.12, { opacity: 0 }).call(() => { if (child.isValid) child.destroy(); }).start();
            }
        }
        this.tableOwner[seat] = -1;
    }

    /**
     * 新一轮开始（有人领出新的牌）：把上一圈所有人的牌全部清掉。
     * 对应需求「玩家出牌一圈之后轮到自己后，上一次出的牌要在玩家面前消失」。
     */
    private clearTableForNewTrick(): void {
        for (const child of this.layerTable.children.slice()) {
            if (/^p\d_/.test(child.name)) {
                cc.tween(child).to(0.15, { opacity: 0 }).call(() => { if (child && child.isValid) child.destroy(); }).start();
            }
        }
        this.tableOwner = [-1, -1, -1, -1];
    }

    // ================= 出牌交互 =================

    private onPlayClick(): void {
        const e = this.engine;
        if (this.playLock) return;
        if (this.exchangeBusy) return;   // 交牌动画没播完不许出牌（防两条链交叉卡死）
        if (e.phase !== Phase.PLAYING || e.currentSeat !== 0 || this.busy) return;
        if (!this.passTapThrottle()) return;
        const me = e.players[0];
        const picked = me.cards.filter((c) => this.selected.has(c.id));
        if (picked.length === 0) { this.flash('请先点击选择要出的牌'); return; }

        // 上锁 + 立刻清空选择：连点时第二次进来 selected 已空，会被上面的判断挡住
        this.playLock = true;
        this.selected.clear();

        /*
         * 整体 try/finally：出牌之后的任何一步（清桌、飘字、刷新）只要抛一次异常，
         * playLock 就会永远停在 true → 出牌按钮永久锁死，整个界面就不动了。
         * 所以解锁放在 finally，保证无论发生什么都能恢复可操作。
         */
        let needCheckTurn = true;
        try {
            const wasFree = e.lastPattern === null;
            const ok = e.playCards(0, picked);
            if (!ok) {
                picked.forEach((c) => this.selected.add(c.id));  // 出失败还原选择
                this.flash(e.enemyRevealed && wasFree && !picked.some((c) => c.id === DIAMOND_4_ID)
                    ? '你已暴露，领出必须包含方块4！'
                    : '这手牌不合法或压不过上家');
                this.refreshHand();
                needCheckTurn = false;
            } else {
                if (wasFree) this.clearTableForNewTrick();
                this.showPlayed(0, sortCards(picked));
                this.refreshAll();
                if (this.engine.phase === Phase.ROUND_END) {
                    needCheckTurn = false;
                    this.safeShowResult();
                }
            }
        } catch (err) {
            cc.error('[乌龟4] 出牌处理异常（已恢复）: ' + err);
            needCheckTurn = true;
        } finally {
            this.playLock = false;
        }
        if (needCheckTurn) this.checkTurn();
    }

    private onPassClick(): void {
        const e = this.engine;
        if (this.playLock) return;
        if (this.exchangeBusy) return;   // 同上
        if (e.phase !== Phase.PLAYING || e.currentSeat !== 0 || this.busy) return;
        if (e.lastPattern === null) { this.flash('领出时不能跳过'); return; }
        if (!this.passTapThrottle()) return;

        // 同 onPlayClick：解锁放 finally，异常也不能让 playLock 永久残留
        this.playLock = true;
        try {
            const wasLast = e.lastPlaySeat;
            e.pass(0);
            this.selected.clear();
            // 跳过时把之前亮出的选择标记清掉
            this.showPlayedSkip(0);
            // 如果一圈结束（自己重新领出），清空全桌
            if (e.lastPattern === null && e.currentSeat === 0) {
                this.clearTableForNewTrick();
            } else if (wasLast >= 0 && e.lastPattern === null) {
                this.clearTableForNewTrick();
            }
            this.refreshAll();
        } catch (err) {
            cc.error('[乌龟4] 跳过处理异常（已恢复）: ' + err);
        } finally {
            this.playLock = false;
        }
        this.checkTurn();
    }

    /** 忽略该参数，占位（保留接口便于以后显示"要不起"气泡） */
    private showPlayedSkip(seat: number): void {
        // 在座位上方飘一个"要不起"
        const a = PLAY_POS[seat];
        const t = createLabel('要不起', 20, cc.color(210, 210, 210), a.x, a.y);
        t.parent = this.layerTable;
        t.opacity = 220;
        cc.tween(t).by(0.5, { position: cc.v3(0, 22, 0) }).to(0.3, { opacity: 0 })
            .call(() => { if (t.isValid) t.destroy(); }).start();
    }

    private onHintClick(): void {
        const e = this.engine;
        if (this.exchangeBusy) return;   // 同上
        if (e.phase !== Phase.PLAYING || e.currentSeat !== 0) return;
        const hand = e.players[0].cards;
        let best: Card[] | null = null;

        // 暴露后领出：提示含方块4的最小组合
        if (e.lastPattern === null && e.enemyRevealed && e.enemySeat === 0) {
            best = decideRevealLead(hand);
        } else if (e.lastPattern === null) {
            best = [sortCards(hand)[0]];
        } else {
            /*
             * 跟牌提示：与 AI 决策共用同一套逻辑（decidePlay）——
             * 先找同型里最小的能压的；5 张牌型同型压不过时，
             * 按等级从低到高用更高级牌型压（一条龙 > 4带1 > 三带二 > 顺子 > 同一花色）。
             */
            best = decidePlay(hand, e.lastPattern);
        }
        if (!best) { this.flash('没有能压过的牌，只能跳过'); return; }
        this.selected.clear();
        best.forEach((c) => this.selected.add(c.id));
        this.refreshHand();
        this.flash('已为你选中：' + best.map((c) => c.name).join(' '));
    }

    private flash(msg: string, seconds = 2.2): void {
        this.hintOverride = msg;
        this.refreshStatus();
        this.unschedule(this.clearFlash);
        this.scheduleOnce(this.clearFlash, seconds);
    }

    private clearFlash = (): void => {
        this.hintOverride = '';
        this.refreshStatus();
    };

    /** 驱动下一位（AI 自动 / 真人等待） */
    private checkTurn(): void {
        const e = this.engine;
        if (e.phase !== Phase.PLAYING) {
            if (e.phase === Phase.ROUND_END) this.safeShowResult();
            return;
        }
        if (e.currentSeat === 0) { this.refreshStatus(); return; }

        this.busy = true;
        this.refreshStatus();

        this.scheduleOnce(() => {
            /*
             * 这里必须整体兜住：AI 决策/出牌只要抛一次异常，
             * busy 就会永远停在 true → 出牌按钮永久不出现 → 整个界面卡死。
             * 所以业务逻辑放 try，状态复位放 finally，推进放 biz 之后。
             */
            let needResult = false;
            try {
                const seat = e.currentSeat;
                const wasFree = e.lastPattern === null;
                const act = e.aiAction();
                if (act.action === 'play' && act.cards && act.cards.length) {
                    e.playCards(seat, act.cards);
                    if (wasFree) this.clearTableForNewTrick();
                    this.showPlayed(seat, sortCards(act.cards));
                } else {
                    e.pass(seat);
                    this.showPlayedSkip(seat);
                    if (e.lastPattern === null) this.clearTableForNewTrick();
                }
                needResult = (e.phase === Phase.ROUND_END);
            } catch (err) {
                cc.error('[乌龟4] AI 出牌异常（已跳过）: ' + err);
                // 尽力把这一手推进掉，避免同桌局面停在 AI 身上
                try { e.pass(e.currentSeat); } catch (e2) { /* 忽略 */ }
                needResult = (e.phase === Phase.ROUND_END);
            } finally {
                this.busy = false;
            }
            try {
                this.refreshAll();
                if (needResult || e.phase === Phase.ROUND_END) { this.safeShowResult(); return; }
                this.checkTurn();
            } catch (err) {
                cc.error('[乌龟4] 刷新异常（已恢复）: ' + err);
                this.busy = false;
                // 已到局末就直接结算，不要再排定时器重试（否则会 抛异常→重试 无限循环）
                if (e.phase === Phase.ROUND_END) { this.safeShowResult(); return; }
                this.scheduleOnce(() => this.checkTurn(), 0.3);
            }
        }, 0.65);
    }

    // ================= 交牌阶段（桌上抢牌模型）=================

    /**
     * 交牌流程总驱动，所有入口（开局、点击提交、动画播完）都回到这里。
     *
     * 一局的完整顺序：
     *   ① ENEMY_PUT      敌人手动点选 N 张大牌，点「交到桌上」→ 牌落到桌子正中间
     *   ② TOURIST_PICK   导游 → 中游 → 尾游 依次从桌上点一张，点「拿牌」收进手里
     *   ③ TOURIST_RETURN 游客各自挑一张还给敌人（自己判断，不必最小；方块4 与刚换来的牌除外）
     *   ④ LOSER_GIVE     被抓龟点最大的一张，直接落到敌人手里
     *   ⑤ ENEMY_RETURN   敌人挑一张还给被抓龟
     * 全部走完后由「交出最大那张牌的人」先出牌。
     */
    private processExchange(): void {
        /*
         * 单链保护：整个交牌动画只允许「一条链」在推进 logPlayed。
         *
         * processExchange 有 6 个入口（发牌完毕、动画播完、两个按钮提交、
         * AI 推进、队列空兜底），入口一多就必然会并发：
         *   链 A 播第 5 条的同时链 B 也在重试第 5 条 → 两条链互相把
         *   logPlayed 推来推去，形成活锁（表现就是界面永远停住）。
         * exchangeChainAlive 保证任何时候只有一条链持有推进权。
         */
        if (this.exchangeChainAlive) return;
        this.exchangeChainAlive = true;
        const chain = ++this.exchangeChain;   // 新链代号，老链的回调看到代号不符会自行退出
        this.safeExchangeStep('processExchange', () => {
            this.processExchangeInner(chain);
        });
    }

    private processExchangeInner(chain: number): void {
        const e = this.engine;
        this.refreshAll();

        // 1) 先把还没播过动画的记录逐条播完（AI 一口气跑完的步骤也在这里补播）
        if (this.logPlayed < e.exchangeLog.length) {
            /*
             * 关键：开播之前先把桌面刷新一次。
             * 引擎在提交时就已经把牌放进 tableCards 了，如果等动画播完才刷新，
             * 玩家在这几秒里看到的是"牌没上台、界面不动"——就是那个"卡死"的观感。
             * 先刷新 → 桌子中间的牌立刻建出来；再播飞牌动画，落定时桌面这张淡入。
             */
            const group = this.collectTableGroup(this.logPlayed);
            const isPutGroup = group.length > 0
                && (group[0].kind === 'ENEMY_PUT' || group[0].kind === 'ENEMY_RETURN');
            if (isPutGroup) {
                // 飞牌落定的时刻 ≈ 停留 + 飞行；桌面牌此时淡入，避免与飞牌重影
                this.tableFadePending = true;
                this.tableFadeDelay = group.length > 1
                    ? this.batchFlyDelay(group[0].kind)
                    : this.singleFlyDelay(group[0].kind);
                this.tableCardsSig = '';   // 强制重建，才能应用上面的透明度
            } else {
                this.tableFadePending = false;
                this.tableFadeDelay = 0;
            }
            this.refreshExchangeTable();
            this.exchangeBusy = true;
            // 链的持有权交给动画：播完它会自己调 processExchange 继续
            this.playExchangeLog(this.logPlayed, chain);
            return;
        }

        this.exchangeBusy = false;
        this.exchangeChainAlive = false;   // 同步走到这里，这一轮链结束

        // 2) 交牌全部结束 → 收掉桌面流程条，播报先出牌权，进入出牌
        if (e.phase !== Phase.EXCHANGE) {
            this.exchangeSelId = -1;
            this.exchangeSelIds = [];
            this.hintOverride = '';      // 清掉交牌提示，别让它残留到出牌阶段
            this.exchangeLock = false;   // 交牌整体结束，提交锁必须解开
            this.refreshExchangeTable();
            this.fadeExchangeBanner();
            this.clearFlyingCards();
            this.refreshAll();
            this.announceFirstLead();
            this.checkTurn();
            return;
        }

        const step = e.currentExchange;
        if (!step) {
            // 队列空了但引擎还停在 EXCHANGE：兜底推进一次
            this.exchangeChainAlive = true;
            this.scheduleOnce(() => {
                this.exchangeChainAlive = false;
                e.advanceExchange();
                this.processExchange();
            }, 0.1);
            return;
        }

        // 3) 轮到真人操作：链在这里结束，等玩家点按钮后由按钮入口重新起步
        if (step.from === 0) {
            /*
             * 关键修复：这里必须解开提交锁。
             * 场景：玩家提交「拿牌」时 exchangeLock = true → 动画播完 →
             * 链推进到下一步又是真人步骤（比如「还牌」）→ 走到这里。
             * 如果不解锁，按钮永远显示「处理中…」，玩家被锁在这一步之外。
             * 能走到这里说明：动画全部播完（logPlayed == length）、
             * 引擎正停在等真人输入 —— 此时解锁是安全的。
             */
            this.exchangeLock = false;
            this.refreshExchangeTable();
            this.refreshExchangeHint(step);
            this.refreshAll();
            return;
        }

        // 4) AI 步骤：稍等一下再推进，同时把"他要干什么"提前播报出来，
        //    否则 AI 一步做完就只剩交换记录动画，看不出他在挑什么
        this.exchangeBusy = true;
        this.exchangeChainAlive = true;
        this.refreshExchangeTable();
        this.announceAiStep(step);
        this.scheduleOnce(() => {
            this.exchangeChainAlive = false;
            this.exchangeBusy = false;
            e.advanceExchange();
            this.processExchange();
        }, 0.55);
    }

    /** AI 即将做的这一步，用一句话说清楚（配合后面的飞牌动画） */
    private announceAiStep(step: ExchangeStep): void {
        const who = SEAT_NAME[step.from];
        const rankTag = step.rank ? `（${RANK_NAME[step.rank]}）` : '';
        let text: string;
        if (step.kind === 'ENEMY_PUT') {
            text = `敌人 ${who} 正在挑最大的 ${step.count} 张摆到桌上…`;
        } else if (step.kind === 'TOURIST_PICK') {
            text = `${who}${rankTag} 正在挑桌上的一张…`;
        } else if (step.kind === 'TOURIST_RETURN') {
            text = `${who}${rankTag} 正在挑一张还给敌人…`;
        } else if (step.kind === 'LOSER_GIVE') {
            text = `被抓龟 ${who} 正在挑最大的一张交给敌人…`;
        } else if (step.kind === 'LOSER_PICK') {
            text = `被抓龟 ${who} 正在从桌上挑一张小牌…`;
        } else if (step.kind === 'ENEMY_RETURN') {
            text = `敌人 ${who} 正在挑 ${step.count} 张小牌摆到桌上…`;
        } else {
            text = `敌人 ${who} 正在挑一张还给${SEAT_NAME[step.to]}…`;
        }
        this.flash(text, 1.6);
    }

    /** 真人步骤的提示文案（放在顶部提示条） */
    private refreshExchangeHint(step: ExchangeStep): void {
        const e = this.engine;
        const rankWord = this.exchangeRoleText(step);
        if (step.kind === 'ENEMY_PUT') {
            const names = e.bestPutCards(0, step.count).map((c) => c.name).join('、');
            this.hintOverride = `你是敌人：点选最大的 ${step.count} 张（${names}），再点「交到桌上」`;
        } else if (step.kind === 'ENEMY_RETURN') {
            const names = e.pendingGiveCards().map((c) => c.name).join('、');
            this.hintOverride = `你是敌人：点选 ${step.count} 张小牌（建议 ${names}）摆到桌子中间，再点「还牌」`;
        } else if (step.kind === 'TOURIST_PICK') {
            this.hintOverride = `你是${rankWord}：点桌上任意一张大牌，再点「拿牌」`;
        } else if (step.kind === 'TOURIST_RETURN') {
            this.hintOverride = `你是${rankWord}：挑一张手上的牌还给敌人，再点「还牌」`;
        } else if (step.kind === 'LOSER_GIVE') {
            const big = e.pendingGiveCards()[0];
            this.hintOverride = `你是被抓龟：点最大的一张（${big ? big.name : '?'}）交给敌人，再点「交出大牌」`;
        } else if (step.kind === 'LOSER_PICK') {
            const who = this.loserRankText();
            this.hintOverride = `你是被抓龟：你交的牌排第 ${who} 位挑，点桌上一张小牌，再点「拿牌」`;
        } else {
            this.hintOverride = '请按提示操作';
        }
        this.refreshStatus();
    }

    /** 自己在这轮「挑小牌」里排第几（1 = 交的牌最大，最先挑） */
    private loserRankText(): string {
        const idx = this.engine.loserPickOrder.indexOf(0);
        return idx < 0 ? '?' : String(idx + 1);
    }

    /** 当前真人步骤对应的身份说法（导游/中游/尾游/被抓龟/敌人） */
    private exchangeRoleText(step: ExchangeStep): string {
        if (this.engine.enemySeat === 0) return '敌人';
        if (step.rank) return RANK_NAME[step.rank] || '乌龟';
        const r = this.engine.lastResult;
        if (!r) return '乌龟';
        const rank = turtleRankOf(r, 0);
        return RANK_NAME[rank] || '乌龟';
    }

    // ---------- 桌子正中间的大牌 ----------

    /** 最近一次重建桌面牌的内容签名，内容没变就不重建（避免连点时反复销毁/重建产生重影） */
    private tableCardsSig = '';
    /**
     * 提前刷新桌面牌时用：飞牌还没落定前，桌面这张先透明、延后淡入。
     * 目的是消除「提前刷新」与「飞牌动画」叠加造成的重影，
     * 同时保证桌面在任何时刻都不是空白（用户看不到牌会以为卡死）。
     */
    private tableFadePending = false;
    private tableFadeDelay = 0;

    /**
     * 重画桌子正中间那几张「待认领的大牌」。
     * 只有 TOURIST_PICK 步骤且轮到真人时才能点。
     *
     * 这里做了"内容签名"判断：如果桌上的牌、选中状态、可点状态都没变，
     * 就直接返回，不销毁重建。因为节点上挂着浮动 tween，
     * 反复销毁重建会让同一张牌瞬间出现两个节点，看起来就是重影。
     */
    private refreshExchangeTable(): void {
        if (!this.nodeTableCards) return;

        const e = this.engine;
        const list = e.tableCards || [];
        const step = e.currentExchange;
        const canPick = e.phase === Phase.EXCHANGE && !!step
            && (step.kind === 'TOURIST_PICK' || step.kind === 'LOSER_PICK') && step.from === 0;

        // 内容签名：桌上牌 id 列表 + 选中项 + 是否可点
        const sig = list.map((c) => c.id).join(',')
            + '|' + this.exchangeSelId + '|' + (canPick ? 1 : 0);

        if (sig === this.tableCardsSig && this.nodeTableCards.children.length === list.length) {
            return;   // 没变化，什么都不做
        }
        this.tableCardsSig = sig;

        // 重建前先把旧节点上的无限循环 tween 停掉、off 掉点击事件。
        // 只 destroy 不停 tween 的话，repeatForever 会继续跑在已失效的节点上，
        // 轻则报错，重则在手机上留下残影。
        for (const old of this.nodeTableCards.children.slice()) {
            cc.Tween.stopAllByTarget(old);
            old.stopAllActions();
            old.off(cc.Node.EventType.TOUCH_END);
        }
        this.nodeTableCards.removeAllChildren();
        if (list.length === 0) return;

        // 桌上还剩几张 → 居中对齐
        const n = list.length;
        const totalW = TABLE_CARD_GAP * (n - 1);

        for (let i = 0; i < n; i++) {
            const card = list[i];
            const node = createCardNode(card, true);
            node.name = 'tb_' + card.id;
            node.parent = this.nodeTableCards;
            node.setPosition(-totalW / 2 + i * TABLE_CARD_GAP, TABLE_CARD_Y);

            const sel = this.exchangeSelId === card.id;
            const scale = canPick ? 1.05 : 0.9;
            node.scale = scale;
            node.y += sel ? 14 : 0;

            if (canPick) {
                // 可点的牌加一圈金边 + 轻微浮动，明确告诉玩家"这张能拿"
                this.addFloatGlow(node, true);
                node.on(cc.Node.EventType.TOUCH_END, () => this.onTableCardTap(card));
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
            // 若这批牌对应的飞牌动画还没播完，先让桌面这张透明，
            // 等飞牌落定（动画结束）时再淡入 —— 既不"牌没上台"，也不重影
            if (this.tableFadePending) {
                node.opacity = 0;
                cc.tween(node).delay(this.tableFadeDelay).to(0.18, { opacity: 235 }).start();
            }
        }
    }

    /** 给节点套一层发光描边（纯代码，用同尺寸 Graphics 叠在背后） */
    private addFloatGlow(node: cc.Node, gold: boolean): void {
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

    private onTableCardTap(card: Card): void {
        const e = this.engine;
        const step = e.currentExchange;
        if (!step || (step.kind !== 'TOURIST_PICK' && step.kind !== 'LOSER_PICK') || step.from !== 0) return;
        // 提交锁 / 动画播放中，一律不收点击
        if (this.exchangeLock || this.exchangeBusy) return;
        if (this.exchangeSelId === card.id) return; // 已经选中，等按钮
        if (!this.passTapThrottle()) return;

        this.exchangeSelId = card.id;
        this.exchangeSelIds = [card.id];
        this.refreshExchangeTable();
        this.refreshStatus();
    }

    // ---------- 交牌记录动画 ----------

    /** 是否有一条交换动画正在播放（防止同一批记录被并行播两遍，那是重影的另一种来源） */
    private flyingRecord = false;

    /**
     * 交牌推进链是否还「活着」（正持有推进权：在播动画 / 在等 AI 计时器）。
     * true 时任何新的 processExchange 调用都会被忽略，保证只有一条链在改写 logPlayed。
     */
    private exchangeChainAlive = false;
    /** 链代号：每次重新起步 +1，老链的延时/动画回调看到代号不符就直接放弃 */
    private exchangeChain = 0;

    /**
     * 交牌看门狗：记录上一次「有进展」的时刻与当时的 logPlayed。
     * 万一某个回调因为极端情况（节点被销毁、tween 被打断）没能回来，
     * 链会永远挂在 exchangeChainAlive 上 → 界面锁死。
     * 看门狗负责在长时间无进展时强行解开并重新推进。
     */
    private exchangeWatchTime = 0;
    private exchangeWatchLog = -1;
    /** 多久没有任何进展就认为链卡死（秒）。正常一步最长约 6 秒（摆 3 张），留 3 秒余量。 */
    private static readonly EXCHANGE_WATCHDOG = 9;
    /** 出牌阶段 busy 持续多久算卡死（秒）。AI 一手正常 0.65 秒。 */
    private static readonly PLAY_WATCHDOG = 6;
    /** 等待开局最长等多久（秒）。正常 onStayInRoom 是 1.8 秒后开局。 */
    private static readonly WAIT_WATCHDOG = 4;
    /** 出牌阶段 busy 的累计秒数 */
    private playWatchTime = 0;
    /** 等待开局的累计秒数 */
    private waitWatchTime = 0;
    /** 本局结算面板是否已经尝试过（防止异常时反复重试导致死循环） */
    private resultShown = false;

    /**
     * 交牌动画链的安全网：回调里任何一步抛异常（比如某条记录的数据不合法），
     * 都不能让整条链死掉——死掉的表现就是"停在这个界面不动了"。
     * 出错时打日志、复位标志，并把推进权交还出去让流程继续。
     */
    private safeExchangeStep(stepName: string, fn: () => void): void {
        try {
            fn();
        } catch (err) {
            cc.error('[乌龟4] 交牌流程异常（已跳过并继续）: ' + stepName + ' :: ' + err);
            this.flyingRecord = false;
            this.exchangeBusy = false;
            this.exchangeLock = false;
            this.exchangeChainAlive = false;
            // 异常兜底：跳过当前这条记录，绝不允许原地重播（原地重播 = 死循环）
            if (this.logPlayed < this.engine.exchangeLog.length) this.logPlayed++;
            this.scheduleOnce(() => this.processExchange(), 0.05);
        }
    }

    /**
     * 播放交牌记录。播完自动把推进权交回 processExchange，不再依赖外部 done 回调
     * （原先的 done 回调写在异常保护外面，一旦回调抛异常 logPlayed 不前进，
     *   就会用同一个 fromIdx 原地重播，形成永远推进不了的死循环）。
     */
    private playExchangeLog(fromIdx: number, chain: number): void {
        // 老链作废：新链已经接管，这一条不要再播，否则会重影并抢改 logPlayed
        if (chain !== this.exchangeChain) return;
        // 看门狗喂食：链还活着就有进展记录
        if (this.exchangeWatchLog !== this.logPlayed) {
            this.exchangeWatchLog = this.logPlayed;
            this.exchangeWatchTime = 0;
        }

        const e = this.engine;
        if (fromIdx >= e.exchangeLog.length) {
            this.finishLogChain();
            return;
        }
        // 已经有一条在飞：让出一个回合再来（这条路径同样靠链代号兜底，不会无限积累）
        if (this.flyingRecord) {
            this.scheduleOnce(() => this.playExchangeLog(fromIdx, chain), 0.2);
            return;
        }

        /*
         * 「敌人一次摆 N 张上桌」必须当成一组播，不能逐张串行播。
         * 逐张播的后果：3 张牌要 3×5.2 = 15.6 秒，
         * 这 15.6 秒里 exchangeBusy 一直为 true、桌面也一张牌都不显示
         * → 玩家看到的就是"牌没上台、别人也不选牌、界面不动了"。
         * 合并成一组后：N 张牌同时飞落桌子中间，一次刷新，一次进入下一步。
         */
        const group = this.collectTableGroup(fromIdx);
        if (group.length > 1) {
            this.flyingRecord = true;
            this.playOneExchangeBatch(group, () => {
                this.advanceLogPlayed(fromIdx, group.length, group[group.length - 1]);
                this.finishLogChain();
            });
            return;
        }

        const rec = e.exchangeLog[fromIdx];
        this.flyingRecord = true;
        this.playOneExchange(rec, () => {
            this.advanceLogPlayed(fromIdx, 1, rec);
            this.finishLogChain();
        });
    }

    /**
     * 一条（或一组）记录播完：推进 logPlayed 并刷新。
     * 无论内部是否抛异常，logPlayed 都必须**严格前进**——
     * 这是防"原地重播死循环"的最后一道硬保险。
     */
    private advanceLogPlayed(fromIdx: number, count: number, last: ExchangeRecord): void {
        this.safeExchangeStep('advance-' + fromIdx, () => {
            this.flyingRecord = false;
            this.lastPlayedRec = last;
            this.refreshExchangeTable();
            this.refreshAll();
        });
        // 放在 try/catch 外面：上面无论成功失败都要推进，绝不停在原地
        this.flyingRecord = false;
        if (this.logPlayed <= fromIdx) this.logPlayed = fromIdx + count;
    }

    /** 本批记录播完，把推进权交回给 processExchange */
    private finishLogChain(): void {
        this.exchangeBusy = false;
        this.tableFadePending = false;
        this.tableFadeDelay = 0;
        this.exchangeChainAlive = false;
        this.processExchange();
    }

    /**
     * 从 fromIdx 开始，收集「同一次摆到桌上」的连续记录。
     * 只合并紧挨着的同一个人、同一种「摆上桌」记录（ENEMY_PUT / ENEMY_RETURN），
     * 其它记录（游客拿走、还牌给敌人）一律保持逐条播放，节奏不变。
     */
    private collectTableGroup(fromIdx: number): ExchangeRecord[] {
        const log = this.engine.exchangeLog;
        const first = log[fromIdx];
        if (!first) return [];
        const isPut = first.kind === 'ENEMY_PUT' || first.kind === 'ENEMY_RETURN';
        if (!isPut) return [first];   // 非摆牌记录：不合并
        const out: ExchangeRecord[] = [];
        for (let i = fromIdx; i < log.length; i++) {
            const r = log[i];
            if (r.kind !== first.kind || r.from !== first.from || r.to !== -1) break;
            out.push(r);
        }
        return out;
    }

    /**
     * 一次把 N 张牌同时摆到桌子上（敌人摆大牌 / 摆小牌共用）。
     *
     * 和 playOneExchange 的区别：
     *   - 所有牌一起飞、一起落，落点按桌面 N 张牌的实际排布位置摆放，
     *     这样玩家在动画结束的瞬间就看到"桌上整整齐齐 N 张"
     *   - 总时长只算一次（取单张的节奏），不做 N 倍叠加
     */
    private playOneExchangeBatch(recs: ExchangeRecord[], onDone: () => void): void {
        if (recs.length === 0) { onDone(); return; }
        const first = recs[0];
        const isBig = first.kind === 'ENEMY_PUT';
        const n = recs.length;
        const fromPos = this.seatNodePos(first.from);

        // 落点：与 refreshExchangeTable 用同一套排布，保证动画落点和最终位置重合
        const gap = TABLE_CARD_GAP;
        const totalW = gap * (n - 1);

        const holdMs = (isBig ? 1.2 : 0.9) * EXCHANGE_SPEED;
        const flyMs = (isBig ? 2.0 : 1.6) * EXCHANGE_SPEED;
        const restMs = TABLE_WAIT_SEC;

        // 流程条：一次说清"一次摆了几张"
        this.showBatchBanner(first, n);

        const names: string[] = [];
        for (let i = 0; i < n; i++) {
            const rec = recs[i];
            names.push(rec.card.name);
            const tx = -totalW / 2 + i * gap;
            const ty = TABLE_CARD_Y;

            const node = createCardNode(rec.card, true);
            node.name = 'fly_' + rec.index + '_' + rec.card.id;
            node.parent = this.layerTable;
            node.zIndex = 200;
            node.scale = isBig ? 0.9 : 0.75;
            node.setPosition(fromPos.x, fromPos.y);
            node.opacity = 0;

            const midX = (fromPos.x + tx) / 2;
            const midY = (fromPos.y + ty) / 2 + 70;
            const flyFrom = isBig ? 1.45 : 1.2;
            const endScale = 1.05;

            // 每张牌错开一点点出发时间，看起来像"依次拍下去"，但总时长几乎不变
            const stagger = i * 0.12;

            cc.tween(node)
                .delay(stagger)
                .to(0.18, { opacity: 255, scale: flyFrom })
                .delay(holdMs)
                .to(flyMs * 0.35, { position: cc.v3(midX, midY, 0), scale: (flyFrom + endScale) / 2 })
                .to(flyMs * 0.65, { position: cc.v3(tx, ty, 0), scale: endScale })
                .delay(restMs)
                .to(0.2, { opacity: 0, scale: 0.9 })
                .call(() => { if (node && node.isValid) node.destroy(); })
                .start();
        }

        // 给出方旁边：一句话列出这次摆出的所有牌，不逐张飘字（避免字叠在一起）
        this.popSeatTip(first.from, `摆出 ${names.join('、')}`,
            isBig ? cc.color(255, 214, 110) : cc.color(190, 210, 200),
            isBig ? 26 : 22, true, 0.5 + holdMs + flyMs * 0.3);

        this.scheduleOnce(() => {
            this.popTipAt(0, TABLE_CARD_Y + 76, n > 1 ? `${n} 张牌摆到桌子中间` : '摆到桌子中间',
                cc.color(255, 226, 140), 22, TABLE_WAIT_SEC);
        }, holdMs + flyMs);

        const total = (0.18 + holdMs + flyMs + restMs + 0.2 + 0.3) * 1 + (n - 1) * 0.12;
        this.scheduleOnce(onDone, total);
    }

    /** 批量摆牌时，飞牌"落定到桌面位置"的时刻（秒）——桌面那张牌从这一刻开始淡入 */
    private batchFlyDelay(kind: string): number {
        const isBig = kind === 'ENEMY_PUT';
        const holdMs = (isBig ? 1.2 : 0.9) * EXCHANGE_SPEED;
        const flyMs = (isBig ? 2.0 : 1.6) * EXCHANGE_SPEED;
        return 0.2 + holdMs + flyMs;
    }

    /** 单张摆牌（playOneExchange 的落桌路径）时，飞牌落定的时刻 */
    private singleFlyDelay(kind: string): number {
        const isBig = kind === 'ENEMY_PUT' || kind === 'LOSER_GIVE';
        const holdMs = (isBig ? 1.4 : 1.1) * EXCHANGE_SPEED;
        const flyMs = (isBig ? 2.4 : 1.9) * EXCHANGE_SPEED;
        return 0.2 + holdMs + flyMs;
    }

    /** 批量摆牌时的流程条 */
    private showBatchBanner(rec: ExchangeRecord, n: number): void {
        const old = this.layerTable.getChildByName('ex_banner');
        if (old && old.isValid) old.destroy();

        const who = SEAT_NAME[rec.from];
        const isBig = rec.kind === 'ENEMY_PUT';
        const text = isBig
            ? `${who} 把 ${n} 张最大的牌摆到桌子中间`
            : `${who} 把 ${n} 张小牌摆到桌上（等被抓龟挑）`;

        const node = new cc.Node('ex_banner');
        node.parent = this.layerTable;
        node.zIndex = 205;
        node.setPosition(0, 6);
        const w = 520;
        const h = 54;
        const g = node.addComponent(cc.Graphics);
        g.roundRect(-w / 2, -h / 2, w, h, 12);
        g.fillColor = isBig ? cc.color(58, 44, 16, 235) : cc.color(14, 34, 26, 225);
        g.fill();
        g.strokeColor = isBig ? cc.color(255, 214, 110) : cc.color(90, 150, 120);
        g.lineWidth = isBig ? 3 : 1.5;
        g.stroke();

        const t = createLabel(text, isBig ? 24 : 20,
            isBig ? cc.color(255, 226, 140) : cc.color(200, 225, 210), 0, 0);
        t.parent = node;
        t.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        node.opacity = 0;
        cc.tween(node).to(0.15, { opacity: 255 }).start();
        cc.tween(node).delay(8).to(0.5, { opacity: 0 })
            .call(() => { if (node && node.isValid) node.destroy(); }).start();
    }

    /**
     * 播一步交换。节奏有意放慢，让人能看清是谁把哪张牌交给了谁：
     *   ① 牌在给出方旁边浮起并停留（大牌更久）—— 足够读清牌面
     *   ② 缓慢沿弧线飞向落点
     *   ③ 到达后停留，接收方旁飘「收到 X」
     */
    private playOneExchange(rec: ExchangeRecord, onDone: () => void): void {
        const toTable = rec.kind === 'ENEMY_PUT' || rec.kind === 'ENEMY_RETURN';
        const isBig = rec.kind === 'ENEMY_PUT' || rec.kind === 'LOSER_GIVE';

        // 起点：给出方（TOURIST_PICK 是桌子中央，没有给出方）
        const fromPos = rec.from < 0 ? cc.v3(0, TABLE_CARD_Y, 0) : this.seatNodePos(rec.from);
        // 终点：落桌上 / 落某座位
        const toPos = toTable ? cc.v3(0, TABLE_CARD_Y, 0) : this.seatNodePos(rec.to);

        // 各段时长（大牌明显更慢），统一乘 EXCHANGE_SPEED
        const holdMs = (isBig ? 1.4 : 1.1) * EXCHANGE_SPEED;   // 在给出方停留
        const flyMs = (isBig ? 2.4 : 1.9) * EXCHANGE_SPEED;    // 飞行（最主要的"慢"）
        const restMs = (isBig ? 0.7 : 0.55) * EXCHANGE_SPEED;  // 到达后停留

        // 桌面中央流程条：显示这一步的完整描述
        this.showExchangeBanner(rec, isBig);

        // 飞行的牌：先浮现并放大，停留让人读牌，再沿弧线缓慢飘过去
        const node = createCardNode(rec.card, true);
        node.name = 'fly_' + rec.index + '_' + rec.card.id;   // 名字带记录序号，便于排查
        node.parent = this.layerTable;
        node.zIndex = 200;
        node.scale = isBig ? 0.9 : 0.75;
        node.setPosition(fromPos.x, fromPos.y);
        node.opacity = 0;

        // 飞行切成两段并带一点弧度，看起来是"飘"而不是瞬移
        const midX = (fromPos.x + toPos.x) / 2;
        const midY = (fromPos.y + toPos.y) / 2
            + Math.min(90, cc.v2(toPos.x - fromPos.x, toPos.y - fromPos.y).len() * 0.18);
        const endScale = toTable ? 1.05 : (isBig ? 1.15 : 0.78);
        const flyFrom = isBig ? 1.45 : 1.2;

        cc.tween(node)
            .to(0.2, { opacity: 255, scale: flyFrom })
            .delay(holdMs)
            .to(flyMs * 0.35, { position: cc.v3(midX, midY, 0), scale: (flyFrom + endScale) / 2 })
            .to(flyMs * 0.65, { position: cc.v3(toPos.x, toPos.y, 0), scale: endScale })
            .delay(restMs)
            .to(0.2, { opacity: 0, scale: isBig ? 0.9 : 0.6 })
            .call(() => { if (node && node.isValid) node.destroy(); })
            .start();

        // 给出方旁边的提示：在整个停留段一直挂着，飞走前才消失
        // （TOURIST_PICK / LOSER_PICK 是"从桌上拿"，没有给出方，不飘）
        if (rec.kind !== 'TOURIST_PICK' && rec.kind !== 'LOSER_PICK') {
            const giveColor = isBig ? cc.color(255, 214, 110) : cc.color(190, 210, 200);
            this.popSeatTip(rec.from, `交出 ${rec.card.name}`, giveColor, isBig ? 28 : 22, true,
                0.5 + holdMs);
        }

        // 接收方：牌快到时才提示，停留段一直挂着
        if (!toTable) {
            this.scheduleOnce(() => {
                this.popSeatTip(rec.to, `收到 ${rec.card.name}`, cc.color(140, 230, 160),
                    isBig ? 28 : 22, false, flyMs + restMs + 0.3);
            }, holdMs + flyMs);
        } else {
            // 落桌：在桌子上方飘一句"摆到桌上"，并停留 TABLE_WAIT_SEC 让人看清楚
            this.scheduleOnce(() => {
                this.popTipAt(0, TABLE_CARD_Y + 76, '摆到桌子中间 等人认领',
                    cc.color(255, 226, 140), 22, TABLE_WAIT_SEC);
            }, holdMs + flyMs);
        }

        // 总时长 = 浮现 + 停留 + 飞行 + 停留 + 淡出 + 步与步之间的呼吸间隔
        const tail = toTable ? Math.max(restMs, TABLE_WAIT_SEC) : restMs;
        this.scheduleOnce(onDone, (0.2 + holdMs + flyMs + tail + 0.2 + 0.3) * 1);
    }

    /** 某座位在上一局的名次标签（导游/中游/尾游）；不是游客则返回空串 */
    private touristRankTag(seat: number): string {
        const r = this.engine.lastResult;
        if (!r || seat === r.enemySeat) return '';
        const idx = r.finishOrder.indexOf(seat);
        if (idx < 0) return '';
        return RANK_NAME[idx + 1] || '';
    }

    /** 桌面中央的交牌流程提示条 */
    private showExchangeBanner(rec: ExchangeRecord, isBig: boolean): void {
        const old = this.layerTable.getChildByName('ex_banner');
        if (old && old.isValid) old.destroy();

        let text: string;
        if (rec.kind === 'ENEMY_PUT') {
            text = `${SEAT_NAME[rec.from]} 把 ${rec.card.name} 摆到桌子中间`;
        } else if (rec.kind === 'TOURIST_PICK') {
            const tag = this.touristRankTag(rec.to);
            text = `${SEAT_NAME[rec.to]}${tag ? `（${tag}）` : ''} 从桌上拿走 ${rec.card.name}`;
        } else if (rec.kind === 'LOSER_PICK') {
            text = `${SEAT_NAME[rec.to]} 从桌上挑走 ${rec.card.name}`;
        } else if (rec.kind === 'ENEMY_RETURN') {
            text = `${SEAT_NAME[rec.from]} 把 ${rec.card.name} 摆到桌上（等被抓龟挑）`;
        } else {
            const kindWord = rec.kind === 'LOSER_GIVE' ? '交出大牌' : '还牌给敌人';
            const rankTag = this.touristRankTag(rec.to);
            const toText = SEAT_NAME[rec.to] + (rankTag ? `（${rankTag}）` : '');
            text = `${SEAT_NAME[rec.from]} ${kindWord} ${rec.card.name} → ${toText}`;
        }

        const n = new cc.Node('ex_banner');
        n.parent = this.layerTable;
        n.zIndex = 205;
        n.setPosition(0, 6);

        const w = 520;
        const h = 54;
        const g = n.addComponent(cc.Graphics);
        g.roundRect(-w / 2, -h / 2, w, h, 12);
        g.fillColor = isBig ? cc.color(58, 44, 16, 235) : cc.color(14, 34, 26, 225);
        g.fill();
        g.strokeColor = isBig ? cc.color(255, 214, 110) : cc.color(90, 150, 120);
        g.lineWidth = isBig ? 3 : 1.5;
        g.stroke();

        const t = createLabel(text, isBig ? 24 : 20,
            isBig ? cc.color(255, 226, 140) : cc.color(200, 225, 210), 0, 0);
        t.parent = n;
        t.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        n.opacity = 0;
        cc.tween(n).to(0.15, { opacity: 255 }).start();

        // 保险丝：任何一条流程条最多显示 8 秒，就算流程卡住/被打断也会自己消失
        // （正常流程中每一步都会被新的一条替换，远到不了 8 秒）
        cc.tween(n).delay(8).to(0.5, { opacity: 0 })
            .call(() => { if (n && n.isValid) n.destroy(); }).start();
    }

    /** 交牌结束时收掉桌面中央的流程条（淡出后销毁） */
    private fadeExchangeBanner(): void {
        const old = this.layerTable.getChildByName('ex_banner');
        if (!old || !old.isValid) return;
        cc.tween(old).delay(1.2).to(0.4, { opacity: 0 })
            .call(() => { if (old && old.isValid) old.destroy(); }).start();
    }

    /**
     * 清掉所有还挂在桌面上的「飞行中的牌」。
     * 正常情况下它们飞完自己会 destroy，但如果流程被提前打断（重开局、退出等），
     * 这些节点会留下来，下一次交牌时旧的新的一起出现 → 看起来就是重影。
     */
    private clearFlyingCards(): void {
        for (const child of this.layerTable.children.slice()) {
            if (child.name.indexOf('fly_') === 0) {
                cc.Tween.stopAllByTarget(child);
                child.stopAllActions();
                child.destroy();
            }
        }
        this.flyingRecord = false;
    }

    /** 座位节点位置（自己用手牌区，其他人用头像区） */
    private seatNodePos(seat: number): cc.Vec3 {
        if (seat === 0) return cc.v3(0, -H / 2 + 150, 0);
        const pos = PLAY_POS[seat];
        // 非法座位（如 LOSER_PICK 记录的 from=-1，表示"从桌上拿"）：退回桌中心，绝不能抛异常
        if (!pos) return cc.v3(0, TABLE_CARD_Y, 0);
        return cc.v3(pos.x * 0.82, pos.y, 0);
    }

    /**
     * 在玩家旁边飘一条提示。
     * @param outward true = 朝屏幕外侧（远离桌面中心），避免压住牌
     * @param holdSec 停留秒数（默认 0.55/0.65），交牌流程会传入更长的值
     */
    private popSeatTip(seat: number, text: string, color: cc.Color, size: number,
        outward: boolean, holdSec?: number): void {
        const base = this.seatNodePos(seat);
        // 从桌面中心指向该座位的方向
        const dir = cc.v2(base.x, base.y).normalize();
        const dist = outward ? 62 : 40;
        const x = base.x + (seat === 0 ? 0 : dir.x * dist);
        const y = base.y + (seat === 0 ? (outward ? -26 : 26) : dir.y * dist);

        const hold = holdSec === undefined ? (outward ? 0.55 : 0.65) : holdSec;
        this.popTipAt(x, y, text, color, size, hold);
    }

    /** 在任意坐标飘一条带底色的提示 */
    private popTipAt(x: number, y: number, text: string, color: cc.Color,
        size: number, hold: number): void {
        const n = createLabel(text, size, color, x, y);
        n.parent = this.layerTable;
        n.zIndex = 210;
        // 深色描边底，保证在牌面和桌面上都看得清
        const bg = new cc.Node('tipbg');
        bg.parent = n;
        bg.zIndex = -1;
        const lb = n.getComponent(cc.Label)!;
        bg.setContentSize(lb.node.width + 20, size + 12);
        const g = bg.addComponent(cc.Graphics);
        g.roundRect(-bg.width / 2, -bg.height / 2, bg.width, bg.height, 8);
        g.fillColor = cc.color(10, 24, 18, 200);
        g.fill();

        n.opacity = 0;
        n.scale = 0.8;
        cc.tween(n)
            .to(0.15, { opacity: 255, scale: 1 })
            .delay(hold)
            .to(0.35, { opacity: 0, scale: 0.92 })
            .call(() => { if (n && n.isValid) n.destroy(); })
            .start();
    }

    // ---------- 真人点击 ----------

    /** 点手牌：按当前步骤切换选中 / 取消选中 */
    private onExchangePick(card: Card): void {
        const e = this.engine;
        // 提交锁 / 动画播放中一律不收点击，避免"动画还没走完又点了一张"
        if (this.exchangeLock || this.exchangeBusy) return;
        const step = e.currentExchange;
        if (!step || step.from !== 0) return;
        if (!this.passTapThrottle()) return;

        // 拿牌步骤：桌上的牌才可点，手牌一律忽略
        if (step.kind === 'TOURIST_PICK' || step.kind === 'LOSER_PICK') {
            this.flash('这一步请点桌子中间的牌，再点「拿牌」');
            return;
        }

        if (card.id === DIAMOND_4_ID) {
            this.flash('方块4 是你的身份牌，不能交出去');
            return;
        }
        if (card.exchanged) {
            this.flash('这张牌本局已经换过了，不能再交一次');
            return;
        }

        if (step.kind === 'ENEMY_PUT' || step.kind === 'ENEMY_RETURN') {
            // 多选：交大牌 / 还小牌都是「一次点齐 N 张再提交」，点几张算几张
            const i = this.exchangeSelIds.indexOf(card.id);
            if (i >= 0) this.exchangeSelIds.splice(i, 1);
            else if (this.exchangeSelIds.length >= step.count) {
                this.flash(step.kind === 'ENEMY_PUT'
                    ? `最多只能选 ${step.count} 张（每张游客拿走一张）`
                    : `最多只能选 ${step.count} 张（每只被抓龟挑一张）`);
                return;
            } else this.exchangeSelIds.push(card.id);
            this.exchangeSelId = -1;
            this.refreshHand();
            this.refreshStatus();
            return;
        }

        if (step.kind === 'LOSER_GIVE') {
            const big = e.pendingGiveCards()[0];
            if (big && card.id !== big.id) {
                this.flash(`被抓龟要交最大的一张（${big.name}）`);
                return;
            }
        }

        // 单选步骤：再点一次取消
        this.exchangeSelId = (this.exchangeSelId === card.id) ? -1 : card.id;
        this.exchangeSelIds = this.exchangeSelId > 0 ? [this.exchangeSelId] : [];
        this.refreshHand();
        this.refreshStatus();
    }

    /** 敌人点「交到桌上」 */
    private onPutToTable(): void {
        const e = this.engine;
        // 锁：连点时第二次进来直接丢弃，不会重复把同一批牌搬到桌上
        if (this.exchangeLock) return;
        const step = e.currentExchange;
        if (!step || step.from !== 0 || step.kind !== 'ENEMY_PUT') return;
        if (!this.passTapThrottle()) return;

        if (this.exchangeSelIds.length !== step.count) {
            this.flash(`请先点选正好 ${step.count} 张最大的牌`);
            return;
        }

        // 提交前就上锁，且在同一个同步块里立刻清空选择，
        // 保证任何后续点击都拿不到"还是那几张牌"的旧状态
        this.exchangeLock = true;
        this.refreshStatus();                  // 立刻把按钮压暗成「处理中」，视觉上劝退连点
        const ids = this.exchangeSelIds.slice();
        this.exchangeSelIds = [];
        this.exchangeSelId = -1;

        const ok = e.submitExchange(ids);
        if (!ok) {
            this.exchangeLock = false;
            this.exchangeSelIds = ids;   // 交失败就还原选择，让玩家改
            const names = e.bestPutCards(0, step.count).map((c) => c.name).join('、');
            this.flash(`只能交手上最大的 ${step.count} 张：${names}`);
            this.refreshAll();
            return;
        }

        this.refreshAll();
        this.scheduleOnce(() => {
            this.processExchange();
            this.afterExchangeSubmit();
        }, 0.05);
    }

    /** 点「拿牌 / 交出大牌 / 还牌」——统一提交按钮 */
    private onExchangeButton(): void {
        const e = this.engine;
        // 锁：连点时第二次进来直接丢弃，这就是"同一张牌被搬好几次"的根因
        if (this.exchangeLock) return;
        const step = e.currentExchange;
        if (!step || step.from !== 0) return;
        if (!this.passTapThrottle()) return;

        if (step.kind === 'ENEMY_PUT') {
            this.onPutToTable();
            return;
        }

        // 先验参数，参数不合格直接返回，不动锁
        if ((step.kind === 'TOURIST_PICK' || step.kind === 'LOSER_PICK')
            && this.exchangeSelId <= 0) {
            this.flash('请先点桌子中间的一张牌'); return;
        }
        if (step.kind === 'TOURIST_RETURN' && this.exchangeSelId <= 0) {
            this.flash('请先点一张要还回去的牌'); return;
        }
        if (step.kind === 'ENEMY_RETURN' && this.exchangeSelIds.length !== step.count) {
            this.flash(`请先点选正好 ${step.count} 张小牌（每只被抓龟挑一张）`); return;
        }

        // 上锁并立刻清空选择：即使连点，第二次进来 exchangeSelId 已是 -1
        this.exchangeLock = true;
        this.refreshStatus();                  // 立刻显示「处理中…」，劝退连点
        const submitId = this.exchangeSelId;
        const submitIds = this.exchangeSelIds.slice();
        this.exchangeSelId = -1;
        this.exchangeSelIds = [];

        let ok: boolean;
        let failMsg = '';
        if (step.kind === 'TOURIST_PICK' || step.kind === 'LOSER_PICK') {
            ok = e.submitExchange(submitId);
            failMsg = '这张牌已经不在桌上了';
        } else if (step.kind === 'LOSER_GIVE') {
            // 没点就默认交系统算好的最大那张；传具体 id，避免重复取"当前最大"
            ok = e.submitExchange(submitId > 0 ? submitId : -1);
            failMsg = '只能交出最大的那张牌';
        } else if (step.kind === 'ENEMY_RETURN') {
            ok = e.submitExchange(submitIds);
            failMsg = '这几张不能交：方块4 和本局已换过的牌都不能再交';
        } else {
            ok = e.submitExchange(submitId);
            failMsg = '这张牌不能交：方块4 和本局已换过的牌都不能再交';
        }

        if (!ok) {
            this.exchangeLock = false;
            this.exchangeSelId = submitId;   // 交失败还原选择
            this.exchangeSelIds = submitIds;
            this.flash(failMsg);
            this.refreshAll();
            return;
        }

        this.refreshAll();
        this.scheduleOnce(() => {
            this.processExchange();      // 先播动画 / 渲染新一步
            this.afterExchangeSubmit();  // 播放中不解锁，播完且等真人输入才解锁
        }, 0.05);
    }

    /**
     * 交牌步骤之间的统一切换点：先渲染新一步的桌面状态，再决定要不要解锁。
     *
     * 为什么不能直接 `exchangeLock = false`：
     *   `submitExchange` 成功后会立刻把引擎推进到下一步（可能又是真人步骤），
     *   但新一步的飞牌动画/流程条还没播。如果此时就解锁，按钮会解冻，
     *   玩家在"看起来还是上一步"的状态下点击，就会重复提交或点到已失效的牌。
     *   所以只有「引擎停在等真人输入」且「没有动画在播」时才解锁。
     *   若下一步是 AI 步骤，动画播完后会经 processExchange 再走一遍，那时才解锁。
     */
    private afterExchangeSubmit(): void {
        const e = this.engine;
        try {
            if (e.phase === Phase.EXCHANGE && e.currentExchange) {
                this.refreshExchangeTable();
                this.refreshExchangeHint(e.currentExchange);
            }
            this.refreshAll();
        } catch (err) {
            cc.error('[乌龟4] 交牌后刷新异常（已恢复）: ' + err);
        } finally {
            // 解锁判定必须执行：刷新抛异常也不能让 exchangeLock 永久残留
            if (!this.exchangeBusy) this.exchangeLock = false;
        }
    }
    private announceFirstLead(): void {
        const e = this.engine;
        const lead = e.currentSeat;
        const gives = e.bigGives;
        if (gives.length > 0) {
            let top = gives[0];
            for (const g of gives) if (g.card.id > top.card.id) top = g;
            const who = lead === 0 ? '你' : SEAT_NAME[lead];
            this.flash(`交牌完成：${who}交出的 ${top.card.name} 最大，${who}先出牌`, 2.8);
        } else {
            this.flash('交牌完成，开始出牌', 2.0);
        }
    }

    // ================= 结算 =================

    /**
     * 结算面板的安全包装。
     * 为什么需要：checkTurn 发现 phase 变成 ROUND_END 就会调 showResult，
     * 若 showResult 内部抛异常，上层 catch 又会把 checkTurn 排进定时器，
     * 于是「抛异常 → 重试 → 再抛」无限循环，界面上什么都点不了。
     * 这里用 resultShown 保证一局只尝试一次，失败则给一个最小可用的兜底面板。
     */
    private safeShowResult(): void {
        if (this.resultShown) return;
        this.resultShown = true;
        try {
            this.showResult();
        } catch (err) {
            cc.error('[乌龟4] 结算面板绘制异常: ' + err);
            this.showResultFallback();
        }
    }

    /** 结算面板画不出来时的兜底：至少要有一个按钮能把玩家带回牌局，不能就此卡死 */
    private showResultFallback(): void {
        try {
            this.clearPop();
            const panel = createPanel(560, 240, cc.color(12, 32, 24, 245), cc.color(226, 190, 100), 18);
            panel.parent = this.layerPop;
            const tip = createLabel('本局结束', 34, cc.color(255, 226, 140), 0, 50);
            tip.parent = panel;
            tip.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
            const go = createButton('继续', {
                fill: cc.color(56, 132, 96), fontSize: 22, width: 200, height: 56,
            }, () => this.onStayInRoom());
            go.parent = panel;
            go.setPosition(0, -60);
            this.engine.phase = Phase.ROUND_END;
            this.refreshStatus();
        } catch (err) {
            cc.error('[乌龟4] 兜底面板也失败: ' + err);
            // 最后手段：直接开下一局，绝不停在死界面
            this.scheduleOnce(() => this.startRound(), 1.0);
        }
    }

    private showResult(): void {
        const e = this.engine;
        const r = e.lastResult!;
        const meWin = e.isWinner(0);
        const delta = applyRoundResult(meWin);

        this.clearPop();

        const pw = 720;
        const ph = 470;
        const panel = createPanel(pw, ph, cc.color(12, 32, 24, 245), cc.color(226, 190, 100), 18);
        panel.parent = this.layerPop;

        // 标题
        const title = createLabel(meWin ? '你赢了！' : '你输了', 40,
            meWin ? cc.color(255, 226, 140) : cc.color(200, 205, 210), 0, ph / 2 - 52);
        title.parent = panel;
        title.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        // 副标题：本局阵营结果
        const subText = r.enemyWin
            ? `敌人（${SEAT_NAME[r.enemySeat]}）出完牌，把没出完的乌龟抓走了`
            : '乌龟方全部在敌人之前出完，敌人输了';
        const sub = createLabel(subText, 20, cc.color(190, 225, 200), 0, ph / 2 - 98);
        sub.parent = panel;
        sub.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        // 四家名次
        const lines: string[] = [];
        for (let s = 0; s < SEAT_COUNT; s++) {
            const p = e.players[s];
            let role: string;
            if (p.isEnemy) role = r.enemyWin ? '敌人 · 赢' : '敌人 · 输';
            else if (p.finished) role = RANK_NAME[p.rank] || '游客';
            else role = '被抓龟';
            const win = e.isWinner(s);
            lines.push(`${SEAT_NAME[s]}${s === r.enemySeat ? '（敌人）' : ''}：${role}${win ? ' ✔' : ''}`);
        }
        const list = createLabel(lines.join('\n'), 21, cc.color(232, 240, 228), -pw / 2 + 70, ph / 2 - 160);
        list.parent = panel;
        list.setAnchorPoint(0, 1);
        list.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.LEFT;
        list.getComponent(cc.Label)!.lineHeight = 32;

        // 积分变化
        const prof = loadProfile();
        const sign = delta >= 0 ? '+' : '';
        const scoreTxt = createLabel(`${sign}${delta} 积分`, 34,
            delta >= 0 ? cc.color(120, 230, 150) : cc.color(240, 120, 110), pw / 2 - 130, ph / 2 - 175);
        scoreTxt.parent = panel;
        scoreTxt.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        const totalTxt = createLabel(`当前 ${prof.score} 分`, 20, cc.color(220, 210, 170), pw / 2 - 130, ph / 2 - 215);
        totalTxt.parent = panel;
        totalTxt.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        // 两个按钮：继续留在房间 / 退出游戏
        const stay = createButton('继续留在房间', {
            fill: cc.color(56, 132, 96), fontSize: 22, width: 220, height: 56, stroke: cc.color(120, 210, 160),
        }, () => this.onStayInRoom());
        stay.parent = panel;
        stay.setPosition(-130, -ph / 2 + 60);

        const exit = createButton('退出游戏', {
            fill: cc.color(140, 74, 62), fontSize: 22, width: 200, height: 56,
        }, () => this.onExitGame());
        exit.parent = panel;
        exit.setPosition(130, -ph / 2 + 60);

        // 敌人身份揭晓的小提示
        const revealTxt = createLabel(
            `本局敌人是：${SEAT_NAME[r.enemySeat]}${r.enemySeat === 0 ? '（你）' : ''}`,
            18, cc.color(255, 180, 120), 0, -ph / 2 + 118);
        revealTxt.parent = panel;
        revealTxt.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        // 阶段切成等待，避免按钮还能点
        this.engine.phase = Phase.ROUND_END;
        this.refreshStatus();
    }

    /** 留在房间：显示等待提示，2 秒后开下一局（单机版用 AI 陪玩） */
    private onStayInRoom(): void {
        this.clearPop();
        this.engine.phase = Phase.ROUND_WAIT;
        this.refreshStatus();
        this.flash('正在等待其他玩家进入房间...', 1.6);

        // 单机版：AI 就位直接开局
        this.scheduleOnce(() => {
            if (this.engine.phase === Phase.ROUND_WAIT) this.startRound();
        }, 1.8);
    }

    /** 退出游戏：回主菜单场景 */
    private onExitGame(): void {
        this.clearPop();
        cc.director.loadScene('menu', (err) => {
            if (err) {
                cc.error('[乌龟4] 返回主菜单失败：请确认 menu 场景已在构建列表里', err);
                // 兜底：留一张提示
                const t = createMultiline('返回主菜单失败\n请把 menu 场景加入构建列表', 24,
                    cc.color(255, 200, 150), 0, 0, 500);
                t.parent = this.layerPop;
            }
        });
    }

    private confirmExit(): void {
        this.clearPop();
        const pw = 560;
        const ph = 260;
        const panel = createPanel(pw, ph, cc.color(12, 32, 24, 245), cc.color(226, 190, 100), 16);
        panel.parent = this.layerPop;

        const t = createMultiline('确定要退出本局吗？\n退出后本局不计入积分', 24, cc.color(240, 235, 215), 0, 50, 500);
        t.parent = panel;

        const yes = createButton('退出', { fill: cc.color(160, 80, 66), fontSize: 22, width: 150, height: 52 }, () => this.onExitGame());
        yes.parent = panel;
        yes.setPosition(-95, -60);

        const no = createButton('继续玩', { fill: cc.color(70, 110, 92), fontSize: 22, width: 150, height: 52 }, () => this.clearPop());
        no.parent = panel;
        no.setPosition(95, -60);
    }

    private clearPop(): void {
        this.layerPop.removeAllChildren();
    }
}
