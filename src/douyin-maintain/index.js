// ==UserScript==
// @name         抖音批量管理（取消收藏/喜欢）
// @namespace    http://tampermonkey.net/
// @version      2026-06-22-v3
// @description  批量取消收藏、取消喜欢（API 直调，支持 JSON 输入，自动路由）
// @author       Lumjiel
// @match        https://www.douyin.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=douyin.com
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const API_BASE = '/aweme/v1/web';
    const PARAMS = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
    const MAX_RETRY = 2;

    // ================================================================
    //  API 调用（带重试）
    // ================================================================
    async function apiCall(url, body, retries = MAX_RETRY) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const resp = await fetch(`${API_BASE}${url}?${PARAMS}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body,
                    credentials: 'include'
                });
                const data = await resp.json();
                if (data.status_code === 0) return { ok: true, data };
                // status_code 非 0，可能是限流，等一下重试
                if (attempt < retries) await sleep(2000 * (attempt + 1));
                return {
                    ok: false,
                    error: `status_code=${data.status_code}`,
                    data
                };
            } catch (e) {
                if (attempt < retries) await sleep(2000 * (attempt + 1));
                else return { ok: false, error: e.message };
            }
        }
    }

    async function apiCollect(awemeId) {
        return apiCall(
            '/aweme/collect/',
            `action=0&aweme_id=${awemeId}&aweme_type=0`
        );
    }

    async function apiUncollect(awemeId) {
        return apiCall(
            '/aweme/collect/',
            `action=0&aweme_id=${awemeId}&aweme_type=0`
        );
    }

    async function apiUnlike(awemeId) {
        return apiCall(
            '/commit/item/digg/',
            `aweme_id=${awemeId}&item_type=0&type=0`
        );
    }

    // ================================================================
    //  解析输入（支持纯 ID 列表 和 JSON 格式）
    // ================================================================
    function parseInput(text) {
        text = text.trim();
        if (!text) return { fav: [], like: [] };

        // 尝试 JSON 格式: {"fav": ["id1", ...], "like": ["id2", ...]}
        try {
            const obj = JSON.parse(text);
            if (obj.fav || obj.like) {
                return {
                    fav: (obj.fav || []).map(String),
                    like: (obj.like || []).map(String)
                };
            }
            // 纯数组: ["id1", "id2"]
            if (Array.isArray(obj)) {
                const ids = obj.map(String);
                return { fav: ids, like: [] };
            }
        } catch {
            /* not JSON format */
        }

        // 纯文本：每行一个 ID，全部作为收藏处理
        const ids = text
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
        return { fav: ids, like: [] };
    }

    // ================================================================
    //  UI
    // ================================================================
    function initUI() {
        const panel = document.createElement('div');
        panel.id = 'dy-maintain-panel';
        panel.innerHTML = `
        <style>
            #dy-maintain-panel {
                position: fixed; bottom: 20px; right: 20px; z-index: 99999;
                background: #1e1e2e; color: #cdd6f4; border-radius: 12px;
                box-shadow: 0 4px 24px rgba(0,0,0,.4); font-family: system-ui;
                width: 300px; user-select: none;
            }
            #dy-maintain-panel .head { padding: 12px 14px 8px; font-weight: 700; font-size: 14px; border-bottom: 1px solid #313244; display: flex; justify-content: space-between; align-items: center; }
            #dy-maintain-panel .body { padding: 10px 14px 14px; }
            #dy-maintain-panel button { display: block; width: 100%; margin: 5px 0; padding: 7px 0; border: none; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 500; }
            #dy-maintain-panel .btn-run { background: #f38ba8; color: #1e1e2e; }
            #dy-maintain-panel .btn-run2 { background: #fab387; color: #1e1e2e; }
            #dy-maintain-panel .btn-stop { background: #a6adc8; color: #1e1e2e; }
            #dy-maintain-panel .btn-secondary { background: #585b70; color: #cdd6f4; font-size: 11px; }
            #dy-maintain-panel textarea { width: 100%; height: 70px; background: #313244; color: #cdd6f4; border: 1px solid #45475a; border-radius: 6px; padding: 6px; font-size: 11px; resize: vertical; font-family: monospace; }
            #dy-maintain-panel .status { margin-top: 6px; font-size: 11px; color: #a6adc8; max-height: 150px; overflow-y: auto; white-space: pre-line; line-height: 1.5; }
            #dy-maintain-panel .progress { margin-top: 4px; height: 4px; background: #313244; border-radius: 2px; overflow: hidden; }
            #dy-maintain-panel .progress-bar { height: 100%; background: #a6e3a1; width: 0%; transition: width 0.3s; }
            #dy-maintain-panel .hint { font-size: 10px; color: #6c7086; margin: 4px 0; }
        </style>
        <div class="head">
            <span>🔧 抖音批量管理</span>
            <span style="cursor:pointer;font-size:16px" id="dy-btn-minimize">—</span>
        </div>
        <div class="body">
            <div class="hint">粘贴 ID 列表（每行一个）或 douyin-remove-ids.json 内容</div>
            <textarea id="dy-ids-input" placeholder='粘贴 ID 列表或 JSON...\nJSON 格式: {"fav":["id1"],"like":["id2"]}'></textarea>
            <button class="btn-run" id="dy-btn-run">🚀 一键清理（自动路由）</button>
            <div style="display:flex;gap:5px">
                <button class="btn-run" id="dy-btn-unfav" style="flex:1;font-size:11px">📌 取消收藏</button>
                <button class="btn-run btn-run2" id="dy-btn-unlike" style="flex:1;font-size:11px">👍 取消喜欢</button>
            </div>
            <button class="btn-stop" id="dy-btn-stop">⏹ 停止</button>
            <button class="btn-secondary" id="dy-btn-clear">🗑️ 清除进度</button>
            <div class="progress"><div class="progress-bar" id="dy-progress-bar"></div></div>
            <div class="status" id="dy-maintain-status"></div>
        </div>`;
        document.body.appendChild(panel);

        const input = panel.querySelector('#dy-ids-input');
        const runBtn = panel.querySelector('#dy-btn-run');
        const unfavBtn = panel.querySelector('#dy-btn-unfav');
        const unlikeBtn = panel.querySelector('#dy-btn-unlike');
        const stopBtn = panel.querySelector('#dy-btn-stop');
        const clearBtn = panel.querySelector('#dy-btn-clear');
        const minimizeBtn = panel.querySelector('#dy-btn-minimize');
        const statusEl = panel.querySelector('#dy-maintain-status');
        const progressBar = panel.querySelector('#dy-progress-bar');
        let stopped = false;

        // 恢复输入框
        const saved = localStorage.getItem('dy_maintain_input');
        if (saved) input.value = saved;
        input.addEventListener('input', () =>
            localStorage.setItem('dy_maintain_input', input.value)
        );

        function log(msg) {
            statusEl.textContent += '\n' + msg;
            statusEl.scrollTop = statusEl.scrollHeight;
        }
        function updateProgress(cur, total) {
            progressBar.style.width =
                (total > 0 ? (cur / total) * 100 : 0) + '%';
        }

        // ================================================================
        //  批量执行
        // ================================================================
        async function processBatch(ids, apiFn, actionName) {
            const progressKey = `dy_progress_${actionName}`;
            const completed = new Set(
                JSON.parse(GM_getValue(progressKey, '[]'))
            );
            const pending = ids.filter((id) => !completed.has(id));

            if (completed.size > 0)
                log(
                    `📋 恢复: 已完成 ${completed.size}, 剩余 ${pending.length}`
                );
            log(`\n🚀 ${actionName} ${pending.length} 条`);

            let success = 0,
                fail = 0;
            for (let i = 0; i < pending.length; i++) {
                if (stopped) {
                    log('⏹ 已停止');
                    break;
                }
                const vid = pending[i];

                const result = await apiFn(vid);
                if (result.ok) {
                    success++;
                    completed.add(vid);
                    GM_setValue(progressKey, JSON.stringify([...completed]));
                    log(`✅ [${i + 1}/${pending.length}] ${vid}`);
                } else {
                    fail++;
                    log(
                        `❌ [${i + 1}/${pending.length}] ${vid} — ${result.error}`
                    );
                }

                updateProgress(i + 1, pending.length);
                await sleep(500 + Math.random() * 700);
            }
            log(`\n🎉 完成: ✅${success} ❌${fail} / ${pending.length}`);
            return { success, fail };
        }

        // 一键清理：自动按 source 路由
        runBtn.addEventListener('click', async () => {
            const parsed = parseInput(input.value);
            const total = parsed.fav.length + parsed.like.length;
            if (total === 0) {
                log('⚠️ 请先粘贴 ID 列表');
                return;
            }

            log(
                `\n📊 输入: 收藏 ${parsed.fav.length} + 喜欢 ${parsed.like.length} = ${total}`
            );

            stopped = false;
            if (parsed.fav.length > 0) {
                await processBatch(parsed.fav, apiUncollect, 'unfav');
            }
            if (parsed.like.length > 0 && !stopped) {
                await processBatch(parsed.like, apiUnlike, 'unlike');
            }
        });

        // 单独取消收藏
        unfavBtn.addEventListener('click', async () => {
            const parsed = parseInput(input.value);
            const allIds = [...parsed.fav, ...parsed.like]; // 全部当收藏处理
            if (allIds.length === 0) {
                log('⚠️ 请先粘贴 ID 列表');
                return;
            }
            stopped = false;
            await processBatch(allIds, apiUncollect, 'unfav');
        });

        // 单独取消喜欢
        unlikeBtn.addEventListener('click', async () => {
            const parsed = parseInput(input.value);
            const allIds = [...parsed.fav, ...parsed.like];
            if (allIds.length === 0) {
                log('⚠️ 请先粘贴 ID 列表');
                return;
            }
            stopped = false;
            await processBatch(allIds, apiUnlike, 'unlike');
        });

        stopBtn.addEventListener('click', () => {
            stopped = true;
            log('⏹ 停止');
        });

        clearBtn.addEventListener('click', () => {
            GM_setValue('dy_progress_unfav', '[]');
            GM_setValue('dy_progress_unlike', '[]');
            progressBar.style.width = '0%';
            log('🗑️ 进度已清除');
        });

        minimizeBtn.addEventListener('click', () => {
            const body = panel.querySelector('.body');
            body.style.display = body.style.display === 'none' ? '' : 'none';
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
})();
