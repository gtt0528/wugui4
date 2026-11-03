/**
 * 乌龟4 —— 房间等待页（褐色基调）
 *
 * 「创建房间 / 加入房间」之后停留在这个页面，直到房主点「开始游戏」。
 * 全部用代码绘制（和项目其它界面一致，零美术素材）：
 *   - 4 个座位卡片：圆形头像（昵称首字 + 性别配色）、昵称、性别、房主标记、掉线标记
 *   - 空位显示「等待玩家加入…」
 *   - 房主可见「开始游戏」（满 4 人才可用）和「解散房间」；所有人可见「退出房间」
 *   - 浏览器下多一个「复制链接」，方便同一台电脑开多个标签页自测
 *
 * 这个类不碰网络，只负责画；消息由 MenuScene 转发进来。
 */

import { createLabel, createButton, createPanel, createMultiline } from './CardView';

const W = 1280;
const H = 720;

/** 褐色主题 */
const C_BG = cc.color(43, 31, 22);
const C_PANEL = cc.color(62, 46, 32, 252);
const C_PANEL_LINE = cc.color(140, 106, 70);
const C_CARD = cc.color(74, 55, 38);
const C_CARD_EMPTY = cc.color(52, 39, 27);
const C_CARD_LINE = cc.color(112, 86, 58);
const C_GOLD = cc.color(232, 184, 96);
const C_TEXT = cc.color(246, 232, 206);
const C_TEXT_DIM = cc.color(176, 150, 118);
const C_TEXT_HINT = cc.color(150, 126, 100);
const C_MALE = cc.color(72, 116, 168);
const C_FEMALE = cc.color(190, 104, 140);
const C_UNKNOWN = cc.color(120, 104, 88);
const C_DANGER = cc.color(150, 66, 52);
const C_OFFLINE = cc.color(224, 120, 100);

export interface RoomMemberView {
    seat: number;
    nickname?: string;
    gender?: number;
    avatar?: string;
    connected?: boolean;
    owner?: boolean;
    empty?: boolean;
}

export interface RoomViewState {
    code: string;
    mySeat: number;
    members: RoomMemberView[];
    count: number;
    need: number;
    isPrivate: boolean;
}

export interface RoomViewCallbacks {
    /** 房主点「开始游戏」 */
    onStart: () => void;
    /** 房主点「解散房间」 */
    onDissolve: () => void;
    /** 点「退出房间」 */
    onLeave: () => void;
    /** 浏览器下点「复制链接」 */
    onCopy: () => void;
    /** 只是想提示一句话（例如人没满就点开始） */
    onTip: (msg: string) => void;
}

export class RoomWaitView {

    private root: cc.Node;
    private cb: RoomViewCallbacks;
    private state: RoomViewState | null = null;

    constructor(parent: cc.Node, cb: RoomViewCallbacks) {
        this.cb = cb;
        this.root = new cc.Node('roomWait');
        this.root.parent = parent;
        this.root.active = false;
    }

    get visible(): boolean {
        return this.root.active;
    }

    show(state: RoomViewState): void {
        this.root.active = true;
        this.render(state);
    }

    update(state: RoomViewState): void {
        if (!this.root.active) return;
        this.render(state);
    }

    hide(): void {
        this.root.active = false;
        this.state = null;
        this.clear();
    }

    destroy(): void {
        if (this.root && this.root.isValid) this.root.destroy();
    }

    // ================= 绘制 =================

    private clear(): void {
        if (!this.root || !this.root.isValid) return;
        const kids = this.root.children.slice();
        for (const k of kids) k.destroy();
        this.root.removeAllChildren();
    }

    private render(state: RoomViewState): void {
        this.state = state;
        this.clear();

        // 背景
        const bg = new cc.Node('bg');
        const bgG = bg.addComponent(cc.Graphics);
        bgG.rect(-W / 2, -H / 2, W, H);
        bgG.fillColor = C_BG;
        bgG.fill();
        bg.parent = this.root;

        // 主面板
        const panel = createPanel(1180, 636, C_PANEL, C_PANEL_LINE, 20);
        panel.parent = this.root;
        panel.setPosition(0, 6);

        const isOwner = state.mySeat >= 0 && this.isMySeatOwner(state);
        const full = state.count >= state.need;

        // 顶部：房间号
        const title = createLabel(`房间 ${state.code}`, 40, C_GOLD, -60, 268);
        title.parent = this.root;

        // 复制链接（只在浏览器有意义，微信里走右上角转发）
        if (cc.sys.isBrowser) {
            const copy = createButton('复制链接', {
                fill: cc.color(92, 72, 52), textColor: C_TEXT,
                fontSize: 18, width: 132, height: 44,
            }, () => this.cb.onCopy());
            copy.parent = this.root;
            copy.setPosition(470, 266);
        }

        const sub = createLabel(
            `${state.count}/${state.need} 人已就位${isOwner ? ' · 你是房主' : ''}`,
            20, C_TEXT_DIM, 0, 228);
        sub.parent = this.root;

        // 4 个座位（2 × 2）
        const slots: RoomMemberView[] = [];
        for (let s = 0; s < state.need; s++) {
            const found = state.members.find((m) => m.seat === s);
            slots.push(found || { seat: s, empty: true });
        }
        const xs = [-245, 245];
        const ys = [118, -52];
        slots.forEach((m, i) => {
            const card = this.mkSeatCard(m, state, xs[i % 2], ys[Math.floor(i / 2)]);
            card.parent = this.root;
        });

        // 提示语
        const hint = this.hintText(state, isOwner, full);
        const hintLbl = createLabel(hint, 20, full ? C_GOLD : C_TEXT_HINT, 0, -176);
        hintLbl.parent = this.root;

        // 按钮
        if (isOwner) {
            const startBtn = createButton(full ? '开始游戏' : `还差 ${state.need - state.count} 人`, {
                fill: full ? C_GOLD : cc.color(86, 68, 50),
                textColor: full ? cc.color(43, 31, 22) : cc.color(156, 132, 106),
                fontSize: 24, width: 230, height: 60,
            }, () => {
                if (!full) { this.cb.onTip(`还差 ${state.need - state.count} 人才能开始`); return; }
                this.cb.onStart();
            });
            startBtn.parent = this.root;
            startBtn.setPosition(-180, -252);

            const dis = createButton('解散房间', {
                fill: C_DANGER, textColor: cc.color(255, 240, 232),
                fontSize: 22, width: 200, height: 60,
            }, () => this.cb.onDissolve());
            dis.parent = this.root;
            dis.setPosition(110, -252);

            const leave = createButton('退出房间', {
                fill: cc.color(96, 78, 60), textColor: C_TEXT,
                fontSize: 22, width: 180, height: 60,
            }, () => this.cb.onLeave());
            leave.parent = this.root;
            leave.setPosition(390, -252);
        } else {
            const leave = createButton('退出房间', {
                fill: cc.color(96, 78, 60), textColor: C_TEXT,
                fontSize: 22, width: 220, height: 60,
            }, () => this.cb.onLeave());
            leave.parent = this.root;
            leave.setPosition(0, -252);
        }
    }

