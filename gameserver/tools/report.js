#!/usr/bin/env node
/**
 * 试玩数据报告生成器
 *
 *   node tools/report.js        （或 npm run report）
 *
 * 读：gameserver/logs/rounds-*.jsonl （对战服每局自动落盘）
 * 写：仓库根目录 data/analysis.md   （一页 Markdown 报告，可直接给面试官/发行看）
 *    仓库根目录 data/raw/*.jsonl    （原始记录副本，一起提交进 git）
 *
 * 为什么要有这个脚本：
 *   jsonl 是给机器看的，人看不懂。面试官/发行商要看的是「多少局、完局率、掉线率、
 *   同一批人第二天还来不来」。这个脚本把原始流水变成这些数。
 *
 * 无第三方依赖，Node 14+ 直接跑。
 */
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(SERVER_DIR, '..');
const LOG_DIR = process.env.WUGUI_LOG_DIR || path.join(SERVER_DIR, 'logs');
const OUT_DIR = path.join(REPO_DIR, 'data');
const RAW_DIR = path.join(OUT_DIR, 'raw');

function readAll() {
    if (!fs.existsSync(LOG_DIR)) return [];
    const files = fs.readdirSync(LOG_DIR).filter((f) => /^rounds-.*\.jsonl$/.test(f)).sort();
    const rows = [];
    for (const f of files) {
        const full = path.join(LOG_DIR, f);
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        for (const line of lines) {
            const s = line.trim();
            if (!s) continue;
            try {
                const rec = JSON.parse(s);
                rec._file = f;
                rows.push(rec);
            } catch (e) {
                console.warn('[报告] 跳过坏行:', f, s.slice(0, 60));
            }
        }
    }
    rows.sort((a, b) => a.at - b.at);
    return rows;
}

/** 玩家键：优先 playerId（跨重启稳定），老记录没有就用昵称 */
function playerKey(seatRec) {
    if (seatRec.playerId && seatRec.playerId !== 'AI') return 'id:' + seatRec.playerId;
    return 'nick:' + (seatRec.nickname || '未知');
}

function shortId(p) {
    if (p.startsWith('nick:')) return p.slice(5);
    const id = p.slice(3);
    return id.length > 10 ? id.slice(0, 4) + '…' + id.slice(-3) : id;
}

function isWin(rec, seatRec) {
    if (seatRec.seat === rec.enemySeat) return !!rec.enemyWin;
    return Array.isArray(rec.finishOrder) && rec.finishOrder.includes(seatRec.seat);
}

function dayOf(rec) {
    return new Date(rec.at).toISOString().slice(0, 10);
}

function pct(n, d) {
    if (!d) return '—';
    return (n * 100 / d).toFixed(1) + '%';
}

function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function build(rows) {
    const real = rows.filter((r) => Array.isArray(r.seats));
    const days = Array.from(new Set(real.map(dayOf))).sort();

    // 玩家聚合
    const players = new Map();   // key → stats
    for (const rec of real) {
        for (const s of rec.seats) {
            if (s.ai || s.playerId === 'AI') continue;
            const key = playerKey(s);
            let p = players.get(key);
            if (!p) {
                p = {
                    key, nick: s.nickname || '未知',
                    rounds: 0, wins: 0, ranks: [], days: new Set(),
                    first: rec.at, last: rec.at, userIds: new Set(),
                };
                players.set(key, p);
            }
            p.rounds++;
            if (isWin(rec, s)) p.wins++;
            if (typeof s.rank === 'number' && s.rank > 0) p.ranks.push(s.rank);
            p.days.add(dayOf(rec));
            p.nick = s.nickname || p.nick;
            p.first = Math.min(p.first, rec.at);
            p.last = Math.max(p.last, rec.at);
            if (s.userId > 0) p.userIds.add(s.userId);
        }
    }

    const over = {
        rounds: real.length,
        days: days.length,
        players: players.size,
        avgDuration: Math.round(avg(real.map((r) => r.durationSec || 0))),
        enemyWinRate: real.length ? real.filter((r) => r.enemyWin).length / real.length : 0,
        offlineRounds: real.filter((r) => (r.offlineSeats || []).length > 0).length,
        timeoutRounds: real.filter((r) => (r.timeoutSeats || []).length > 0).length,
        aiRounds: real.filter((r) => (r.aiSeats || []).length > 0).length,
    };

    // 每日：玩家数 / 新玩家 / 回访 / 局数
    const firstDay = new Map();
    for (const [k, p] of players) {
        const d = new Date(p.first).toISOString().slice(0, 10);
        firstDay.set(k, d);
    }
    const daily = days.map((d) => {
        const inDay = new Set();
        for (const rec of real) {
            if (dayOf(rec) !== d) continue;
            for (const s of rec.seats) {
                if (s.ai || s.playerId === 'AI') continue;
                inDay.add(playerKey(s));
            }
        }
        let fresh = 0;
        for (const k of inDay) if (firstDay.get(k) === d) fresh++;
        return {
            day: d,
            rounds: real.filter((r) => dayOf(r) === d).length,
            players: inDay.size,
            fresh,
            returning: inDay.size - fresh,
        };
    });

    // 连续两天都来（次日留存）
    let retainedPairs = 0;
    let basePairs = 0;
    for (let i = 0; i < days.length - 1; i++) {
        const a = days[i];
        const b = days[i + 1];
        const pa = new Set(), pb = new Set();
        for (const [k, p] of players) {
            if (p.days.has(a)) pa.add(k);
            if (p.days.has(b)) pb.add(k);
        }
        basePairs += pa.size;
        for (const k of pa) if (pb.has(k)) retainedPairs++;
    }

    return { real, days, players, over, daily, retainedPairs, basePairs };
}

