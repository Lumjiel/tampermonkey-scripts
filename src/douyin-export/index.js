// ==UserScript==
// @name         抖音个人数据一键导出
// @namespace    http://tampermonkey.net/
// @version      2026-06-22-v5
// @description  采集抖音收藏、喜欢、关注，导出 JSON
// @author       Lumjiel
// @match        https://www.douyin.com/user/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=douyin.com
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ================================================================
    //  Part 1: API 拦截（document-start）
    // ================================================================
    const apiCache = { favorites: [], likes: [], following: [] };
    let stopped = false;

    function handleApiData(url, body) {
        if (stopped) return;
        // 收藏
        if (
            url.includes('listcollection') ||
            (url.includes('favorite') && url.includes('aweme'))
        ) {
            for (const item of body.aweme_list || body.data?.list || []) {
                const id = item.aweme_id;
                if (!id || apiCache.favorites.some((x) => x.id === id))
                    continue;
                const s = item.statistics || {},
                    a = item.author || {};
                apiCache.favorites.push({
                    id,
                    title: item.desc || '',
                    url: `https://www.douyin.com/video/${id}`,
                    author: a.nickname || '',
                    authorUid: a.uid || '',
                    likes: s.digg_count || 0,
                    comments: s.comment_count || 0,
                    shares: s.share_count || 0,
                    duration: item.duration || 0,
                    createTime: item.create_time || 0,
                    hashtags: (item.text_extra || [])
                        .map((t) => t.hashtag_name)
                        .filter(Boolean)
                });
            }
        }
        // 喜欢
        if (url.includes('aweme/listliked')) {
            for (const item of body.aweme_list || []) {
                const id = item.aweme_id;
                if (!id || apiCache.likes.some((x) => x.id === id)) continue;
                apiCache.likes.push({
                    id,
                    title: item.desc || '',
                    url: `https://www.douyin.com/video/${id}`
                });
            }
        }
        // 关注（列表 + 单个用户信息）
        if (url.includes('following/list')) {
            for (const item of body.followings || []) {
                const uid = item.sec_uid || item.uid;
                if (!uid || apiCache.following.some((x) => x.secUid === uid))
                    continue;
                apiCache.following.push({
                    name: item.nickname || '',
                    secUid: uid,
                    desc: item.signature || '',
                    followerCount: item.follower_count || 0
                });
            }
        }
        if (url.includes('im/user/info') || url.includes('query/user')) {
            const user = body.user || body;
            const uid = user.sec_uid || user.uid;
            if (
                uid &&
                user.nickname &&
                !apiCache.following.some((x) => x.secUid === uid)
            ) {
                apiCache.following.push({
                    name: user.nickname,
                    secUid: uid,
                    desc: user.signature || ''
                });
            }
        }
    }

    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, url, ...a) {
        this._dyUrl = url;
        return _xhrOpen.call(this, m, url, ...a);
    };
    XMLHttpRequest.prototype.send = function (...a) {
        this.addEventListener('load', function () {
            try {
                handleApiData(this._dyUrl || '', JSON.parse(this.responseText));
            } catch (e) {
                /* not JSON */
            }
        });
        return _xhrSend.call(this, ...a);
    };

    const _fetch = window.fetch;
    window.fetch = async function (...a) {
        const resp = await _fetch.call(this, ...a);
        try {
            const url = typeof a[0] === 'string' ? a[0] : a[0]?.url || '';
            if (
                url.includes('aweme') ||
                url.includes('user/info') ||
                url.includes('following')
            ) {
                handleApiData(url, await resp.clone().json());
            }
        } catch (e) {
            /* not API response */
        }
        return resp;
    };

    // ================================================================
    //  Part 2: UI + 采集（等 DOM）
    // ================================================================
    function initUI() {
        const panel = document.createElement('div');
        panel.id = 'dy-export-panel';
        panel.innerHTML = `
        <style>
            #dy-export-panel {
                position: fixed; top: 80px; right: 20px; z-index: 99999;
                background: #1e1e2e; color: #cdd6f4; border-radius: 12px;
                box-shadow: 0 4px 24px rgba(0,0,0,.4); font-family: system-ui;
                width: 260px; user-select: none;
            }
            #dy-export-panel .head { padding: 12px 14px 8px; font-weight: 700; font-size: 14px; border-bottom: 1px solid #313244; }
            #dy-export-panel .body { padding: 10px 14px 14px; }
            #dy-export-panel .btns { display: flex; gap: 6px; }
            #dy-export-panel button { flex: 1; padding: 8px 0; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500; }
            #dy-export-panel .btn-start { background: #89b4fa; color: #1e1e2e; }
            #dy-export-panel .btn-stop { background: #f38ba8; color: #1e1e2e; }
            #dy-export-panel .btn-export { background: #a6e3a1; color: #1e1e2e; width: 100%; margin-top: 6px; }
            #dy-export-panel .status { margin-top: 8px; font-size: 11px; color: #a6adc8; max-height: 180px; overflow-y: auto; white-space: pre-line; line-height: 1.6; }
            #dy-export-panel .hint { color: #f9e2af; font-weight: 600; }
        </style>
        <div class="head">📦 抖音数据导出</div>
        <div class="body">
            <div class="btns">
                <button class="btn-start" id="dy-btn-start">🔍 开始采集</button>
                <button class="btn-stop" id="dy-btn-stop" style="display:none">⏹ 停止</button>
            </div>
            <button class="btn-export" id="dy-btn-export" disabled>📥 导出 JSON</button>
            <div class="status" id="dy-status"></div>
        </div>`;
        document.body.appendChild(panel);

        const statusEl = panel.querySelector('#dy-status');
        const startBtn = panel.querySelector('#dy-btn-start');
        const stopBtn = panel.querySelector('#dy-btn-stop');
        const exportBtn = panel.querySelector('#dy-btn-export');

        function log(msg) {
            statusEl.textContent += '\n' + msg;
            statusEl.scrollTop = statusEl.scrollHeight;
        }
        function hint(msg) {
            log(`👉 ${msg}`);
        }

        // DOM 抓取
        function scrapeVideos() {
            const seen = new Set(),
                results = [];
            for (const a of document.querySelectorAll(
                'a[href*="/video/"], a[href*="/note/"]'
            )) {
                const m = a.href.match(/(video|note)\/(\d+)/);
                if (!m || seen.has(m[2])) continue;
                seen.add(m[2]);
                const img = a.querySelector('img');
                results.push({
                    id: m[2],
                    type: m[1],
                    title:
                        img?.alt || img?.title || a.textContent?.trim() || '',
                    url: `https://www.douyin.com/${m[1]}/${m[2]}`
                });
            }
            return results;
        }

        // 滚动（带停止检测）
        async function autoScroll(label, maxRound = 100) {
            let lastCount = 0,
                stale = 0;
            for (let i = 0; i < maxRound; i++) {
                if (stopped) break;
                window.scrollTo(0, document.body.scrollHeight);
                await sleep(1500);
                const dom = document.querySelectorAll(
                    'a[href*="/video/"], a[href*="/note/"]'
                ).length;
                const api = apiCache.favorites.length + apiCache.likes.length;
                log(`  ${label} ${i + 1}  DOM=${dom}  API=${api}`);
                if (dom === lastCount) {
                    stale++;
                    if (stale >= 5) break;
                } else stale = 0;
                lastCount = dom;
            }
        }

        // ===== 主流程 =====
        let collectedData = {};
        window.__dyExportData = collectedData;

        startBtn.addEventListener('click', async () => {
            stopped = false;
            startBtn.style.display = 'none';
            stopBtn.style.display = '';
            exportBtn.disabled = true;
            statusEl.textContent = '';

            try {
                // 1. 个人主页
                log('📋 读取个人主页...');
                const t = document.body.innerText;
                collectedData.profile = {
                    name:
                        document.querySelector('h1')?.textContent?.trim() || '',
                    douyinId: (t.match(/抖音号[：:]\s*(\d+)/) || [])[1] || '',
                    followCount: (t.match(/关注\s*(\d[\d.]*)/) || [])[1] || '',
                    fanCount: (t.match(/粉丝\s*(\d[\d.]*)/) || [])[1] || '',
                    likeCount: (t.match(/获赞\s*(\d[\d.]*)/) || [])[1] || ''
                };
                log(
                    `  ✅ ${collectedData.profile.name} (关注${collectedData.profile.followCount} 粉丝${collectedData.profile.fanCount})`
                );

                // 2. 收藏夹
                log('\n❤️ 采集收藏夹');
                hint('请确认你在「收藏」tab，脚本会自动滚动加载');
                await sleep(3000);
                await autoScroll('收藏');
                collectedData.favorites =
                    apiCache.favorites.length > 0
                        ? apiCache.favorites
                        : scrapeVideos();
                log(`  ✅ 收藏 ${collectedData.favorites.length} 条\n`);

                // 3. 关注列表
                log('👥 采集关注列表');
                hint('即将点击「关注」数字，请不要操作页面');
                await sleep(2000);
                let clicked = false;
                for (const s of document.querySelectorAll('div, span')) {
                    const text = s.textContent?.trim();
                    if (text === '关注' || text.match(/^关注\s*\d+$/)) {
                        let el = s.parentElement;
                        for (let i = 0; i < 5; i++) {
                            if (el && el.offsetWidth > 0) {
                                el.click();
                                clicked = true;
                                break;
                            }
                            el = el?.parentElement;
                        }
                        if (clicked) break;
                    }
                }
                if (clicked) {
                    hint(
                        '弹窗已打开，请手动向下滚动到底，脚本也在尝试自动滚动'
                    );
                    await sleep(3000);
                    for (let i = 0; i < 30; i++) {
                        if (stopped) break;
                        for (const sel of [
                            '[class*="modal"]',
                            '[class*="Modal"]',
                            '[class*="popup"]',
                            '[class*="Popup"]',
                            '[class*="dialog"]',
                            '[class*="list-wrapper"]'
                        ]) {
                            for (const el of document.querySelectorAll(sel)) {
                                if (el.scrollHeight > el.clientHeight + 10)
                                    el.scrollTop = el.scrollHeight;
                            }
                        }
                        window.scrollTo(0, document.body.scrollHeight);
                        await sleep(1500);
                        // DOM 补充
                        for (const a of document.querySelectorAll(
                            'a[href*="/user/"]'
                        )) {
                            if (a.href.includes('/user/self')) continue;
                            const uid =
                                a.href.match(/user\/([A-Za-z0-9_-]+)/)?.[1] ||
                                '';
                            if (
                                !uid ||
                                apiCache.following.some((x) => x.secUid === uid)
                            )
                                continue;
                            const name = a.textContent?.trim() || '';
                            if (name.length > 0 && name.length < 40) {
                                apiCache.following.push({
                                    name,
                                    secUid: uid,
                                    url: a.href
                                });
                            }
                        }
                        log(
                            `  弹窗 ${i + 1}  API=${apiCache.following.length}个`
                        );
                    }
                    // 关闭弹窗
                    const closeBtn = document.querySelector(
                        '[class*="close"], [aria-label="close"], [aria-label="Close"]'
                    );
                    if (closeBtn) closeBtn.click();
                    else
                        document.dispatchEvent(
                            new KeyboardEvent('keydown', { key: 'Escape' })
                        );
                    await sleep(1000);
                }
                collectedData.following = apiCache.following;
                log(`  ✅ 关注 ${collectedData.following.length} 个\n`);

                // 4. 喜欢列表
                if (!stopped) {
                    log('👍 采集喜欢列表');
                    hint('即将切换到「喜欢」tab，请不要操作');
                    await sleep(1000);
                    const likeTab = Array.from(
                        document.querySelectorAll('[role="tab"]')
                    ).find((t) => t.textContent?.trim() === '喜欢');
                    if (likeTab) {
                        likeTab.click();
                        await sleep(4000);
                    }
                    hint('请手动向下滚动加载更多喜欢的内容');
                    await autoScroll('喜欢');
                    collectedData.likes =
                        apiCache.likes.length > 0
                            ? apiCache.likes
                            : scrapeVideos();
                    log(`  ✅ 喜欢 ${collectedData.likes.length} 条\n`);
                }

                // 汇总
                collectedData.collectedAt = new Date().toISOString();
                const total =
                    collectedData.favorites.length +
                    collectedData.likes.length +
                    collectedData.following.length;
                log(`🎉 采集完成！共 ${total} 条`);
                log(
                    `   收藏 ${collectedData.favorites.length} | 喜欢 ${collectedData.likes.length} | 关注 ${collectedData.following.length}`
                );
                exportBtn.disabled = false;
            } catch (e) {
                log(`❌ 出错: ${e.message}`);
            } finally {
                startBtn.style.display = '';
                stopBtn.style.display = 'none';
            }
        });

        // 停止按钮
        stopBtn.addEventListener('click', () => {
            stopped = true;
            log('\n⏹ 已停止采集');
            // 直接导出已有数据
            if (
                collectedData.favorites?.length ||
                collectedData.following?.length ||
                collectedData.likes?.length
            ) {
                exportBtn.disabled = false;
            }
        });

        // 导出
        exportBtn.addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(collectedData, null, 2)], {
                type: 'application/json'
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `douyin-export-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            log(`📥 已导出: ${a.download}`);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
})();
