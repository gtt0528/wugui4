/**
 * 乌龟4 —— 主菜单场景
 *
 * 用户端入口页：积分展示 + 开始匹配 / 开房间 / 人机对战，以及规则说明。
 * 全部 UI 由代码构建，Canvas 下挂一个空节点把本脚本加上即可。
 *
 * 场景切换：cc.director.loadScene('game')
 */

import { createLabel, createButton, createPanel, createMultiline } from './CardView';
import {
    loadProfile, saveProfile, canPlay, applyRelief, winRate, RELIEF_SCORE,
} from '../core/Profile';
import { NetClient } from '../net/NetClient';
import { setupShare, share, launchQuery, showRewardedAd, isWechat } from '../net/WxAdapter';
import { serverCfg, prodNotConfigured } from '../net/Config';

const { ccclass } = cc._decorator;

const W = 1280;
const H = 720;

/** 各模式说明（匹配/房间暂未联机，先如实提示） */
interface ModeDef {
    key: string;
    title: string;
    desc: string;
    enabled: boolean;
}

@ccclass
export default class MenuScene extends cc.Component {

    private layerMain: cc.Node = null!;
    private layerPop: cc.Node = null!;
    private lblScore: cc.Label = null!;
    private lblStats: cc.Label = null!;

    onLoad(): void {
        cc.view.resizeWithBrowserSize(true);
        cc.view.setDesignResolutionSize(W, H, cc.ResolutionPolicy.SHOW_ALL);
        this.buildBackground();
        this.buildTopBar();
        this.buildModes();
        this.buildFooter();
        this.refreshProfile();

        // 转发文案：带上房间号，好友点开卡片能直接进同一个房间
        setupShare(() => ({
            title: this.myCode ? `乌龟4 · 房间 ${this.myCode}，来一局？` : '乌龟4 · 两广经典四人牌',
            query: this.myCode ? `code=${this.myCode}` : '',
        }));

        // 好友从分享卡片点进来（带 code）→ 直接进房
        const invite = launchQuery().code || this.urlCode();
        if (invite) {
            this.scheduleOnce(() => this.startOnline('join', String(invite)), 0.5);
        }

        // 首次进入：性别没填过就弹资料卡（昵称 + 性别，联机时展示给同桌）
        if (loadProfile().gender === 0) {
            this.scheduleOnce(() => this.showProfileSetup(), 0.2);
        }
    }

    // ================= 背景 =================

    private buildBackground(): void {
        this.layerMain = new cc.Node('main');
        this.layerMain.parent = this.node;

        const bg = new cc.Node('bg');
        bg.parent = this.layerMain;
        const g = bg.addComponent(cc.Graphics);
        // 深绿渐变底（用几层色带模拟）
        const bands = [
            cc.color(18, 62, 45), cc.color(21, 72, 52), cc.color(24, 82, 58),
            cc.color(27, 92, 64), cc.color(30, 100, 70),
        ];
        const bh = H / bands.length;
        for (let i = 0; i < bands.length; i++) {
            g.rect(-W / 2, -H / 2 + i * bh, W, bh + 1);
            g.fillColor = bands[i];
            g.fill();
        }
        // 中央光晕
        g.circle(0, 60, 260);
        g.fillColor = cc.color(60, 150, 105, 40);
        g.fill();

        this.layerPop = new cc.Node('pop');
        this.layerPop.parent = this.node;
        this.layerPop.zIndex = 100;
    }

    // ================= 顶部：标题 + 积分 =================