    private isMySeatOwner(state: RoomViewState): boolean {
        const me = state.members.find((m) => m.seat === state.mySeat);
        return !!(me && me.owner);
    }

    private hintText(state: RoomViewState, isOwner: boolean, full: boolean): string {
        if (isOwner) {
            if (full) return '人齐了，点「开始游戏」发牌';
            return `把房间号 ${state.code} 发给好友，满 4 人就能开始`;
        }
        if (full) return '人齐了，等房主点「开始游戏」';
        return `等人中… 还差 ${state.need - state.count} 人`;
    }

    private mkSeatCard(m: RoomMemberView, state: RoomViewState, x: number, y: number): cc.Node {
        const w = 470;
        const h = 150;
        const n = new cc.Node('seat' + m.seat);
        n.setPosition(x, y);

        const isMine = !m.empty && m.seat === state.mySeat;
        const g = n.addComponent(cc.Graphics);
        g.roundRect(-w / 2, -h / 2, w, h, 14);
        g.fillColor = m.empty ? C_CARD_EMPTY : C_CARD;
        g.fill();
        g.strokeColor = isMine ? C_GOLD : C_CARD_LINE;
        g.lineWidth = isMine ? 3 : 1.5;
        g.stroke();

        // 座位号（左上）
        const no = createLabel(`${m.seat + 1} 号位`, 16, C_TEXT_HINT, -w / 2 + 58, h / 2 - 24);
        no.parent = n;

        if (m.empty) {
            // 空位：虚线圆 + 提示
            const av = new cc.Node('emptyAvatar');
            av.setPosition(-150, -4);
            const ag = av.addComponent(cc.Graphics);
            ag.circle(0, 0, 40);
            ag.strokeColor = cc.color(112, 90, 64);
            ag.lineWidth = 2;
            ag.stroke();
            av.parent = n;

            const q = createLabel('?', 34, cc.color(122, 100, 74), -150, -4);
            q.parent = n;

            const wait = createLabel('等待玩家加入…', 22, C_TEXT_HINT, 40, -4);
            wait.parent = n;
            return n;
        }

        // 头像：圆形底色（按性别）+ 昵称首字
        const av = new cc.Node('avatar');
        av.setPosition(-150, -4);
        const ag = av.addComponent(cc.Graphics);
        ag.circle(0, 0, 44);
        ag.fillColor = this.genderColor(m.gender);
        ag.fill();
        ag.strokeColor = cc.color(240, 220, 190, 110);
        ag.lineWidth = 2;
        ag.stroke();
        av.parent = n;

        const nick = (m.nickname || '?');
        const ch = nick.slice(0, 1);
        const cl = createLabel(ch, 40, cc.color(255, 252, 246), -150, -4);
        cl.parent = n;

        // 昵称
        const nickLbl = createLabel(nick, 26, C_TEXT, 46, 30);
        nickLbl.parent = n;

        // 性别
        const sexText = m.gender === 1 ? '男' : m.gender === 2 ? '女' : '未设置';
        const sexLbl = createLabel(sexText, 18, C_TEXT_DIM, 46, -6);
        sexLbl.parent = n;

        // 房主标签
        if (m.owner) {
            const badge = createPanel(74, 30, C_GOLD, undefined, 8);
            badge.parent = n;
            badge.setPosition(46, -44);
            const bl = createLabel('房主', 17, cc.color(43, 31, 22), 46, -44);
            bl.parent = n;
        }

        // 自己 / 掉线
        const tags: string[] = [];
        if (isMine) tags.push('你');
        if (m.connected === false) tags.push('掉线重连中');
        if (tags.length) {
            const tag = createLabel(tags.join(' · '), 16, m.connected === false ? C_OFFLINE : C_TEXT_HINT, 146, -44);
            tag.parent = n;
        }

        return n;
    }

    private genderColor(gender?: number): cc.Color {
        if (gender === 1) return C_MALE;
        if (gender === 2) return C_FEMALE;
        return C_UNKNOWN;
    }
}
