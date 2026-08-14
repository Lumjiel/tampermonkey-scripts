# tampermonkey-scripts — 大学生浏览器脚本合集

**解决学习通代码粘贴、自动发帖、抖音数据采集的浏览器脚本。**

*Userscripts for students: Chaoxing unlock + Douyin export. Tampermonkey required.*

[脚本列表](#-脚本列表) · [安装](#-安装) · [抖音工作流](#-抖音完整工作流)

---

## 能做什么

| 平台 | 脚本 | 功能 |
|------|------|------|
| 学习通 | code-enhancer | 解除代码编辑器粘贴/复制/选择限制 |
| 学习通 | auto-poster | 批量自动发帖，支持断点续传 |
| 学习通 | auto-navigator | 自动翻阅章节，累计学习次数 |
| 抖音 | douyin-export | 采集收藏/喜欢/关注，导出 JSON |
| 抖音 | douyin-maintain | 批量取消收藏/取消喜欢 |

---

## 快速开始

```bash
# 方式一：开发构建
npm install && npm run build
# 产物在 dist/ 目录，复制 .user.js 内容到 Tampermonkey

# 方式二：直接安装
# 打开 Tampermonkey → 管理面板 → 「+」→ 粘贴 dist/ 下的 .user.js
```

**前置要求**：安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展。

---

## 📖 各脚本详情

### 1. 学习通代码编辑器增强（3KB）

解除超星学习通代码编辑器的粘贴/复制/选择限制，修复 CodeMirror 粘贴格式错乱。

- ✅ 解除 Ctrl+V / 右键粘贴
- ✅ 解除 Ctrl+C 复制
- ✅ 解除文本选择限制
- ✅ 自动适配动态加载内容

### 2. 学习通智能发帖助手（21KB）

课程要求发 100 条讨论？一键解放双手。

- 📋 多内容队列管理
- ⏱️ 间隔时间可自定义（建议 3-5 秒）
- 💾 刷新页面自动续传
- 🔄 失败自动回滚重试

### 3. 学习通章节自动导航（24KB）

自动翻阅章节，可靠累计学习次数。比手动刷快，比"一键完成"安全。

- 🔄 完整页面刷新翻阅（比 JS 模拟更可靠）
- ⏱️ 随机间隔（默认 3-5 秒）
- 💾 刷新后自动恢复状态

### 4. 抖音数据采集（15KB）

一键采集收藏/喜欢/关注，导出 JSON。

- 📥 自动滚动加载全部数据
- 🔍 拦截 API 响应，直接提取结构化数据
- 💾 导出标准 JSON
- 🔄 增量采集（不重复）

### 5. 抖音批量管理（12KB）

批量取消收藏/取消喜欢，API 直调。

- 🚀 不导航、不弹窗、不离开当前页
- 📋 支持纯 ID 列表 / JSON 两种输入
- 🔄 失败自动重试 2 次
- 📊 实时进度条

---

## 🔗 抖音完整工作流

```
douyin-export → LLM 分析 → douyin-maintain
  采集收藏/喜欢    生成清理列表    批量取消
```

1. `douyin-export.user.js` 采集收藏/喜欢/关注 → 导出 JSON
2. LLM 分析 → 生成待清理 ID 列表
3. `douyin-maintain.user.js` 粘贴 ID → 一键清理

---

## 全部参数

```
code-enhancer      自动运行，无参数
auto-poster        @match 讨论页，面板配置间隔/内容
auto-navigator     @match 学习页，面板配置间隔
douyin-export      @match douyin.com/user/*
douyin-maintain    @match douyin.com/*
```

---

## 开发

```bash
npm install        # 安装开发依赖（ESLint + Prettier）
npm run build      # 构建 dist/
npm run lint       # ESLint 检查
npm run format     # Prettier 格式化
```

---

## ⚠️ 免责声明

- 本项目仅供学习和交流使用
- 学习通脚本请遵守学校和平台规定
- 抖音脚本产生的后果由使用者自行承担
- 数据只存本地，不外传

## 📜 License

[MIT](LICENSE)
