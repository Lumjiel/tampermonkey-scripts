# tampermonkey-scripts

浏览器用户脚本合集。把平台上重复的手工操作收敛成一次点击——每个脚本独立可用，互不依赖，装哪个都行。

*Browser userscripts for Chaoxing, Douyin and X. Requires Tampermonkey.*

[脚本清单](#脚本清单) · [安装](#安装) · [工作流](#工作流) · [开发](#开发) · [FAQ](#faq)

---

## 脚本清单

| 平台 | 脚本 | 功能 | 体积 |
|:--|:--|:--|--:|
| 学习通 | `code-enhancer` | 解除代码编辑器的粘贴 / 复制 / 选中限制，修复 CodeMirror 粘贴格式错乱 | 2.9 KB |
| 学习通 | `auto-poster` | 讨论区批量提交：内容队列 + 间隔控制 + 断点续传 | 20 KB |
| 学习通 | `auto-navigator` | 章节按序翻阅，整页刷新式翻页，进度可恢复 | 23 KB |
| 抖音 | `douyin-export` | 采集收藏 / 喜欢 / 关注，导出结构化 JSON | 17 KB |
| 抖音 | `douyin-maintain` | 批量取消收藏 / 喜欢，纯 API 调用 | 12 KB |
| 抖音 | `douyin-downloader` | 无水印视频 / MP3 音频 / BGM / 封面下载 | 52 KB |
| X (Twitter) | `x-list-following-picker` | 关注列表批量加入 List，逐条校验服务端结果 | 17 KB |

源码在 `src/<name>/index.js`，构建产物在 `dist/<name>.user.js`。

---

## 安装

前置：浏览器已安装 [Tampermonkey](https://www.tampermonkey.net/)。

**方式一：从源码构建**（改过代码、或想锁定版本）

```bash
npm install
npm run build                 # src/ → dist/
node scripts/build.js --version 2.1.0   # 可选：指定版本号
```

**方式二：直接安装**

打开 Tampermonkey 管理面板 → `+` → 把 `dist/` 下对应的 `.user.js` 全文粘进去 → 保存。

---

## 脚本详情

### 1. code-enhancer — 代码编辑器增强

解除超星学习通代码编辑器的粘贴、复制、选中限制，并修复 CodeMirror 粘贴时的格式错乱。

- 解除 Ctrl+V / 右键粘贴、Ctrl+C 复制、文本选中限制
- 适配动态加载的编辑器实例

### 2. auto-poster — 讨论区批量提交

内容一次性备好，脚本按队列逐条提交，刷新页面后从断点继续。

- 多内容队列管理
- 提交间隔可配置（建议 3–5 秒）
- 刷新后自动恢复队列位置
- 单条失败自动回滚重试

### 3. auto-navigator — 章节顺序翻阅

按目录顺序逐章翻阅。翻页用整页刷新而非 JS 模拟事件，更接近真实浏览行为，被前端框架拦截的概率更低。

- 整页刷新式翻页
- 间隔随机化（默认 3–5 秒）
- 刷新后自动恢复进度

### 4. douyin-export — 数据采集

自动滚动加载，拦截接口响应直接取结构化数据，不解析 DOM。

- 采集收藏 / 喜欢 / 关注
- 拦截 API 响应，绕过渲染层
- 导出标准 JSON
- 增量采集，重复项跳过

### 5. douyin-maintain — 批量管理

按 ID 列表批量取消收藏 / 喜欢，全程停在当前页。

- 纯 API 调用，不导航、不弹窗
- 支持纯 ID 列表 / JSON 两种输入
- 失败自动重试 2 次
- 实时进度条

### 6. douyin-downloader — 视频下载

面板只跟随「当前视频 + 最近播放」，不堆积历史。

- 无水印视频多清晰度可选，标注体积 / 码率 / 编码
- 音频自动转码 128 kbps MP3，可直接喂给 Whisper 等转录服务
- 四层捕获（fetch / XHR / Response / JSON.parse）+ 拉流指纹反查当前播放
- 粘贴 App 分享链接（脏文本直接粘）可精确定位
- 面板可收起成小球、可拖动，位置记忆

首次下载需在 Tampermonkey 授予跨域权限（`@connect *`）。个别视频未捕获时，占位卡提供「打开详情页获取下载」兜底。排查开关：控制台 `__DYDL_DEBUG`。

### 7. x-list-following-picker — List 成员批量添加

X 自带的列表管理只能逐个搜索加人，关注数上百时基本不可用。这个脚本在列表编辑页注入面板，直接列出你关注的账号。

- 面板内展示完整关注列表，点一下即加入
- 连续添加，默认间隔 250 ms 防限流
- 以「列表成员数实际 +1」判定成功，服务端未生效会明确报错，不产生假成功
- 已在列表的账号自动标记
- 抓取上限 1000 个关注 / 250 个现有成员，避免大账号拖死页面

---

## 工作流

抖音的三件套可以串成一条链路：

```
douyin-export ──→ LLM 分析 ──→ douyin-maintain
   采集收藏/喜欢     生成清理清单      批量取消

douyin-downloader ──→ MP3 音频 ──→ Whisper / ASR
   粘贴链接或边看边抓      128 kbps        转录、摘要
```

先导出数据，交给模型判断「哪些该留」，再把待清理的 ID 粘回批量管理脚本。下载器单独用也行，音频转码是为后续转录准备的。

---

## 匹配规则

```
code-enhancer      自动运行，无参数
auto-poster        @match 讨论页，面板配置间隔与内容
auto-navigator     @match 学习页，面板配置间隔
douyin-export      @match douyin.com/user/*
douyin-maintain    @match douyin.com/*
douyin-downloader  @match douyin.com/*，@require lamejs (jsdelivr)
x-list-following-picker  @match x.com/*
```

---

## 开发

```bash
npm install      # ESLint + Prettier
npm run build    # 构建 dist/
npm run lint     # 检查
npm run format   # 格式化
```

构建脚本只做两件事：把 `src/<name>/index.js` 复制成 `dist/<name>.user.js`，并把 `@namespace` / `@author` 替换成发布值。新增脚本需要同时在 `scripts/build.js` 的 `SCRIPTS` 数组里登记。

---

## FAQ

**下载时弹出「获取打开此 'bytedance' 链接的应用」**

抖音网页会拉起 `bytedance://` 桌面客户端协议，没装客户端就会弹。与下载通道无关。根治办法是注册一个空壳协议处理程序，或直接安装抖音桌面客户端。

**GM_download 报错 / 点击没反应**

Tampermonkey 设置 → 下载 BETA，确认扩展名白名单包含 `mp4 m4a mp3 jpeg`。新版脚本会把真实错误用 toast 显示出来。

**面板没抓到当前视频**

脚本需在页面加载前注入，刷新即可。数据缺失时占位卡有「打开详情页获取下载」自愈按钮；排查用控制台 `__DYDL_DEBUG`。

**下的音频要拿去转录**

点「音频」按钮，自动转码 128 kbps MP3，Whisper / 阿里云 ASR 直接可用。

---

## 免责声明

本项目为个人学习与技术研究用途，与任何平台官方无关。

- 脚本仅在本地浏览器运行，不上传任何数据
- 使用前请自行确认符合所在平台的服务条款与相关规定
- 因使用脚本产生的任何后果由使用者自行承担

## License

[MIT](LICENSE)