    private buildTopBar(): void {
        const title = createLabel('乌 龟 4', 56, cc.color(255, 226, 140), 0, H / 2 - 80);
        title.parent = this.layerMain;
        const tl = title.getComponent(cc.Label)!;
        tl.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
        // 描边效果：叠一层深色
        const shadow = createLabel('乌 龟 4', 56, cc.color(0, 0, 0, 90), 3, H / 2 - 83);
        shadow.parent = this.layerMain;
        shadow.zIndex = -1;

        const sub = createLabel('两广经典 · 4人纸牌', 20, cc.color(180, 225, 195), 0, H / 2 - 128);
        sub.parent = this.layerMain;
        sub.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        // 左上角玩家卡片
        const cardW = 300;
        const cardH = 96;
        const info = createPanel(cardW, cardH, cc.color(12, 48, 34, 200), cc.color(90, 160, 120), 12);
        info.parent = this.layerMain;
        info.setPosition(-W / 2 + cardW / 2 + 24, H / 2 - 24 - cardH / 2);

        const nick = createLabel('', 22, cc.color(255, 240, 180), 0, 0);
        nick.parent = info;
        nick.setPosition(-cardW / 2 + 16, 26);
        nick.setAnchorPoint(0, 0.5);
        nick.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.LEFT;
        nick.name = 'nick';

        this.lblScore = this.mkLabel(info, '', 30, cc.color(255, 210, 90), -cardW / 2 + 16, 0, 'left');
        this.lblStats = this.mkLabel(info, '', 16, cc.color(170, 215, 185), -cardW / 2 + 16, -28, 'left');

        // 点玩家卡片 → 随时改昵称/性别
        info.on(cc.Node.EventType.TOUCH_END, () => this.showProfileSetup());
        const editTip = createLabel('点击修改资料', 14, cc.color(140, 190, 165), cardW / 2 - 12, -cardH / 2 + 14);
        editTip.parent = info;
        editTip.setAnchorPoint(1, 0.5);
    }

