# Tampermonkey Scripts

> 一套解决大学生日常痛点的浏览器脚本合集。

---

## 📦 脚本列表

### 超星学习通

| 脚本 | 一句话 | 大小 |
|------|--------|------|
| [code-enhancer](#1-学习通代码编辑器增强) | 解除代码编辑器的粘贴/复制/选择限制 | 3KB |
| [auto-poster](#2-学习通智能发帖助手) | 批量自动发帖/回复，支持断点续传 | 21KB |
| [auto-navigator](#3-学习通章节自动导航) | 自动翻阅章节，累计学习次数 | 24KB |

### 抖音

| 脚本 | 一句话 | 大小 |
|------|--------|------|
| [douyin-export](#4-抖音数据采集) | 一键采集收藏/喜欢/关注，导出 JSON | 15KB |
| [douyin-maintain](#5-抖音批量管理) | 批量取消收藏/取消喜欢，API 直调 | 12KB |

---

## 🔧 安装

### 前置要求

安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展（Chrome / Firefox / Edge / Safari 均支持）。

### 安装方式

**方式一：本地文件安装（推荐）**

1. 打开 Tampermonkey → 管理面板 → 「+」号
2. 清空编辑器内容
3. 复制 `dist/` 目录下对应 `.user.js` 文件的全部内容
4. 粘贴 → 保存（Ctrl+S）

**方式二：开发模式**

```bash
git clone <repo-url>
cd tampermonkey-scripts
npm install
npm run build    # 构建 dist/
```

然后从 `dist/` 目录安装。

---

## 📖 各脚本详细说明

### 1. 学习通代码编辑器增强

> 解决超星学习通代码编辑器无法粘贴、格式错乱、复制受限问题。

**适用页面**：学习通作业/考试中的代码编辑器

**功能特点**：
- ✅ 解除粘贴限制（Ctrl+V / 右键粘贴）
- ✅ 解除复制限制（Ctrl+C）
- ✅ 解除文本选择限制
- ✅ 修复 CodeMirror 编辑器粘贴格式错乱
- ✅ 自动适配页面动态加载内容

**技术实现**：
- `@grant: none`（无需 Greasemonkey API）
- `stopImmediatePropagation()` 在 capture 阶段拦截超星的事件监听器
- MutationObserver 监听 DOM 变化，自动适配动态加载的编辑器

---

### 2. 学习通智能发帖助手

> 课程要求发 100 条讨论？一键解放双手。

**适用页面**：课程 → 讨论标签页（在 `groupweb.chaoxing.com` 的跨域 iframe 中运行）

**功能特点**：
- 📋 多内容队列管理（一次准备多条，轮流发布）
- ⏱️ 间隔时间可自定义（建议 3-5 秒）
- 💾 刷新页面自动续传未完成任务
- 🔄 失败自动回滚重试
- 🎨 浮动操作面板

**使用步骤**：

1. 进入课程 → 讨论标签页
2. 页面右上角出现发帖助手面板
3. 填写发帖标题（如「打卡」）
4. 内容列表中每行写一条内容
5. 设置间隔时间（建议 3-5 秒）
6. 勾选「刷新自动续传」
7. 点击「🚀 开始任务」

**技术实现**：
- 依赖 `GM_addStyle`、`GM_setValue`/`GM_getValue`、`unsafeWindow`
- 跨域 iframe 架构：通过 `@match` 同时匹配主页面和 `groupweb.chaoxing.com`
- UEditor iframe 填充：通过 `unsafeWindow.UE` 触发 `contentChange` 事件
- 任务池：FIFO 队列 + 失败回滚
- 存储键：`chaoxing_config_v12`（配置）、`chaoxing_task_pool_v12`（任务队列）

---

### 3. 学习通章节自动导航

> 自动翻阅章节，可靠累计学习次数。比手动刷快，比「一键完成」安全。

**适用页面**：`mooc1.chaoxing.com/mycourse/studentstudy`

**功能特点**：
- 🔄 通过完整页面刷新翻阅章节（比 JS 模拟更可靠）
- ⏱️ 随机间隔（默认 3-5 秒，可配置）
- ▶️ 一键启停
- 💾 刷新页面后自动恢复状态
- 🛑 可随时停止

---

### 4. 抖音数据采集

> 一键采集你的抖音收藏、喜欢、关注，导出为 JSON 文件。

**适用页面**：`douyin.com/user/*`

**功能特点**：
- 📥 自动滚动加载全部数据（收藏/喜欢/关注三个 tab）
- 🔍 拦截抖音 API 响应，直接提取结构化数据
- 📊 实时显示采集进度（已采集/总数）
- 💾 导出为标准 JSON 文件
- 🔄 增量采集（已采集的不重复）

**使用步骤**：

1. 打开 `douyin.com/user/self`
2. 页面右下角出现浮动面板
3. 点击「🔍 开始采集」
4. 等待自动滚动完成
5. 切换到其他 tab（喜欢/关注）继续采集
6. 点击「📥 导出 JSON」下载文件

**导出数据格式**：

```json
{
  "favorites": [{ "aweme_id": "...", "desc": "...", "author": "...", "tags": [...] }],
  "likes": [{ ... }],
  "following": [{ "nickname": "...", "signature": "..." }]
}
```

---

### 5. 抖音批量管理

> 批量取消收藏、取消喜欢。API 直调，不离开当前页。

**适用页面**：`douyin.com/*`（任意抖音页面）

**功能特点**：
- 🚀 API 直调（不导航、不弹窗、不离开当前页）
- 📌 取消收藏 + 👍 取消喜欢，自动路由到不同 API
- 📋 支持两种输入格式：纯 ID 列表 / JSON 格式
- 🔄 失败自动重试 2 次
- 💾 进度自动保存，刷新页面不丢失
- 📊 实时进度条

**API 格式**（经 Playwright 实测验证）：

| 操作 | API | Body |
|------|-----|------|
| 取消收藏 | `POST /aweme/v1/web/aweme/collect/` | `action=0&aweme_id=xxx&aweme_type=0` |
| 取消点赞 | `POST /aweme/v1/web/commit/item/digg/` | `aweme_id=xxx&item_type=0&type=0` |

无需 `msToken` / `a_bogus` 签名，浏览器 cookie 自动鉴权。

**使用步骤**：

1. 打开任意抖音页面
2. 粘贴 ID 列表到输入框
3. 点击「🚀 一键清理」（自动按收藏/喜欢路由）
4. 或单独点击「📌 取消收藏」/「👍 取消喜欢」

**输入格式**：

```
// 格式 1：纯 ID 列表（每行一个，全部当收藏处理）
7644510979287469348
7646374731150658842

// 格式 2：JSON 格式（自动按 fav/like 路由）
{
  "fav": ["7644510979287469348", "7646374731150658842"],
  "like": ["7625266678255506085"]
}
```

---

## 🔗 抖音完整工作流

```
油猴脚本采集          LLM 分析            油猴脚本清理
douyin-export  →  douyin_llm_analyze  →  douyin-maintain
    ↓                    ↓                    ↓
  导出 JSON        生成 REMOVE 列表      批量取消收藏/喜欢
```

1. 用 `douyin-export.user.js` 采集收藏/喜欢/关注 → 导出 JSON
2. 运行 Python LLM 分析脚本 → 生成 `douyin-remove-ids.json`
3. 复制 REMOVE 列表 → 粘贴到 `douyin-maintain.user.js` → 一键清理

---

## 📁 项目结构

```
tampermonkey-scripts/
├── src/
│   ├── code-enhancer/       # 学习通编辑器解锁
│   │   └── index.js
│   ├── auto-poster/         # 学习通自动发帖
│   │   └── index.js
│   ├── auto-navigator/      # 学习通自动导航
│   │   └── index.js
│   ├── douyin-export/       # 抖音数据采集
│   │   └── index.js
│   └── douyin-maintain/     # 抖音批量管理
│       └── index.js
├── scripts/
│   └── build.js             # 构建：src/ → dist/
├── dist/                    # 发布版（直接安装到 Tampermonkey）
│   ├── code-enhancer.user.js
│   ├── auto-poster.user.js
│   ├── auto-navigator.user.js
│   ├── douyin-export.user.js
│   └── douyin-maintain.user.js
├── package.json
├── CLAUDE.md
├── README.md
└── LICENSE
```

---

## 🛠️ 开发

```bash
npm install           # 安装开发依赖（ESLint + Prettier）
npm run build         # 构建 dist/
npm run lint          # ESLint 检查
npm run format        # Prettier 格式化
```

修改 `src/` 下的源文件后，执行 `npm run build` 自动同步到 `dist/`。

### 构建流程

`scripts/build.js` 做两件事：
1. 复制 `src/<name>/index.js` → `dist/<name>.user.js`
2. 替换 `@namespace` 和 `@author` 为发布值（Lumjiel）

指定版本号：`npm run build:version -- --version 2.1.0`

---

## ⚠️ 免责声明

- 本项目仅供学习和交流使用
- 学习通脚本请遵守学校和平台规定
- 抖音脚本产生的任何后果由使用者自行承担
- 数据只存本地，不外传

---

## 📄 开源协议

[MIT License](LICENSE)

---

> 💡 觉得有用？欢迎 Star！发现 Bug？欢迎提 Issue！