function render(m) {
    const L = [];
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    L.push('# 乌龟4 · 试玩数据报告');
    L.push('');
    L.push(`> 自动生成于 ${now}，数据源：\`gameserver/logs/rounds-*.jsonl\`（对战服逐局落盘，非手工整理）`);
    L.push('');

    if (!m.real.length) {
        L.push('## 还没有数据');
        L.push('');
        L.push('先跑一局：`cd gameserver && npm start`，开 4 个网页（或 4 台手机）打完一局，');
        L.push('记录会自动写进 `gameserver/logs/`，再执行 `npm run report`。');
        L.push('');
        return L.join('\n');
    }

    const o = m.over;
    L.push('## 一、总览');
    L.push('');
    L.push('| 指标 | 数值 | 说明 |');
    L.push('|---|---|---|');
    L.push(`| 总对局数 | **${o.rounds}** | 已完整打完并结算的局 |`);
    L.push(`| 覆盖天数 | ${o.days} | 有记录的自然日 |`);
    L.push(`| 真人玩家数 | **${o.players}** | 按设备号去重（AI 不计） |`);
    L.push(`| 平均单局时长 | ${Math.floor(o.avgDuration / 60)} 分 ${o.avgDuration % 60} 秒 | 发牌到结算 |`);
    L.push(`| 敌人胜率 | **${pct(o.enemyWinRate * o.rounds, o.rounds)}** | 平衡性监控，健康区间 45%–55% |`);
    L.push(`| 有掉线的局 | ${o.offlineRounds}（${pct(o.offlineRounds, o.rounds)}） | 掉线不再解散房间，由托管打完 |`);
    L.push(`| 触发托管的局 | ${o.timeoutRounds}（${pct(o.timeoutRounds, o.rounds)}） | 有人超时未操作 |`);
    L.push(`| 机器人补位的局 | ${o.aiRounds}（${pct(o.aiRounds, o.rounds)}） | 人不够时开局，比凑不齐强 |`);
    L.push('');

    if (m.days.length > 1) {
        L.push('## 二、留存（给发行/公司看的关键指标）');
        L.push('');
        L.push('| 日期 | 局数 | 当日玩家 | 新玩家 | 回访玩家 |');
        L.push('|---|---|---|---|---|');
        for (const d of m.daily) {
            L.push(`| ${d.day} | ${d.rounds} | ${d.players} | ${d.fresh} | ${d.returning} |`);
        }
        L.push('');
        L.push(`相邻两天都在的玩家：**${m.retainedPairs} / ${m.basePairs}**（${pct(m.retainedPairs, m.basePairs)}）`);
        L.push('');
        L.push('> 注：只统计相邻日，不是严格的「次日留存」口径；跨多天中间断一天的不算回来。');
        L.push('');
    }

    L.push('## 三、玩家明细');
    L.push('');
    L.push('| 玩家 | 局数 | 胜 | 负 | 胜率 | 平均名次 | 活跃天数 | 最近一次 |');
    L.push('|---|---|---|---|---|---|---|---|');
    const list = Array.from(m.players.values()).sort((a, b) => b.rounds - a.rounds);
    for (const p of list) {
        const lost = p.rounds - p.wins;
        const avgRank = p.ranks.length ? (p.ranks.reduce((a, b) => a + b, 0) / p.ranks.length).toFixed(2) : '—';
        const last = new Date(p.last).toISOString().slice(0, 16).replace('T', ' ');
        L.push(`| ${p.nick}（${shortId(p.key)}） | ${p.rounds} | ${p.wins} | ${lost} | ${pct(p.wins, p.rounds)} | ${avgRank} | ${p.days.size} | ${last} |`);
    }
    L.push('');
    L.push('> 名次：1=导游、2=中游、3=尾游，只对出完牌的乌龟有效；敌人与被抓龟不计入平均名次。');
    L.push('');

    L.push('## 四、口径说明');
    L.push('');
    L.push('- **局 = 一格记录**，只有打到结算的才落盘，中途解散的不计入，所以「完局率」要看局数与实际开局次数的差；');
    L.push('- **玩家去重按 client playerId**（存在玩家设备上，服务重启不变）；老记录没有该字段时退化为昵称；');
    L.push('- **胜** 定义：敌人出完且你是敌人 = 胜；你是乌龟且出完牌 = 胜；');
    L.push('- 原始记录在 `data/raw/`，每行一局，可直接导入 backend `/api/matches`。');
    L.push('');
    return L.join('\n');
}

function main() {
    const rows = readAll();
    const model = build(rows);
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });

    // 原始记录副本：一起进 git，换机器/重装也不丢
    const copied = [];
    if (fs.existsSync(LOG_DIR)) {
        for (const f of fs.readdirSync(LOG_DIR).filter((x) => /^rounds-.*\.jsonl$/.test(x))) {
            fs.copyFileSync(path.join(LOG_DIR, f), path.join(RAW_DIR, f));
            copied.push(f);
        }
    }

    const md = render(model);
    const outFile = path.join(OUT_DIR, 'analysis.md');
    fs.writeFileSync(outFile, md, 'utf8');

    console.log(`[报告] 读了 ${rows.length} 局记录`);
    console.log(`[报告] 已生成 ${path.relative(REPO_DIR, outFile)}`);
    console.log(`[报告] 原始记录已复制 ${copied.length} 个文件到 ${path.relative(REPO_DIR, RAW_DIR)}/`);
    if (!rows.length) console.log('[报告] 提示：还没打过局，先去玩一局再跑。');
}

main();