    private mkLabel(parent: cc.Node, text: string, size: number, color: cc.Color,
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

    private refreshProfile(): void {
        const p = loadProfile();
        this.lblScore.string = `${p.score} 积分`;
        this.lblStats.string = `胜 ${p.wins} · 负 ${p.losses} · 胜率 ${winRate()}%`;
        // 昵称节点按名字查找
        const nk = this.findNode('nick');
        if (nk) nk.getComponent(cc.Label)!.string = p.nick;
    }

    private findNode(name: string, root?: cc.Node): cc.Node | null {
        const r = root || this.node;
        if (r.name === name) return r;
        for (const c of r.children) {
            const f = this.findNode(name, c);
            if (f) return f;
        }
        return null;
    }

    // ================= 三个模式按钮 =================

    private buildModes(): void {
        const modes: ModeDef[] = [
            { key: 'match', title: '开始匹配', desc: '和线上玩家凑一桌\n最多等 30 秒，人不够由机器人补位', enabled: true },
            { key: 'room', title: '创建房间', desc: '生成 6 位房间号\n微信发给好友一起打', enabled: true },
            { key: 'ai', title: '人机对战', desc: '1 人 + 3 个 AI\n不用联网也能玩', enabled: true },
        ];

        const cardW = 300;
        const cardH = 190;
        const gap = 40;
        const totalW = cardW * modes.length + gap * (modes.length - 1);
        let x = -totalW / 2 + cardW / 2;

        for (const m of modes) {
            const card = this.mkModeCard(m, cardW, cardH);
            card.parent = this.layerMain;
            card.setPosition(x, 20);
            x += cardW + gap;
        }
    }

    private mkModeCard(m: ModeDef, w: number, h: number): cc.Node {
        const n = new cc.Node('mode_' + m.key);
        n.setContentSize(w, h);

        const g = n.addComponent(cc.Graphics);
        // 阴影
        g.roundRect(-w / 2 + 4, -h / 2 - 6, w, h, 16);
        g.fillColor = cc.color(0, 0, 0, 80);
        g.fill();
        g.roundRect(-w / 2, -h / 2, w, h, 16);
        g.fillColor = m.enabled ? cc.color(34, 104, 76) : cc.color(46, 62, 58);
        g.fill();
        g.strokeColor = m.enabled ? cc.color(120, 200, 150) : cc.color(90, 100, 96);
        g.lineWidth = 2;
        g.stroke();

        const t = createLabel(m.title, 32, m.enabled ? cc.color(255, 230, 150) : cc.color(170, 180, 176), 0, 40);
        t.parent = n;
        t.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        const d = createMultiline(m.desc, 18, m.enabled ? cc.color(200, 235, 210) : cc.color(145, 155, 150), 0, 2, w - 40);
        d.parent = n;

        const btn = createButton(m.enabled ? '进入' : '敬请期待', {
            fill: m.enabled ? cc.color(226, 150, 50) : cc.color(74, 84, 80),
            fontSize: 20, width: 128, height: 42,
        }, () => this.onModeClick(m));
        btn.parent = n;
        btn.setPosition(0, -h / 2 + 30);

        return n;
    }

    private onModeClick(m: ModeDef): void {
        if (m.key === 'ai') { this.startAIGame(); return; }
        if (m.key === 'match') { this.startOnline('match'); return; }
        if (m.key === 'room') { this.startOnline('create'); return; }
        this.showToast('该模式暂未开放');
    }

    // ================= 联机 =================

    private matchStatus: cc.Label | null = null;
    private onlineCount: number = 1;
    /** 自己房间的房间号（私房才有） */
    private myCode: string = '';
    private codeLabel: cc.Label | null = null;
    private inviteBtnNode: cc.Node | null = null;
    private pendingMode: 'match' | 'create' | 'join' = 'match';
    private pendingCode = '';

    /**
     * 联机入口：连服 → 登录 → （快速匹配 / 开房 / 按房间号进）。
     */
    private startOnline(mode: 'match' | 'create' | 'join', code = ''): void {
        const net = NetClient.inst;
        if (net.connected) {
            if (mode === 'create') net.create();
            else if (mode === 'join') net.joinCode(code);
            else net.join();
            return;
        }

        this.pendingMode = mode;
        this.pendingCode = code;
        this.myCode = '';
        this.showMatchPanel(mode === 'create' ? '正在创建房间…' : '正在连接对战服…');

        // 微信里地址还是占位符时，直接说清楚，别让人对着 8 秒超时发呆
        if (isWechat() && prodNotConfigured()) {
            this.setMatchStatus('线上服务器地址还没配置\n请先在 net/Config.ts 里填好 wss 域名');
            return;
        }

        net.connect().then(() => {
            this.setMatchStatus('已连接，正在登录…');
            net.onMsg = (msg) => this.onMatchMsg(msg, net);
            net.onClosed = () => this.showMatchPanel('连接已断开\n请检查网络，或确认对战服是否启动');
            const p = loadProfile();
            net.login(p.nick, p.gender);
        }).catch((err: Error) => {
            this.showMatchPanel(
                '连接失败：' + err.message +
                '\n\n目标地址：' + serverCfg().ws +
                '\n本地联机请先启动：cd gameserver && npm start');
        });
    }

    private onMatchMsg(msg: any, net: NetClient): void {
        switch (msg.t) {
            case 'loginOk':
                net.userId = msg.userId;
                this.setMatchStatus('登录成功，正在进房…');
                if (this.pendingMode === 'create') net.create();
                else if (this.pendingMode === 'join') net.joinCode(this.pendingCode);
                else net.join();
                break;
            case 'roomOk':
                net.mySeat = msg.seat;
                net.roomId = msg.roomId;
                this.myCode = msg.code ? String(msg.code) : '';
                this.onlineCount = msg.members ? msg.members.filter((m: any) => !m.empty).length : 1;
                // 进房即自动准备：4 家都进房且都准备了，服务器自动开局
                net.ready();
                this.refreshInvite();
                this.setMatchStatus(
                    this.myCode
                        ? `房间 ${this.myCode} · 你是 ${msg.seat + 1} 号位\n把房间号发给好友，人齐自动开局`
                        : `已进房（${msg.seat + 1} 号位），已自动准备\n还差 ${4 - this.onlineCount} 位玩家，30 秒内不够会由机器人补位`);
                break;
            case 'readyCount':
                this.setMatchStatus(`房间 ${this.myCode || net.roomId} · ${this.onlineCount}/4 人 · 准备 ${msg.ready}/${msg.need}`);
                break;
            case 'memberUpdate': {
                const list: any[] = msg.members || [];
                this.onlineCount = list.filter((m) => !m.empty).length;
                if (!this.myCode) this.setMatchStatus(`房间 ${net.roomId} · ${this.onlineCount}/4 人，人齐后自动开局`);
                break;
            }
            case 'roundStart':
                // 牌局开始：进 game 场景，GameScene 检测到连接会自动切联机视图
                net.onMsg = null;
                cc.director.loadScene('game', (err) => {
                    if (err) cc.error('[乌龟4] 进入联机牌局失败', err);
                });
                break;
            case 'error':
                this.setMatchStatus('服务器：' + (msg.msg || '未知错误'));
                break;
            default:
                break;
        }
    }

    private showMatchPanel(text: string): void {
        this.clearPop();
        const p = createPanel(700, 440, cc.color(14, 40, 30, 248), cc.color(220, 190, 100), 16);
        p.parent = this.layerPop;
        const st = createMultiline(text, 22, cc.color(235, 245, 230), 0, 110, 620);
        st.parent = p;
        this.matchStatus = st.getComponent(cc.Label) || null;

        // 房间号（私房才显示大字）
        const codeLbl = createLabel('', 34, cc.color(255, 226, 140), 0, -10);
        codeLbl.parent = p;
        codeLbl.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
        this.codeLabel = codeLbl.getComponent(cc.Label)!;

        const invite = createButton('邀请好友', {
            fill: cc.color(70, 140, 200), fontSize: 22, width: 170, height: 50,
        }, () => this.inviteFriend());
        invite.parent = p;
        invite.setPosition(-100, -110);
        invite.active = false;
        this.inviteBtnNode = invite;

        const cancel = createButton('取消', {
            fill: cc.color(140, 74, 62), fontSize: 22, width: 150, height: 50,
        }, () => {
            NetClient.inst.close();
            this.clearPop();
        });
        cancel.parent = p;
        cancel.setPosition(100, -110);

        this.refreshInvite();
    }

    /** 房间号变化后刷新显示 */
    private refreshInvite(): void {
        if (this.codeLabel && this.codeLabel.isValid) {
            this.codeLabel.string = this.myCode ? `房间号 ${this.myCode}` : '';
        }
        if (this.inviteBtnNode && this.inviteBtnNode.isValid) {
            this.inviteBtnNode.active = !!this.myCode;
        }
    }

    /** 邀请好友：微信里拉起转发卡片（带 code 参数，好友点开直接进房） */
    private inviteFriend(): void {
        const code = this.myCode;
        if (!code) return;
        if (!isWechat()) {
            this.showToast(`房间号：${code}\n网页版把房间号告诉好友即可；\n微信里可直接转发卡片进入`);
            return;
        }
        share(`乌龟4 · 房间 ${code}，来一局？`, `code=${code}`);
    }

    private setMatchStatus(text: string): void {
        if (!this.matchStatus || !this.matchStatus.isValid) { this.showMatchPanel(text); return; }
        this.matchStatus.string = text;
    }

    /** 浏览器预览时支持 ?code=123456 直接进房（方便自己开两个窗口测试） */
    private urlCode(): string {
        try {
            if (typeof location === 'undefined') return '';
            const m = /[?&]code=(\d+)/.exec(location.search || '');
            return m ? m[1] : '';
        } catch (e) {
            return '';
        }
    }

    private startAIGame(): void {
        if (!canPlay()) {
            this.showReliefDialog();
            return;
        }
        cc.director.loadScene('game', (err) => {
            if (err) {
                cc.error('[乌龟4] 进入牌局失败，检查 game 场景是否在构建列表里', err);
                this.showToast('进入牌局失败：\n请在「项目设置 → 项目预览」里\n把 game 场景勾选上');
            }
        });
    }

    // ================= 底部：规则 / 说明 =================

    private buildFooter(): void {
        const btn = createButton('玩法规则', {
            fill: cc.color(52, 96, 82), fontSize: 20, width: 140, height: 44, stroke: cc.color(110, 170, 140),
        }, () => this.showRules());
        btn.parent = this.layerMain;
        btn.setPosition(-W / 2 + 94, -H / 2 + 40);

        const tip = createLabel('积分：赢 +15 ｜ 输 -10 ｜ 初始 1000', 18, cc.color(150, 200, 175), 0, -H / 2 + 36);
        tip.parent = this.layerMain;
        tip.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        const ver = createLabel('v0.2 联机版', 16, cc.color(110, 155, 135), W / 2 - 90, -H / 2 + 36);
        ver.parent = this.layerMain;
        ver.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
    }

    // ================= 弹窗 =================

    /** 首次进入的资料卡：选性别 + 换昵称 */
    private showProfileSetup(): void {
        const p = loadProfile();
        this.clearPop();

        const card = createPanel(560, 360, cc.color(14, 40, 30, 248), cc.color(220, 190, 100), 16);
        card.parent = this.layerPop;

        const title = createLabel('完善个人资料', 28, cc.color(255, 226, 140), 0, 130);
        title.parent = card;

        const lblNick = createLabel('你的昵称：' + p.nick, 22, cc.color(235, 242, 235), 0, 66);
        lblNick.parent = card;

        const lblGender = createLabel(
            '性别：' + (p.gender === 1 ? '男' : p.gender === 2 ? '女' : '（还没选）'),
            22, cc.color(235, 242, 235), 0, 18);
        lblGender.parent = card;

        const refresh = () => {
            lblNick.getComponent(cc.Label)!.string = '你的昵称：' + loadProfile().nick;
            lblGender.getComponent(cc.Label)!.string =
                '性别：' + (loadProfile().gender === 1 ? '男' : loadProfile().gender === 2 ? '女' : '（还没选）');
        };

        const btnBoy = createButton('男', {
            fill: cc.color(56, 100, 168), fontSize: 22, width: 110, height: 52,
        }, () => { loadProfile().gender = 1; saveProfile(); refresh(); });
        btnBoy.parent = card;
        btnBoy.setPosition(-160, -50);

        const btnGirl = createButton('女', {
            fill: cc.color(178, 70, 116), fontSize: 22, width: 110, height: 52,
        }, () => { loadProfile().gender = 2; saveProfile(); refresh(); });
        btnGirl.parent = card;
        btnGirl.setPosition(-30, -50);

        const btnReroll = createButton('换个名字', {
            fill: cc.color(70, 96, 88), fontSize: 20, width: 130, height: 52,
        }, () => {
            const lp = loadProfile();
            lp.nick = '玩家' + Math.floor(1000 + Math.random() * 9000);
            saveProfile();
            refresh();
        });
        btnReroll.parent = card;
        btnReroll.setPosition(120, -50);

        const note = createMultiline('微信登录后可直接使用微信昵称与头像\n头像将按性别自动配色显示', 16, cc.color(150, 195, 170), 0, -108, 480);
        note.parent = card;

        const ok = createButton('开始游戏', {
            fill: cc.color(226, 150, 50), fontSize: 24, width: 220, height: 56,
        }, () => {
            saveProfile();   // 性别可以不选（0 = 未知，头像显示灰色）
            this.refreshProfile();
            this.clearPop();
        });
        ok.parent = card;
        ok.setPosition(0, -150);
    }

    private clearPop(): void {
        this.layerPop.removeAllChildren();
    }

    private showToast(msg: string, duration = 2.2): void {
        this.clearPop();
        const p = createPanel(520, 150, cc.color(15, 40, 30, 240), cc.color(120, 180, 145), 14);
        p.parent = this.layerPop;
        const t = createMultiline(msg, 22, cc.color(255, 240, 210), 0, 0, 470);
        t.parent = p;
        cc.tween(p).delay(duration).to(0.3, { opacity: 0 }).call(() => this.clearPop()).start();
    }

    private showReliefDialog(): void {
        this.clearPop();
        const p = createPanel(600, 300, cc.color(16, 44, 33, 245), cc.color(220, 180, 90), 16);
        p.parent = this.layerPop;

        const t = createMultiline(
            '积分不足，暂时无法开局\n\n领一笔救济分（' + RELIEF_SCORE + '）继续玩吧',
            24, cc.color(255, 240, 205), 0, 60, 520);
        t.parent = p;

        const ok = createButton(isWechat() ? '看广告领取' : '领取救济分', {
            fill: cc.color(226, 150, 50), fontSize: 22, width: 180, height: 50,
        }, () => {
            this.clearPop();
            showRewardedAd().then((watched) => {
                // 微信里必须完整看完；浏览器 / 未配广告位时直接给（本地调试用）
                if (isWechat() && !watched) { this.showToast('看完广告才能领哦'); return; }
                applyRelief();
                this.refreshProfile();
                this.showToast('已领取 ' + RELIEF_SCORE + ' 积分');
            });
        });
        ok.parent = p;
        ok.setPosition(-110, -95);

        const cancel = createButton('返回', {
            fill: cc.color(80, 96, 90), fontSize: 22, width: 140, height: 50,
        }, () => this.clearPop());
        cancel.parent = p;
        cancel.setPosition(110, -95);
    }

    private showRules(): void {
        this.clearPop();
        const w = 880;
        const h = 620;
        const p = createPanel(w, h, cc.color(14, 40, 30, 248), cc.color(220, 190, 100), 18);
        p.parent = this.layerPop;

        const title = createLabel('玩法规则', 30, cc.color(255, 226, 140), 0, h / 2 - 42);
        title.parent = p;
        title.getComponent(cc.Label)!.horizontalAlign = cc.Label.HorizontalAlign.CENTER;

        const text = [
            '【身份】持方块4 的人是「敌人」，其余 3 人是「乌龟」，彼此不知情。',
            '【目标】敌人出完牌的那一刻结算：',
            '   · 所有乌龟都已经出完 → 乌龟方赢；',
            '   · 还有乌龟没出完 → 敌人赢，没出完的乌龟「被抓走」，本局立即结束。',
            '   赶在敌人出完之前出完的乌龟，按顺序叫 导游 / 中游 / 尾游；被抓走的不算名次。',
            '【牌力】4<5<6<…<A<2<3<小王<大王；同点看花色 方块<梅花<红桃<黑桃。',
            '【牌型】单张 / 对子 / 三张 / 鸡(4张同点) / 三带二 / 顺子 / 同一花色 / 一条龙 / 4带1。',
            '   五张的牌型可以互压：一条龙 > 4带1 > 三带二 > 顺子 > 同一花色；',
            '   同一花色先比花色，再比这五张里最大那张的点数。',
            '   2、3、大小王不能进顺子/一条龙；大王+小王放一起算一对（能压任何对子）。',
            '【交牌】从第 2 局起，开局先交牌（桌上抢牌）：',
            '   ① 敌人挑最大的 N 张摆到桌子中间（N = 游客人数）',
            '   ② 导游 → 中游 → 尾游 依次从桌上挑一张拿走',
            '   ③ 各游客再各还一张给敌人（不必最小）',
            '   ④ 被抓龟各交一张最大的牌给敌人',
            '   ⑤ 敌人一次摆 M 张小牌到桌上，被抓龟按「谁交的大牌大」顺序挑',
            '   方块4 永远不能交；本局刚换来的牌不能再交出去。',
            '【先手】交牌中交出最大那张牌的人先出；首局由持梅花4 的人先出。',
            '【计时】轮到谁交牌 / 出牌有 20 秒倒计时，超时系统自动帮你交（大牌交最大的、还牌给最小的）。',
            '【积分】初始 1000 分，赢一局 +15，输一局 -10。',
        ].join('\n');

        const body = createMultiline(text, 16, cc.color(232, 240, 225), 0, 6, w - 80);
        body.parent = p;
        body.anchorY = 0.5;

        const close = createButton('知道了', {
            fill: cc.color(226, 150, 50), fontSize: 22, width: 160, height: 48,
        }, () => this.clearPop());
        close.parent = p;
        close.setPosition(0, -h / 2 + 44);
    }
}
