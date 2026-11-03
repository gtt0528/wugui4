/**
 * 乌龟4 —— 编译产物自检
 *
 * 背景：
 *   Cocos Creator 2.4 的 quick-compiler 是**增量**编译的。如果 temp/quick-scripts/src
 *   里残留了某个脚本的 .js.map，但对应的 .js 被删掉了（比如手抖执行了 tsc --outDir
 *   到源码目录、又删了 js 却漏了 map），编译器会误判"这个文件已经编译过"从而跳过它。
 *   运行时就会报一串：
 *     load script [../core/Card] failed : Error: Cannot find module '../core/Card'
 *
 * 本脚本做两件事：
 *   1. 检查 assets/scripts 下有没有散落的 .js / .js.map（源码目录绝不该有编译产物）
 *   2. 检查 quick-scripts 里 .js 与 .js.map 是否成对存在
 *
 * 用法：node tools/check-scripts.js
 * 有问题会以非 0 退出码结束，并打印修复命令。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'scripts');
const QC_SRC = path.join(ROOT, 'temp', 'quick-scripts', 'src');

let problems = 0;

function walk(dir, out) {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

// ---------- 1. 源码目录不该有编译产物 ----------
console.log('[1] 检查 assets/scripts 下是否有散落的编译产物…');
const strayFiles = walk(SRC, []).filter((f) => /\.js$|\.js\.map$/.test(f));
if (strayFiles.length === 0) {
    console.log('    正常：没有 .js / .js.map');
} else {
    problems += strayFiles.length;
    console.log('    ✗ 发现编译产物（Cocos 会把它当成脚本重复加载）：');
    for (const f of strayFiles) console.log('      - ' + path.relative(ROOT, f));
    console.log('    修复：删除上面这些文件（保留 .ts 与 .ts.meta）');
}

// ---------- 2. .js 与 .js.map 必须成对 ----------
console.log('[2] 检查 quick-scripts 缓存完整性…');
if (!fs.existsSync(QC_SRC)) {
    console.log('    跳过：temp/quick-scripts 不存在（下次打开编辑器会全量重编，属正常）');
} else {
    const files = walk(QC_SRC, []);
    const jsFiles = files.filter((f) => f.endsWith('.js'));
    const mapFiles = files.filter((f) => f.endsWith('.js.map'));
    const jsSet = new Set(jsFiles.map((f) => f.replace(/\.js$/, '')));
    const mapSet = new Set(mapFiles.map((f) => f.replace(/\.js\.map$/, '')));

    const orphanMaps = [...mapSet].filter((k) => !jsSet.has(k));
    const missingMaps = [...jsSet].filter((k) => !mapSet.has(k) && path.basename(k) !== '__qc_index__' && path.basename(k) !== '__qc_bundle__' && path.basename(k) !== '__quick_compile__');

    if (orphanMaps.length === 0 && missingMaps.length === 0) {
        console.log(`    正常：${jsFiles.length} 个脚本，.js 与 .js.map 一一对应`);
    } else {
        if (orphanMaps.length) {
            problems += orphanMaps.length;
            console.log('    ✗ 有 .js.map 但缺 .js（增量编译器会误判"已编译"而跳过，导致运行时 Cannot find module）：');
            for (const k of orphanMaps) console.log('      - ' + path.relative(ROOT, k) + '.js');
        }
        if (missingMaps.length) {
            problems += missingMaps.length;
            console.log('    ✗ 有 .js 但缺 .js.map：');
            for (const k of missingMaps) console.log('      - ' + path.relative(ROOT, k) + '.js.map');
        }
        console.log('    修复：删除整个 temp/quick-scripts 目录，然后在 Cocos 编辑器里重新打开工程');
        console.log('          命令：rm -rf temp/quick-scripts');
    }
}

// ---------- 3. 每个 .ts 是否都有对应的 .meta ----------
console.log('[3] 检查每个 .ts 是否都有 .meta…');
const tsFiles = walk(SRC, []).filter((f) => f.endsWith('.ts'));
const noMeta = tsFiles.filter((f) => !fs.existsSync(f + '.meta'));
if (noMeta.length === 0) {
    console.log(`    正常：${tsFiles.length} 个 .ts 都有 .meta`);
} else {
    // 缺 meta 不算错误：编辑器会自动补一个。但按 uuid 引用过的脚本缺 meta 会丢引用。
    console.log(`    提示：${noMeta.length} 个 .ts 没有 .meta（编辑器会自动生成，若报 uuid 丢失请检查）`);
    for (const f of noMeta) console.log('      - ' + path.relative(ROOT, f));
}

console.log('');
if (problems > 0) {
    console.log(`结果：发现 ${problems} 个问题，已在上方列出修复方式。`);
    process.exit(1);
} else {
    console.log('结果：全部正常。');
}
