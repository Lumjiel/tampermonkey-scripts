# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tampermonkey 用户脚本合集 — 超星学习通助手（编辑器增强 + 自动发帖 + 自动导航）+ 抖音工具链（数据采集 + 批量管理 + 视频下载器）。纯 JavaScript，无 TypeScript，无运行时依赖（lamejs 通过 `@require` 引入）。

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
  code-enhancer/index.js      # 脚本1：编辑器解锁（~100行）
  auto-poster/index.js        # 脚本2：自动发帖（~430行）
  auto-navigator/index.js     # 脚本3：自动导航
  douyin-export/index.js      # 脚本4：抖音数据采集
  douyin-maintain/index.js    # 脚本5：抖音批量管理（API直调）
  douyin-downloader/index.js  # 脚本6：抖音视频下载器（~1200行）
scripts/
  build.js                    # src/ → dist/ + 元数据替换（SCRIPTS 数组注册脚本）
dist/
  *.user.js                   # 发布版
```

六个脚本完全独立，共享零代码，各自是单文件 IIFE。新增脚本三步：`src/<name>/index.js` → `build.js` 的 SCRIPTS 数组加一行 → `npm run build`。

### 学习通脚本

- **code-enhancer**：`@grant: none`，用 `stopImmediatePropagation()` 在 capture 阶段拦截超星的事件监听器
- **auto-poster**：依赖 `GM_addStyle`/`GM_setValue`/`GM_getValue`，跨域 iframe 架构（讨论区在 `groupweb.chaoxing.com`）

### 抖音脚本

- **douyin-export**：`@grant: none`，拦截 fetch/XHR 捕获收藏 API，滚动加载 + 数据导出
- **douyin-maintain**：`@grant: GM_setValue/GM_getValue`，直接调用抖音 API（`/aweme/collect/` + `/commit/item/digg/`），按收藏/喜欢自动路由
- **douyin-downloader**：`@run-at document-start`，见下

### douyin-downloader 要点（v1.5.2+）

- **四层捕获**：`fetch` / `XMLHttpRequest` / `Response.prototype.json|text` / `JSON.parse`（终极兜底，任何传输路径的数据都会过 JSON.parse）。`setInterval` 每 3 秒检查 fetch 是否被抖音安全 SDK 覆盖，被覆盖则重新包一层
- **不能主动调 API**：抖音网关有签名校验（msToken/a_bogus），重放签名 URL 会返回 SPA 壳 HTML 或 `Unsupported path(Janus)`，只能拦截页面自己的请求
- **播放识别优先级**：弹幕/统计接口（开始播放时精确触发，URL 参数 `group_id`）> 纯详情页路径 `/video/<id>`（正则必须锚定，搜索页 URL 是 `/video/<旧id>/search/...` 不能覆盖）> 拉流指纹（媒体流 tos key 反查，防预取流冒充）
- **接口响应体不可信**：`history/write` 等接口的响应是列表，first-match 不是当前视频；只用 URL 参数和请求体
- **音频是 DASH 分离的**：`bit_rate_audio[].audio_meta`（dash 音轨）/ `bitrate_list[].audio`（feed 条目）；`bit_rate[]`（注意字段名不稳定，可能不是数组）/ `bitrate_list[]` 的 `play_addr` 是**含音轨的合成 MP4**（moov 双轨已验证）
- **MP3 转码**：AAC(m4a) → `AudioContext.decodeAudioData` → lamejs 编码 128kbps；`@require` jsdelivr + npmmirror/unpkg 动态兜底；分片编码防卡 UI
- **下载链路**：小文件（音频/封面）优先 `GM_xmlhttpRequest` blob（文件名可靠），大文件（视频）优先 `GM_download`（流式省内存）；失败必须 toast 真实报错；**绝不用 `window.open` 兜底**（CDN 无后缀下载触发系统「选取应用」弹窗）；最终兜底 `GM_setClipboard` 复制直链
- **内部直链兜底**：`https://www.douyin.com/aweme/v1/play/?video_id=<uri>&ratio=1080p&line=0` 302 到带音轨合成 mp4，无需签名
- **调试口**：控制台 `__DYDL_DEBUG`（钩子状态/错误列表）、`__DYDL_STORE_REF`（捕获数据 Map）
- CDN 地址带签名（路径 `/6ac76700/` 十六进制 Unix 时间戳），几小时过期，只对当前会话有效

### 抖音 API 格式

- 取消收藏：`POST /aweme/v1/web/aweme/collect/?device_platform=webapp&aid=6383` → `action=0&aweme_id=xxx&aweme_type=0`
- 取消点赞：`POST /aweme/v1/web/commit/item/digg/?device_platform=webapp&aid=6383` → `aweme_id=xxx&item_type=0&type=0`
- 无需 msToken/a_bogus 签名，浏览器 cookie 自动鉴权

## Code Conventions

- ESLint: `eslint:recommended`，`no-unused-vars: warn`，`no-console: off`
- Prettier: `singleQuote: true`，`tabWidth: 4`，`trailingComma: "none"`
- 每个脚本是独立 IIFE，不共享代码
- 空 catch 块必须写注释（ESLint no-empty 报 error）

## Development Notes

- 修改 `src/` 后执行 `npm run build` 同步到 `dist/`
- 抖音脚本修改后也需要手动复制到 `E:\claudecode\wiki\douyin\` 目录
- douyin-downloader 的下载按钮点击后按钮自身有「下载中…/已开始」状态反馈（防连点），改下载逻辑时保留
