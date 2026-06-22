# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tampermonkey 用户脚本合集 — 超星学习通助手（编辑器增强 + 自动发帖）+ 抖音批量管理（数据采集 + 批量取消收藏/喜欢）。纯 JavaScript，无构建系统，无 TypeScript，无运行时依赖。

## Commands

```bash
npm install            # 安装开发依赖
npm run lint           # ESLint 检查 src/
npm run format         # Prettier 格式化 src/**/*.js
npm run build          # 构建 dist/：复制 src/ 并替换 @namespace/@author
npm run build:version  # 构建并指定版本号
```

## Architecture

```
src/
  code-enhancer/index.js    # 脚本1：编辑器解锁（~100行）
  auto-poster/index.js      # 脚本2：自动发帖（~430行）
  auto-navigator/index.js   # 脚本3：自动导航
  douyin-export/index.js    # 脚本4：抖音数据采集
  douyin-maintain/index.js  # 脚本5：抖音批量管理（API直调）
scripts/
  build.js                  # src/ → dist/ + 元数据替换
dist/
  *.user.js                 # 发布版
```

五个脚本完全独立，共享零代码，各自是单文件 IIFE。

### 学习通脚本

- **code-enhancer**：`@grant: none`，用 `stopImmediatePropagation()` 在 capture 阶段拦截超星的事件监听器
- **auto-poster**：依赖 `GM_addStyle`/`GM_setValue`/`GM_getValue`，跨域 iframe 架构（讨论区在 `groupweb.chaoxing.com`）

### 抖音脚本

- **douyin-export**：`@grant: none`，拦截 fetch/XHR 捕获收藏 API，滚动加载 + 数据导出
- **douyin-maintain**：`@grant: GM_setValue/GM_getValue`，直接调用抖音 API（`/aweme/collect/` + `/commit/item/digg/`），按收藏/喜欢自动路由

### 抖音 API 格式

- 取消收藏：`POST /aweme/v1/web/aweme/collect/?device_platform=webapp&aid=6383` → `action=0&aweme_id=xxx&aweme_type=0`
- 取消点赞：`POST /aweme/v1/web/commit/item/digg/?device_platform=webapp&aid=6383` → `aweme_id=xxx&item_type=0&type=0`
- 无需 msToken/a_bogus 签名，浏览器 cookie 自动鉴权

## Code Conventions

- ESLint: `eslint:recommended`，`no-unused-vars: warn`，`no-console: off`
- Prettier: `singleQuote: true`，`tabWidth: 4`，`trailingComma: "none"`
- 每个脚本是独立 IIFE，不共享代码

## Development Notes

- 修改 `src/` 后执行 `npm run build` 同步到 `dist/`
- 抖音脚本修改后也需要手动复制到 `E:\claudecode\wiki\douyin\` 目录
