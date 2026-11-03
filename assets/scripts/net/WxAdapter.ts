/**
 * 乌龟4 —— 微信小游戏适配层
 *
 * 设计原则：**所有方法在浏览器里都必须安全降级**。
 * 这样同一份代码既能在 Cocos 预览里（网页联机）跑，也能在微信小游戏里跑，
 * 不用维护两套入口，也不会因为少了 wx 就白屏。
 *
 * 覆盖：登录、分享（含房间号带参进入）、激励视频、前后台生命周期、震动。
 */

declare const wx: any;

/** 激励视频广告位 ID（微信公众平台 → 流量主 → 广告位 里创建，拿到后填这里） */
export const REWARD_AD_UNIT = '';

/** 是否在微信小游戏环境（用 connectSocket 判断，比 sys.platform 稳） */
export function isWechat(): boolean {
    try {
        return typeof wx !== 'undefined' && !!wx && typeof wx.connectSocket === 'function';
    } catch (e) {
        return false;
    }
}

// ================= 登录 =================

/**
 * wx.login 拿一次性 code，交给后端 `/api/auth/wx` 换 openid → JWT。
 * 浏览器里直接 reject，调用方用游客身份兜底。
 */
export function wxLogin(): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!isWechat() || typeof wx.login !== 'function') {
            reject(new Error('非微信环境'));
            return;
        }
        wx.login({
            success: (res: any) => {
                if (res && res.code) resolve(String(res.code));
                else reject(new Error('wx.login 未返回 code'));
            },
            fail: (err: any) => reject(new Error('wx.login 失败: ' + JSON.stringify(err))),
        });
    });
}

// ================= 启动参数（分享带房间号进来） =================

/** 读取启动参数，例如好友分享带上 `?code=123456` 时能直接进房 */
export function launchQuery(): { [k: string]: string } {
    if (!isWechat()) return {};
    try {
        const opt = wx.getLaunchOptionsSync ? wx.getLaunchOptionsSync() : null;
        return (opt && opt.query) || {};
    } catch (e) {
        return {};
    }
}

// ================= 分享 =================

/**
 * 配置转发：右上角菜单 + 主动转发都用同一份文案。
 * `getInfo` 每次调用时现取，这样房间号变了文案也跟着变。
 */
export function setupShare(getInfo: () => { title: string; query?: string }): void {
    if (!isWechat()) return;
    try {
        if (wx.showShareMenu) {
            wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
        }
        if (wx.onShareAppMessage) {
            wx.onShareAppMessage(() => {
                const info = getInfo();
                return { title: info.title, query: info.query || '' };
            });
        }
        if (wx.onShareTimeline) {
            wx.onShareTimeline(() => {
                const info = getInfo();
                return { title: info.title, query: info.query || '' };
            });
        }
    } catch (e) { /* 忽略 */ }
}

/** 主动拉起转发（房间里「邀请好友」按钮用） */
export function share(title: string, query = ''): void {
    if (!isWechat()) {
        cc.log('[分享] 非微信环境，跳过：', title, query);
        return;
    }
    try {
        if (wx.shareAppMessage) wx.shareAppMessage({ title, query });
    } catch (e) { /* 忽略 */ }
}

// ================= 激励视频 =================

/**
 * 看一个激励视频。resolve(true) = 完整看完，可以发奖励。
 * 浏览器 / 未配广告位 → resolve(false)，调用方走兜底（直接给）。
 */
export function showRewardedAd(adUnitId: string = REWARD_AD_UNIT): Promise<boolean> {
    return new Promise((resolve) => {
        if (!isWechat() || !adUnitId || typeof wx.createRewardedVideoAd !== 'function') {
            resolve(false);
            return;
        }
        try {
            const ad = wx.createRewardedVideoAd({ adUnitId });
            const onClose = (res: any) => {
                try { ad.offClose(onClose); } catch (e) { /* 忽略 */ }
                // isEnded === true 才算完整观看
                resolve(!!(res && res.isEnded));
            };
            ad.onClose(onClose);
            ad.onError(() => {
                try { ad.offClose(onClose); } catch (e) { /* 忽略 */ }
                resolve(false);
            });
            ad.show().catch(() => {
                ad.load()
                    .then(() => ad.show())
                    .catch(() => resolve(false));
            });
        } catch (e) {
            resolve(false);
        }
    });
}

// ================= 前后台 =================

/** 回到前台（切回来、解锁屏幕） */
export function onAppShow(cb: () => void): void {
    if (!isWechat()) return;
    try { if (wx.onShow) wx.onShow(() => cb()); } catch (e) { /* 忽略 */ }
}

/** 切到后台（微信里聊天、锁屏）—— 用来暂停本地动画/提示，服务端会继续托管 */
export function onAppHide(cb: () => void): void {
    if (!isWechat()) return;
    try { if (wx.onHide) wx.onHide(() => cb()); } catch (e) { /* 忽略 */ }
}

// ================= 触感 =================

/** 轻震动（出牌、选中）／强震动（赢局、被抓） */
export function vibrate(strong = false): void {
    if (!isWechat()) return;
    try {
        if (strong) {
            if (wx.vibrateLong) wx.vibrateLong({});
        } else {
            if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
        }
    } catch (e) { /* 忽略 */ }
}
