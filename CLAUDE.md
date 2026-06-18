# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

超星学习通助手 — 两个独立的 Tampermonkey 用户脚本，分别解决超星学习通平台的编辑器限制和批量发帖需求。纯 JavaScript，无构建系统，无 TypeScript，无运行时依赖。

## Commands

```bash
npm install            # 安装开发依赖，首次 clone 后执行
npm run lint           # ESLint 检查 src/
npm run format         # Prettier 格式化 src/**/*.js
npm run build          # 构建 dist/：复制 src/ 并替换 @namespace/@author
npm run build:version  # 构建并指定版本号，如 npm run build:version -- --version 1.2.0
```

构建脚本 `scripts/build.js` 自动化 src/ → dist/ 同步，替换 `@namespace`（Lumjiel）和 `@author`（Lumjiel）。

### Pre-commit Hook

首次 clone 后执行 `npm run prepare` 安装 git pre-commit hook，commit 时自动对 `src/` 下的 JS 文件运行 `eslint --fix` + `prettier --write`。

## Architecture

```
src/
  code-enhancer/index.js   # 脚本1：编辑器解锁（~100行）
  auto-poster/index.js     # 脚本2：自动发帖（~430行）
scripts/
  build.js                 # 构建脚本：src/ → dist/ + 元数据替换
  hooks/pre-commit         # Git pre-commit hook 模板
dist/
  code-enhancer.user.js    # 发布版（@namespace/@author 已更新）
  auto-poster.user.js      # 发布版
```

两个脚本完全独立，共享零代码，各自是单文件 IIFE。

### Code Enhancer

- **不需要** Greasemonkey API（`@grant: none`）
- 三个核心函数：`unlockEditor()`（移除 onpaste/oncopy 拦截 + 强制 user-select）、`fixCodeMirrorPaste()`（轮询并 patch CodeMirror 实例的粘贴处理）、`init()`（挂 MutationObserver 应对动态 DOM）
- 用 `stopImmediatePropagation()` 在 capture 阶段拦截超星的事件监听器

### Auto Poster

- **依赖** Greasemonkey API：`GM_addStyle`、`GM_setValue`/`GM_getValue`/`GM_deleteValue`、`unsafeWindow`
- **跨域 iframe 架构**：讨论区内容在 `groupweb.chaoxing.com` 的跨域 iframe 内，脚本通过 `@match` 同时匹配两个域名，在 iframe 上下文中运行（`window.top !== window` 时才执行），主页面直接跳过
- 分层结构：配置层（GM 持久化存储）→ 任务池（FIFO 队列 + 失败回滚）→ UI 层（浮动面板，全内联 CSS）→ DOM 交互层（UEditor iframe 填充）→ 主循环（发帖 + 间隔等待）
- 存储键：`chaoxing_config_v12`（用户配置）、`chaoxing_task_pool_v12`（待发任务队列）
- `init()` 通过检测 `iframe#ueditor_0` / `window.UE` 判断编辑器是否就绪，未就绪时用 MutationObserver 等待动态加载
- 页面刷新后通过 `checkAndResumeTask()` 自动恢复未完成任务
- DOM 交互依赖超星的 UEditor 实例（`iframe#ueditor_0`），需通过 `unsafeWindow.UE` 触发 `contentChange` 事件
- 「新建话题」按钮通过 `.createTopic` 类选择器定位，发布按钮通过 `.jb_btn_92:not(.jb_btn_92_disable)` 定位

## Code Conventions

- ESLint: `eslint:recommended`，`no-unused-vars: warn`，`no-console: off`，环境 `browser + es2021 + greasemonkey`
- Prettier: `singleQuote: true`，`tabWidth: 4`，`trailingComma: "none"`
- UserScript metadata 块中的 `@match` 需同时覆盖主页面（`*.chaoxing.com`）和讨论区 iframe（`groupweb.chaoxing.com`），修改时注意保持一致

## Development Notes

- 修改 `src/` 后执行 `npm run build` 自动同步到 `dist/`，脚本会替换 `@namespace` 和 `@author` 为发布值
- 发布新版本时用 `npm run build:version -- --version x.y.z` 统一更新所有脚本的版本号
- Auto Poster 中的关键词匹配（"新建话题"、"发布"等）和 CSS 选择器（`.jb_btn_92`、`.createTopic`、`iframe#ueditor_0`）硬编码了超星平台的 DOM 结构，平台改版时需要对应更新
- 超星讨论区已迁移至 `groupweb.chaoxing.com` 的跨域 iframe，脚本在 iframe 内运行；若平台再次调整架构（如取消 iframe 或更换编辑器），需重新排查 DOM 结构
- 两个脚本的 `@run-at` 均为 `document-end`，依赖 DOM 已加载但不等待所有子资源
