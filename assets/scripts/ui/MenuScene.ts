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
            { key: 'match', title: '开始匹配', desc: '联机匹配 3 位玩家\n（需启动对战服）', enabled: true },
            { key: 'room', title: '创建房间', desc: '邀请好友一起打\n（联机功能开发中）', enabled: false },
            { key: 'ai', title: '人机对战', desc: '1 人 + 3 个 AI\n现在就能玩', enabled: true },
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
        if (m.key === 'match') { this.startMatch(); return; }
        this.showToast('创建房间功能开发中\n先玩「开始匹配」或「人机对战」');
    }

    // ================= 联机匹配 =================

    private matchStatus: cc.Label | null = null;
    private onlineCount: number = 1;       // 当前房间在线人数（用于匹配文案同步）

    /**
     * 联机流程：连对战服 → 登录（用本地昵称）→ join 快速进房。
     * 之后房间面板、准备、开局进 game 场景都由服务器消息驱动。
     */
    private startMatch(): void {
        const net = NetClient.inst;
        if (net.connected) { net.join(); return; }   // 已连接（比如从牌局退回）直接再进房

        this.showMatchPanel('正在连接对战服…');

        net.connect().then(() => {
            this.setMatchStatus('已连接，正在登录…');
            net.onMsg = (msg) => this.onMatchMsg(msg, net);
            const p = loadProfile();
            net.login(p.nick, p.gender);
        }).catch((err: Error) => {
            this.showMatchPanel('连接失败：' + err.message + '\n\n请先启动对战服：\ncd gameserver && npm start');
        });
    }

    private onMatchMsg(msg: any, net: NetClient): void {
        switch (msg.t) {
            case 'loginOk':
                this.setMatchStatus('登录成功，正在匹配房间…');
                net.userId = msg.userId;
                net.join();
                break;
            case 'roomOk':
                net.mySeat = msg.seat;
                net.roomId = msg.roomId;
                this.onlineCount = msg.members ? msg.members.filter((m: any) => !m.empty).length : 1;
                // 进房即自动准备：4 家都进房且都准备了，服务器自动开局
                net.ready();
                this.setMatchStatus(
                    `已进房 ${net.roomId}（你是 ${msg.seat + 1} 号位），已自动准备\n` +
                    `还差 ${4 - this.onlineCount} 位玩家，人齐后自动开局…`);
                break;
            case 'readyCount':
                this.setMatchStatus(`房间 ${net.roomId} · ${this.onlineCount}/4 人 · 准备 ${msg.ready}/${msg.need}，4 家齐了自动开局`);
                break;
            case 'memberUpdate': {
                // 有人进房/退房：实时刷新房间人数（别人取消匹配时 2/4 → 1/4）
                const list: any[] = msg.members || [];
                this.onlineCount = list.filter((m) => !m.empty).length;
                this.setMatchStatus(`房间 ${net.roomId} · ${this.onlineCount}/4 人，人齐后自动开局`);
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
        const p = createPanel(620, 340, cc.color(14, 40, 30, 248), cc.color(220, 190, 100), 16);
        p.parent = this.layerPop;
        const st = createMultiline(text, 22, cc.color(235, 245, 230), 0, 40, 560);
        st.parent = p;
        this.matchStatus = st.getComponent(cc.Label) || null;

        const cancel = createButton('取消', {
            fill: cc.color(140, 74, 62), fontSize: 22, width: 150, height: 50,
        }, () => {
            NetClient.inst.close();
            this.clearPop();
        });
        cancel.parent = p;
        cancel.setPosition(0, -110);
    }

    private setMatchStatus(text: string): void {
        if (!this.matchStatus || !this.matchStatus.isValid) { this.showMatchPanel(text); return; }
        this.matchStatus.string = text;
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

        const ver = createLabel('v0.1 单机版', 16, cc.color(110, 155, 135), W / 2 - 90, -H / 2 + 36);
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

        const ok = createButton('领取救济分', {
            fill: cc.color(226, 150, 50), fontSize: 22, width: 180, height: 50,
        }, () => {
            applyRelief();
            this.refreshProfile();
            this.clearPop();
            this.showToast('已领取 ' + RELIEF_SCORE + ' 积分');
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
            '【目标】第一个出完牌的人决定胜负：',
            '   · 敌人第一个出完 → 敌人赢，抓走所有乌龟；',
            '   · 乌龟先出完 → 它成为「导游」，牌局继续，剩下乌龟接着抢「中游」，',
            '     最后一个没出完的乌龟就是「尾游」，被敌人抓走。',
            '【牌力】4<5<6<…<A<2<3<小王<大王；同点看花色 方块<梅花<红桃<黑桃。',
            '【牌型】单张 / 对子 / 三张 / 鸡(4张同点) / 三带二 / 顺子(5张连续) /',
            '         同一色(5张同色) / 一条龙(5张同色连续) / 4带1。',
            '         2、3、王不能进顺子和一条龙，王只能单出。',
            '【交牌】从第 2 局起，先在开局交换牌：',
            '   ① 上一局输了的乌龟，把手上最大的牌交给敌人；',
            '   ② 敌人把大牌按 导游 > 中游 的顺序各给一张；',
            '   ③ 导游 / 中游各还一张小牌给敌人。',
            '   刚换来的牌当次不能马上再换出去。',
            '【积分】初始 1000 分，赢一局 +15，输一局 -10。',
        ].join('\n');

        const body = createMultiline(text, 18, cc.color(232, 240, 225), 0, 12, w - 90);
        body.parent = p;
        body.anchorY = 0.5;

        const close = createButton('知道了', {
            fill: cc.color(226, 150, 50), fontSize: 22, width: 160, height: 48,
        }, () => this.clearPop());
        close.parent = p;
        close.setPosition(0, -h / 2 + 44);
    }
}
