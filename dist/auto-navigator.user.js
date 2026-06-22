// ==UserScript==
// @name         学习通章节自动导航助手
// @namespace    https://github.com/Lumjiel/chaoxing-helper
// @version      2.0.0
// @description  通过完整页面刷新翻阅章节，可靠累计章节学习次数，支持随机间隔和一键启停
// @author       Lumjiel
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

/* global jQuery */

(function () {
    'use strict';

    // ====== 默认配置 ======
    const DEFAULT_MIN_DELAY = 3;
    const DEFAULT_MAX_DELAY = 5;
    const STATE_KEY = 'chaoxing_nav_state';
    const SIDEBAR_WAIT_TIMEOUT = 15000; // 等待目录面板加载超时
    const SIDEBAR_POLL_INTERVAL = 500;

    // ====== 状态 ======
    let isRunning = false;
    let timer = null;
    let countdown = 0;
    let totalCount = 0;
    let chapterIds = []; // 章节 ID 列表（按目录顺序）
    let currentIndex = -1; // 当前章节在列表中的索引
    let sessionEnc = ''; // 会话校验 token（enc 参数）

    // ====== 从 URL 获取参数 ======
    function getUrlParams() {
        const url = new URL(window.location.href);
        return {
            courseId: url.searchParams.get('courseId'),
            clazzid: url.searchParams.get('clazzid'),
            cpi: url.searchParams.get('cpi'),
            chapterId: url.searchParams.get('chapterId'),
            enc: url.searchParams.get('enc'),
            openc: url.searchParams.get('openc')
        };
    }

    // ====== 获取当前章节标题 ======
    function getChapterTitle() {
        return (
            document.querySelector('.prev_title')?.textContent?.trim() ||
            '未知章节'
        );
    }

    // ====== 从右侧目录面板解析章节 ID 列表 ======
    function parseChapterIdsFromSidebar() {
        const ids = [];

        // 策略1：从 getTeacherAjax onclick 中提取知识点 ID（有实际内容）
        const allElements = document.querySelectorAll('[onclick]');
        for (const el of allElements) {
            const onclick = el.getAttribute('onclick') || '';
            const match = onclick.match(
                /getTeacherAjax\s*\(\s*['"]?\d+['"]?\s*,\s*['"]?\d+['"]?\s*,\s*['"]?(\d{6,})/
            );
            if (match && !ids.includes(match[1])) {
                ids.push(match[1]);
            }
        }

        if (ids.length > 0) return ids;

        // 策略2：从 changeDisplayContent onclick 中提取
        const links = document.querySelectorAll(
            '#prev_select_Scroll a, .prev_select_con a, .catalog_play_text a'
        );
        for (const link of links) {
            const onclick = link.getAttribute('onclick') || '';
            const match = onclick.match(
                /changeDisplayContent\s*\(\s*['"]?(\d{6,})/
            );
            if (match && !ids.includes(match[1])) {
                ids.push(match[1]);
            }
        }

        if (ids.length > 0) return ids;

        // 策略3：从目录容器中元素的 ID / data 属性提取
        const containers = document.querySelectorAll(
            '#prev_select_Scroll, .prev_select_con, .catalog_play_text, .posCatalog_select, .chapterCell'
        );
        for (const el of containers) {
            // 元素自身的 ID（如 <div id="496454929">）
            const elId = el.id || el.getAttribute('data-id') || '';
            if (/^\d{6,}$/.test(elId) && !ids.includes(elId)) {
                ids.push(elId);
            }
            // 子元素的 ID
            const children = el.querySelectorAll('[id]');
            for (const child of children) {
                if (/^\d{6,}$/.test(child.id) && !ids.includes(child.id)) {
                    ids.push(child.id);
                }
            }
        }

        if (ids.length > 0) return ids;

        // 策略4：从所有链接的 href 中提取 knowledgeid/chapterId
        const allLinks = document.querySelectorAll('a[href]');
        for (const link of allLinks) {
            const href = link.getAttribute('href') || '';
            const hrefMatch = href.match(
                /(?:knowledgeid|chapterId)[=:]*(\d{6,})/
            );
            if (hrefMatch && !ids.includes(hrefMatch[1])) {
                ids.push(hrefMatch[1]);
            }
        }

        return ids;
    }

    // ====== 等待目录面板加载并解析章节列表 ======
    function waitForChapterList() {
        return new Promise((resolve) => {
            // 先尝试立即解析
            let ids = parseChapterIdsFromSidebar();
            if (ids.length > 0) {
                resolve(ids);
                return;
            }

            console.log('[导航助手] 等待目录面板加载...');

            // 轮询等待目录面板出现
            let elapsed = 0;
            const checker = setInterval(() => {
                elapsed += SIDEBAR_POLL_INTERVAL;
                ids = parseChapterIdsFromSidebar();
                if (ids.length > 0) {
                    clearInterval(checker);
                    console.log(
                        `[导航助手] 从目录面板获取到 ${ids.length} 个章节`
                    );
                    resolve(ids);
                    return;
                }
                if (elapsed >= SIDEBAR_WAIT_TIMEOUT) {
                    clearInterval(checker);
                    console.warn('[导航助手] 目录面板加载超时');
                    resolve([]);
                }
            }, SIDEBAR_POLL_INTERVAL);
        });
    }

    // ====== 通过 API 获取章节列表（备用方案） ======
    function fetchChapterListViaApi(courseId, clazzid, cpi) {
        return new Promise((resolve, reject) => {
            if (typeof jQuery === 'undefined') {
                reject(new Error('jQuery not available'));
                return;
            }

            const listUrl =
                `/mooc-ans/mycourse/studentstudycourselist` +
                `?courseId=${courseId}&chapterId=0` +
                `&clazzid=${clazzid}&cpi=${cpi}&mooc2=1&isMicroCourse=false`;

            jQuery
                .get(listUrl)
                .then((html) => {
                    const ids = [];

                    // 优先提取知识点级 ID（getTeacherAjax 中的 knowledgeId）
                    // 这些 ID 有实际内容且触发 setlog 计数
                    const teacherPattern =
                        /getTeacherAjax\s*\(\s*['"]?\d+['"]?\s*,\s*['"]?\d+['"]?\s*,\s*['"]?(\d{6,})/g;
                    let m;
                    while ((m = teacherPattern.exec(html)) !== null) {
                        if (!ids.includes(m[1])) {
                            ids.push(m[1]);
                        }
                    }

                    // 备用：章节级 ID（posCatalog_select firstLayer）
                    if (ids.length === 0) {
                        const chapterPattern =
                            /class="posCatalog_select\s+firstLayer"\s+id="(\d+)"/g;
                        while ((m = chapterPattern.exec(html)) !== null) {
                            if (!ids.includes(m[1])) {
                                ids.push(m[1]);
                            }
                        }
                    }

                    resolve(ids);
                })
                .fail((err) => reject(err));
        });
    }

    // ====== 找到当前章节在列表中的索引 ======
    function findCurrentIndex(ids) {
        const currentId = getUrlParams().chapterId;
        if (currentId) {
            const idx = ids.indexOf(currentId);
            if (idx !== -1) return idx;
        }

        // 从目录面板的高亮/选中状态推断
        const activeLink = document.querySelector(
            '#prev_select_Scroll .active, .prev_select_con .active, #prev_select_Scroll .cur, .prev_select_con .cur'
        );
        if (activeLink) {
            const onclick = activeLink.getAttribute('onclick') || '';
            const match = onclick.match(
                /changeDisplayContent\s*\(\s*['"]?(\d{6,})/
            );
            if (match) {
                const idx = ids.indexOf(match[1]);
                if (idx !== -1) return idx;
            }
        }

        return 0; // 默认从第一个开始
    }

    // ====== 构建章节完整 URL ======
    function buildChapterUrl(chapterId, params) {
        let url =
            `/mycourse/studentstudy?chapterId=${chapterId}` +
            `&courseId=${params.courseId}` +
            `&clazzid=${params.clazzid}` +
            `&cpi=${params.cpi}` +
            `&mooc2=1&hidetype=0`;
        // enc 是服务端校验 token，必须携带
        const enc = sessionEnc || params.enc;
        if (enc) {
            url += `&enc=${enc}`;
        }
        return url;
    }

    // ====== 安全跳转到下一章 ======
    function navigateToNextChapter() {
        if (chapterIds.length === 0) {
            stop('❌ 章节列表为空，无法导航');
            return;
        }

        const nextIndex = currentIndex + 1;
        const params = getUrlParams();

        if (!params.courseId || !params.clazzid || !params.cpi) {
            stop('❌ 无法获取课程参数（courseId/clazzid/cpi）');
            return;
        }

        let targetIndex;
        let targetChapterId;

        if (nextIndex < chapterIds.length) {
            // 还有下一章
            targetIndex = nextIndex;
            targetChapterId = chapterIds[targetIndex];
        } else {
            // 到最后一章 → 回到第一章
            targetIndex = 0;
            targetChapterId = chapterIds[0];
            console.log('[导航助手] 已到最后一章，回到第一章');
        }

        totalCount++;
        currentIndex = targetIndex;
        saveState();

        const targetUrl = buildChapterUrl(targetChapterId, params);
        console.log(
            `[导航助手] 翻页 #${totalCount}: 章节 ${targetIndex + 1}/${chapterIds.length} (${targetChapterId})`
        );

        // 完整页面刷新 —— 确保 setlog 脚本执行
        window.location.href = targetUrl;
    }

    // ====== 关闭各种弹窗 ======
    function dismissDialogs() {
        try {
            const selectors = [
                { sel: '#jobFinishTip', btn: '.popMoveDele' },
                { sel: '#freezePage', btn: '.keepLearning' },
                { sel: '#freezePage2', btn: '.jb_btn_92' },
                { sel: '.jobFinishTip', btn: '.popClose' }
            ];

            for (const { sel, btn } of selectors) {
                const el = document.querySelector(sel);
                if (el && el.style.display !== 'none') {
                    const b = el.querySelector(btn);
                    if (b) b.click();
                }
            }
        } catch (e) {
            /* ignore */
        }
    }

    // ====== 读取延迟范围 ======
    function getDelayRange() {
        const minEl = document.getElementById('nav-delay-min');
        const maxEl = document.getElementById('nav-delay-max');
        const min = Math.max(2, parseInt(minEl?.value) || DEFAULT_MIN_DELAY);
        const max = Math.max(min, parseInt(maxEl?.value) || DEFAULT_MAX_DELAY);
        return { min, max };
    }

    function randomDelay() {
        const { min, max } = getDelayRange();
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    // ====== 更新面板 ======
    function updatePanel() {
        const statusEl = document.getElementById('nav-status');
        const progressEl = document.getElementById('nav-progress');
        const timerEl = document.getElementById('nav-timer');

        if (statusEl && !statusEl.dataset.custom) {
            statusEl.textContent = isRunning ? '🟢 运行中' : '⏸ 已暂停';
            statusEl.style.color = isRunning ? '#52c41a' : '#faad14';
        }
        if (progressEl) {
            const chapterInfo =
                chapterIds.length > 0
                    ? `章节 ${currentIndex + 1}/${chapterIds.length}`
                    : '';
            progressEl.textContent = `已翻阅 ${totalCount} 次 | ${chapterInfo} | ${getChapterTitle()}`;
        }
        if (timerEl) {
            if (isRunning) {
                timerEl.textContent = `${countdown}s 后翻页`;
            } else {
                timerEl.textContent = '点击「开始」启动自动翻页';
            }
        }
    }

    // ====== 设置自定义状态文字 ======
    function setStatus(text, color) {
        const statusEl = document.getElementById('nav-status');
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.style.color = color || '#1890ff';
            statusEl.dataset.custom = color ? '1' : '';
        }
    }

    // ====== 持久化 ======
    function saveState() {
        try {
            localStorage.setItem(
                STATE_KEY,
                JSON.stringify({
                    totalCount,
                    isRunning,
                    currentIndex,
                    chapterIds,
                    sessionEnc,
                    savedAt: Date.now()
                })
            );
        } catch (e) {
            /* ignore */
        }
    }

    function loadState() {
        try {
            const saved = JSON.parse(localStorage.getItem(STATE_KEY));
            if (saved) {
                totalCount = saved.totalCount || 0;
                // 只恢复运行状态（5 分钟内有效）
                if (
                    saved.isRunning &&
                    saved.savedAt &&
                    Date.now() - saved.savedAt < 5 * 60 * 1000
                ) {
                    isRunning = true;
                } else {
                    isRunning = false;
                }
                // 恢复当前章节索引（用于断点续翻）
                if (typeof saved.currentIndex === 'number') {
                    currentIndex = saved.currentIndex;
                }
                // 注意：chapterIds 不从 localStorage 恢复，每次页面加载都重新提取
            }
        } catch (e) {
            /* ignore */
        }
    }

    // ====== 倒计时循环 ======
    function startLoop() {
        if (timer) clearInterval(timer);

        // 每次翻页都等待固定间隔（不管是否有内容）
        // 导航本身就会触发 setlog，不依赖页面内容
        countdown = randomDelay();
        updatePanel();

        timer = setInterval(() => {
            dismissDialogs();
            countdown--;
            updatePanel();

            if (countdown <= 0) {
                clearInterval(timer);
                timer = null;
                navigateToNextChapter();
            }
        }, 1000);
    }

    function stopLoop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    // ====== 切换运行/暂停 ======
    function toggle() {
        isRunning = !isRunning;
        saveState();
        updateButton();

        if (isRunning) {
            setStatus('', '');
            startLoop();
        } else {
            stopLoop();
        }
        updatePanel();
    }

    function updateButton() {
        const btn = document.getElementById('nav-toggle-btn');
        if (btn) {
            btn.textContent = isRunning ? '⏸ 暂停' : '▶ 开始';
            btn.style.background = isRunning ? '#ff7a45' : '#52c41a';
        }
    }

    // ====== 停止并显示错误 ======
    function stop(errorMsg) {
        isRunning = false;
        saveState();
        updatePanel();
        updateButton();
        setStatus(errorMsg, '#ff4d4f');
        console.error(`[导航助手] ${errorMsg}`);
    }

    // ====== 重置计数 ======
    function resetCount() {
        if (confirm('确定要重置翻页计数吗？')) {
            totalCount = 0;
            currentIndex = findCurrentIndex(chapterIds);
            saveState();
            updatePanel();
        }
    }

    // ====== Tab 可见性检测 ======
    function handleVisibility() {
        if (document.hidden) {
            stopLoop();
        } else if (isRunning) {
            startLoop();
        }
    }

    // ====== 创建浮动面板 ======
    function createPanel() {
        if (document.getElementById('nav-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'nav-panel';
        panel.innerHTML = `
            <div id="nav-header">📚 章节导航助手 v2.0</div>
            <div id="nav-status">已暂停</div>
            <div id="nav-progress">已翻阅 0 次</div>
            <div id="nav-timer">点击「开始」启动自动翻页</div>
            <div id="nav-buttons">
                <button id="nav-toggle-btn" style="background:#52c41a">▶ 开始</button>
                <button id="nav-reset-btn" style="background:#8c8c8c">↻ 重置</button>
            </div>
            <div id="nav-settings">
                间隔（秒）：
                <input id="nav-delay-min" type="number" value="${DEFAULT_MIN_DELAY}" min="2" max="300" style="width:42px"> ~
                <input id="nav-delay-max" type="number" value="${DEFAULT_MAX_DELAY}" min="2" max="300" style="width:42px">
            </div>
        `;
        document.body.appendChild(panel);

        document
            .getElementById('nav-toggle-btn')
            .addEventListener('click', toggle);
        document
            .getElementById('nav-reset-btn')
            .addEventListener('click', resetCount);

        makeDraggable(panel, document.getElementById('nav-header'));
    }

    // ====== 拖拽 ======
    function makeDraggable(el, handle) {
        let isDragging = false;
        let offsetX, offsetY;

        handle.style.cursor = 'move';

        handle.addEventListener('mousedown', (e) => {
            isDragging = true;
            offsetX = e.clientX - el.getBoundingClientRect().left;
            offsetY = e.clientY - el.getBoundingClientRect().top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            el.style.left = e.clientX - offsetX + 'px';
            el.style.top = e.clientY - offsetY + 'px';
            el.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    // ====== 样式 ======
    function injectStyles() {
        GM_addStyle(`
            #nav-panel {
                position: fixed;
                top: 80px;
                right: 20px;
                z-index: 99999;
                background: #fff;
                border: 1px solid #d9d9d9;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                padding: 12px 16px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                color: #333;
                min-width: 230px;
                user-select: none;
            }
            #nav-header {
                font-weight: bold;
                font-size: 14px;
                margin-bottom: 8px;
                padding-bottom: 6px;
                border-bottom: 1px solid #f0f0f0;
            }
            #nav-status {
                font-weight: bold;
                font-size: 13px;
                margin-bottom: 4px;
            }
            #nav-progress {
                color: #666;
                font-size: 12px;
                margin-bottom: 4px;
                word-break: break-all;
            }
            #nav-timer {
                color: #1890ff;
                font-size: 12px;
                margin-bottom: 10px;
                font-variant-numeric: tabular-nums;
            }
            #nav-buttons {
                display: flex;
                gap: 8px;
                margin-bottom: 8px;
            }
            #nav-buttons button {
                flex: 1;
                padding: 6px 0;
                border: none;
                border-radius: 4px;
                color: #fff;
                font-size: 13px;
                cursor: pointer;
                transition: opacity 0.2s;
            }
            #nav-buttons button:hover {
                opacity: 0.85;
            }
            #nav-settings {
                border-top: 1px solid #f0f0f0;
                padding-top: 8px;
                font-size: 12px;
                color: #888;
            }
            #nav-settings input {
                border: 1px solid #d9d9d9;
                border-radius: 3px;
                padding: 2px 4px;
                font-size: 12px;
                text-align: center;
            }
        `);
    }

    // ====== 初始化 ======
    async function init() {
        loadState();
        injectStyles();
        createPanel();
        dismissDialogs();

        // 从当前 URL 捕获 enc（每次页面加载都会刷新）
        const params = getUrlParams();
        if (params.enc) {
            sessionEnc = params.enc;
        }

        // 检测 enc 校验失败页面
        if (
            document.title === '温馨提示' ||
            document.body?.innerText?.includes('enc校验失败')
        ) {
            stop('❌ enc 校验失败，请重新进入课程页面');
            updatePanel();
            updateButton();
            return;
        }

        // 获取章节列表
        if (chapterIds.length === 0) {
            setStatus('📂 加载章节列表...', '#1890ff');

            // 优先从目录面板解析
            chapterIds = await waitForChapterList();

            // 备用：通过 API 获取
            if (chapterIds.length === 0) {
                const params = getUrlParams();
                if (params.courseId && params.clazzid && params.cpi) {
                    try {
                        setStatus('📂 通过 API 加载章节...', '#1890ff');
                        chapterIds = await fetchChapterListViaApi(
                            params.courseId,
                            params.clazzid,
                            params.cpi
                        );
                    } catch (e) {
                        console.error('[导航助手] API 获取章节列表失败:', e);
                    }
                }
            }

            if (chapterIds.length === 0) {
                stop('❌ 无法获取章节列表，请确认页面已加载');
                updatePanel();
                updateButton();
                return;
            }

            console.log(`[导航助手] 共 ${chapterIds.length} 个章节`);
        }

        // 定位当前章节
        if (currentIndex < 0 || currentIndex >= chapterIds.length) {
            currentIndex = findCurrentIndex(chapterIds);
        }

        setStatus('', '');
        updatePanel();
        updateButton();

        // 监听 tab 可见性变化
        document.addEventListener('visibilitychange', handleVisibility);

        if (isRunning) {
            startLoop();
        }

        console.log(
            `[导航助手] v2.0 已加载，章节 ${currentIndex + 1}/${chapterIds.length}，累计翻阅: ${totalCount} 次，状态: ${isRunning ? '运行中' : '已暂停'}`
        );
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
