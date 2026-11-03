/**
 * 乌龟4 —— 牌面与通用 UI 绘制
 *
 * 全部用 Graphics + Label 画出，不依赖任何美术素材（首包 4MB 限制下这是优势）。
 * 以后接入正式美术时，只需把 createCardNode 换成 Sprite 加载。
 */

import { Card, Color } from '../core/Card';

export const CARD_W = 62;
export const CARD_H = 86;

/** 创建一张牌（faceUp=false 显示牌背） */
export function createCardNode(card: Card | null, faceUp: boolean): cc.Node {
    const node = new cc.Node(faceUp && card ? card.name : 'card_back');
    node.setContentSize(CARD_W, CARD_H);

    const g = node.addComponent(cc.Graphics);
    const w = CARD_W;
    const h = CARD_H;

    // 阴影
    g.roundRect(-w / 2 + 1, -h / 2 - 2, w, h, 6);
    g.fillColor = cc.color(0, 0, 0, 60);
    g.fill();

    if (!faceUp || !card) {
        // 牌背
        g.roundRect(-w / 2, -h / 2, w, h, 6);
        g.fillColor = cc.color(48, 84, 150);
        g.fill();
        g.strokeColor = cc.color(240, 240, 250);
        g.lineWidth = 2;
        g.stroke();
        // 牌背内花纹：斜线网格
        g.roundRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10, 4);
        g.strokeColor = cc.color(120, 165, 220);
        g.lineWidth = 1;
        g.stroke();
        g.moveTo(-w / 2 + 8, h / 2 - 10);
        g.lineTo(w / 2 - 8, -h / 2 + 10);
        g.moveTo(-w / 2 + 8, 0);
        g.lineTo(0, -h / 2 + 10);
        g.moveTo(0, h / 2 - 10);
        g.lineTo(w / 2 - 8, 0);
        g.stroke();
        return node;
    }

    // 牌面
    g.roundRect(-w / 2, -h / 2, w, h, 6);
    g.fillColor = cc.color(252, 252, 250);
    g.fill();
    g.strokeColor = cc.color(150, 150, 150);
    g.lineWidth = 1;
    g.stroke();

    const isRed = card.color === Color.Red;
    const textColor = card.isJoker
        ? cc.color(200, 30, 40)
        : (isRed ? cc.color(200, 30, 40) : cc.color(25, 25, 25));

    if (card.isJoker) {
        // 大小王：竖排「大王 / 小王」+ 星标
        const big = card.name === '大王';
        const col = big ? cc.color(190, 25, 35) : cc.color(30, 30, 30);

        const top = new cc.Node('jk_top');
        top.parent = node;
        top.setPosition(0, h / 2 - 22);
        const tl = top.addComponent(cc.Label);
        tl.string = big ? '大' : '小';
        tl.fontSize = 22;
        tl.lineHeight = 24;
        top.color = col;

        const bot = new cc.Node('jk_bot');
        bot.parent = node;
        bot.setPosition(0, h / 2 - 46);
        const bl = bot.addComponent(cc.Label);
        bl.string = '王';
        bl.fontSize = 22;
        bl.lineHeight = 24;
        bot.color = col;

        const star = new cc.Node('jk_star');
        star.parent = node;
        star.setPosition(0, -h / 2 + 20);
        const sl = star.addComponent(cc.Label);
        sl.string = '★';
        sl.fontSize = 20;
        sl.lineHeight = 22;
        star.color = big ? cc.color(220, 170, 40) : cc.color(120, 120, 130);

        return node;
    }

    // 左上角点数
    const corner = new cc.Node('corner');
    corner.parent = node;
    corner.setPosition(-w / 2 + 12, h / 2 - 15);
    const cl = corner.addComponent(cc.Label);
    cl.string = card.label;
    cl.fontSize = card.label === '10' ? 15 : 19;
    cl.lineHeight = 19;
    corner.color = textColor;

    // 左上角花色
    const cs = new cc.Node('suit');
    cs.parent = node;
    cs.setPosition(-w / 2 + 12, h / 2 - 33);
    const sl2 = cs.addComponent(cc.Label);
    sl2.string = card.suitSymbol;
    sl2.fontSize = 15;
    sl2.lineHeight = 17;
    cs.color = textColor;

    // 中央大花色
    const mid = new cc.Node('mid');
    mid.parent = node;
    mid.setPosition(0, -4);
    const ml = mid.addComponent(cc.Label);
    ml.string = card.suitSymbol;
    ml.fontSize = 34;
    ml.lineHeight = 36;
    mid.color = textColor;

    // 右下角倒置点数（模仿真牌）
    const rc = new cc.Node('corner2');
    rc.parent = node;
    rc.setPosition(w / 2 - 13, -h / 2 + 13);
    const rl = rc.addComponent(cc.Label);
    rl.string = card.label;
    rl.fontSize = card.label === '10' ? 14 : 17;
    rl.lineHeight = 17;
    rc.color = textColor;
    rc.angle = 180;

    return node;
}

