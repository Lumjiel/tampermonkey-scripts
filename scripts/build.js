#!/usr/bin/env node
/**
 * 构建脚本：将 src/ 下的脚本复制到 dist/，并替换 @namespace/@author 为发布值
 * 用法：node scripts/build.js [--version 1.2.0]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');

// 从命令行参数读取版本号（可选）
const versionArg = process.argv.find((_, i, a) => a[i - 1] === '--version');
const version = versionArg || null;

// 脚本列表：[源目录名, 输出文件名]
const SCRIPTS = [
    ['code-enhancer', 'code-enhancer.user.js'],
    ['auto-poster', 'auto-poster.user.js'],
    ['auto-navigator', 'auto-navigator.user.js'],
    ['douyin-export', 'douyin-export.user.js'],
    ['douyin-maintain', 'douyin-maintain.user.js'],
    ['douyin-downloader', 'douyin-downloader.user.js']
];

// 发布时替换的字段
const REPLACEMENTS = [
    [/yourusername/g, 'Lumjiel'],
    [/YourName/g, 'Lumjiel']
];

if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
}

for (const [srcName, distName] of SCRIPTS) {
    const srcPath = path.join(SRC_DIR, srcName, 'index.js');
    const distPath = path.join(DIST_DIR, distName);

    if (!fs.existsSync(srcPath)) {
        console.error(`[build] 源文件不存在: ${srcPath}`);
        process.exit(1);
    }

    let content = fs.readFileSync(srcPath, 'utf-8');

    // 替换 @namespace 和 @author
    for (const [pattern, replacement] of REPLACEMENTS) {
        content = content.replace(pattern, replacement);
    }

    // 替换版本号（如果指定了 --version）
    if (version) {
        content = content.replace(
            /@version\s+[\d.]+/,
            `@version      ${version}`
        );
    }

    fs.writeFileSync(distPath, content, 'utf-8');
    console.log(`[build] ${srcName} → dist/${distName}`);
}

console.log('[build] 完成 ✅');