/** 创建纯文字标签节点 */
export function createLabel(text: string, size: number, color: cc.Color, x: number, y: number): cc.Node {
    const n = new cc.Node('label');
    const l = n.addComponent(cc.Label);
    l.string = text;
    l.fontSize = size;
    l.lineHeight = size + 4;
    n.color = color;
    n.setPosition(x, y);
    return n;
}

/** 多行文本（居中） */
export function createMultiline(text: string, size: number, color: cc.Color, x: number, y: number, width = 0): cc.Node {
    const n = createLabel(text, size, color, x, y);
    const l = n.getComponent(cc.Label)!;
    l.lineHeight = size + 8;
    l.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
    if (width > 0) {
        l.enableWrapText = true;
        n.width = width;
        l.overflow = cc.Label.Overflow.RESIZE_HEIGHT;
    }
    return n;
}

export interface ButtonStyle {
    fill: cc.Color;
    textColor?: cc.Color;
    fontSize?: number;
    width?: number;
    height?: number;
    radius?: number;
    /** 描边色（不传则不描边） */
    stroke?: cc.Color;
}

/**
 * 通用按钮：Graphics 圆角矩形 + Label，带按下缩放反馈。
 * 返回的节点可直接 setPosition / 改 active。
 */
/**
 * 按钮点击的最小间隔（秒）。
 * 手机上一次按下常常被识别成 2~3 次 TOUCH_END，也常有玩家习惯连点。
 * 在按钮层统一挡一道，比在每个业务回调里各写一遍更可靠。
 */
const BUTTON_TAP_GAP = 0.2;

export function createButton(
    text: string,
    style: ButtonStyle,
    onClick: () => void,
): cc.Node {
    const bw = style.width || 160;
    const bh = style.height || 54;
    const n = new cc.Node('btn_' + text);
    n.setContentSize(bw, bh);

    const g = n.addComponent(cc.Graphics);
    drawRoundRect(g, bw, bh, style.radius === undefined ? 10 : style.radius, style.fill, style.stroke);

    const l = createLabel(text, style.fontSize || 24, style.textColor || cc.Color.WHITE, 0, 0);
    l.parent = n;
    const lb = l.getComponent(cc.Label)!;
    lb.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
    lb.verticalAlign = cc.Label.VerticalAlign.CENTER;
    lb.enableWrapText = true;
    l.width = bw - 12;

    // 上一次真正触发回调的时间，用于去重
    let lastFire = -99;
    // 是否处于"按下未抬起"的状态：一次完整触摸只认一次抬起
    let pressing = false;

    n.on(cc.Node.EventType.TOUCH_START, () => {
        pressing = true;
        n.scale = 0.95;
    });
    n.on(cc.Node.EventType.TOUCH_CANCEL, () => {
        pressing = false;
        n.scale = 1;
    });
    n.on(cc.Node.EventType.TOUCH_END, () => {
        n.scale = 1;
        // 没有对应的按下（比如从别处拖过来抬起）不算一次点击
        if (!pressing) return;
        pressing = false;

        const now = cc.director.getTotalTime() / 1000;
        if (now - lastFire < BUTTON_TAP_GAP) return;   // 连点/重复识别：丢弃
        lastFire = now;
        onClick();
    });
    return n;
}

/** 画圆角矩形（以节点中心为原点） */
export function drawRoundRect(
    g: cc.Graphics, w: number, h: number, r: number,
    fill: cc.Color, stroke?: cc.Color, lineWidth = 2,
): void {
    g.clear();
    g.roundRect(-w / 2, -h / 2, w, h, r);
    g.fillColor = fill;
    g.fill();
    if (stroke) {
        g.strokeColor = stroke;
        g.lineWidth = lineWidth;
        g.stroke();
    }
}

/** 创建一个带圆角背景的容器节点（不拦截触摸，仅做底板） */
export function createPanel(w: number, h: number, fill: cc.Color, stroke?: cc.Color, r = 14): cc.Node {
    const n = new cc.Node('panel');
    n.setContentSize(w, h);
    const g = n.addComponent(cc.Graphics);
    // 阴影
    g.roundRect(-w / 2 + 3, -h / 2 - 4, w, h, r);
    g.fillColor = cc.color(0, 0, 0, 70);
    g.fill();
    drawRoundRect(g, w, h, r, fill, stroke);
    return n;
}

/** 更新按钮文字（不重建节点） */
export function setButtonText(btn: cc.Node, text: string): void {
    const l = btn.getComponentInChildren(cc.Label);
    if (l) l.string = text;
}
