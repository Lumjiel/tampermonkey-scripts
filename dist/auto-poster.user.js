// ==UserScript==
// @name         学习通智能发帖助手
// @namespace    https://github.com/Lumjiel/chaoxing-helper
// @version      1.1.0
// @description  一键解放双手，自动循环发帖，支持任务队列和断点续传
// @author       Lumjiel
// @match        *://*.chaoxing.com/*
// @match        *://groupweb.chaoxing.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ====== 上下文检测 ======
    // 讨论区内容已迁移至 groupweb.chaoxing.com 的跨域 iframe 中
    // 脚本需要在 iframe 内运行才能操作编辑器 DOM
    if (window.top === window) {
        // 主页面：讨论元素在跨域 iframe 中，无法访问
        return;
    }

    const CONFIG_KEY = 'chaoxing_config_v12';
    const TASK_POOL_KEY = 'chaoxing_task_pool_v12';

    const DEFAULT_CONFIG = {
        title: `自动发帖 ${new Date().toLocaleDateString()}`,
        contentRaw: `这是第1条自动发布的内容\n这是第2条自动发布的内容\n这是第3条自动发布的内容`,
        interval: 3,
        autoStartOnLoad: true
    };

    let config = { ...DEFAULT_CONFIG };
    let isUILoaded = false;
    let isRunning = false;

    const loadConfig = () => {
        try {
            const saved = GM_getValue(CONFIG_KEY);
            if (saved) config = { ...DEFAULT_CONFIG, ...saved };
        } catch (e) {
            console.error('[发帖助手] 加载配置失败:', e);
        }
    };

    const saveConfig = () => {
        try {
            GM_setValue(CONFIG_KEY, config);
            showMessage('✅ 配置已保存', 'success');
        } catch (e) {
            showMessage('❌ 保存失败', 'error');
        }
    };

    const getTaskPool = () => GM_getValue(TASK_POOL_KEY, []);

    const setTaskPool = (contents) => GM_setValue(TASK_POOL_KEY, contents);

    const preConsumeTask = () => {
        const pool = getTaskPool();
        if (pool.length === 0) return null;

        const firstItem = pool.shift();
        setTaskPool(pool);
        return firstItem;
    };

    const unshiftTask = (content) => {
        const pool = getTaskPool();
        pool.unshift(content);
        setTaskPool(pool);
    };

    const clearTaskPool = () => GM_deleteValue(TASK_POOL_KEY);

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    const createUI = () => {
        const oldUI = document.getElementById('chaoxing-post-ui');
        if (oldUI) oldUI.remove();

        const uiContainer = document.createElement('div');
        uiContainer.id = 'chaoxing-post-ui';
        uiContainer.style.cssText = `
            position: fixed !important; top: 20px !important; right: 20px !important;
            z-index: 999999 !important; background: white !important; border-radius: 12px !important;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2) !important; width: 380px !important;
            padding: 0 !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
            overflow: hidden !important;
        `;

        uiContainer.innerHTML = `
            <div id="ui-header" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="font-size: 16px; font-weight: bold;">📝 学习通发帖助手</div>
                    <div style="font-size: 10px; opacity: 0.8; background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 10px;">v12.0</div>
                </div>
                <div style="display: flex; align-items: center; gap: 5px;">
                    <div id="pool-badge" style="display: none; background: #ff5722; color: white; font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: bold;">剩余: 0</div>
                    <button id="toggle-btn" style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0 5px; line-height: 1;">▲</button>
                </div>
            </div>
            <div id="ui-content" style="padding: 20px;">
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; color: #666; font-size: 14px; font-weight: 500;">发帖标题：</label>
                    <input type="text" id="post-title" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box;" value="${config.title.replace(/"/g, '&quot;')}">
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; color: #666; font-size: 14px; font-weight: 500;">内容列表 (每行一条)：</label>
                    <textarea id="content-list" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; min-height: 100px; resize: vertical; box-sizing: border-box; font-size: 13px;" placeholder="请输入内容...">${config.contentRaw.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; color: #666; font-size: 14px;">间隔(秒)：</label>
                    <input type="number" id="post-interval" min="1" value="${config.interval}" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box;">
                </div>
                <div style="margin-bottom: 15px; display: flex; align-items: center; justify-content: space-between;">
                    <label style="display: flex; align-items: center; cursor: pointer;">
                        <input type="checkbox" id="auto-start" ${config.autoStartOnLoad ? 'checked' : ''} style="margin-right: 8px;">
                        <span style="color: #666; font-size: 13px;">刷新自动续传</span>
                    </label>
                    <button id="save-config" style="padding: 6px 12px; background: #f0f0f0; border: 1px solid #ddd; border-radius: 6px; cursor: pointer; font-size: 12px;">💾 保存</button>
                </div>
                <div style="display: flex; gap: 10px; margin-bottom: 15px;">
                    <button id="start-btn" style="flex: 2; background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); color: white; border: none; padding: 12px; border-radius: 8px; cursor: pointer; font-weight: bold;">🚀 开始任务</button>
                    <button id="stop-btn" style="flex: 1; background: #607d8b; color: white; border: none; padding: 12px; border-radius: 8px; cursor: pointer;">⏹ 结束</button>
                </div>
                <div id="progress-info" style="padding: 12px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef;">
                    <div id="progress-text" style="color: #666; font-size: 13px;">等待开始...</div>
                </div>
            </div>
        `;

        document.body.appendChild(uiContainer);
        isUILoaded = true;
        updateProgressUI();
    };

    let isCollapsed = false;

    const toggleCollapse = () => {
        const content = document.getElementById('ui-content');
        const btn = document.getElementById('toggle-btn');
        if (!content) return;

        if (isCollapsed) {
            content.style.display = 'block';
            content.style.padding = '20px';
            btn.innerHTML = '▲';
        } else {
            content.style.display = 'none';
            content.style.padding = '0';
            btn.innerHTML = '▼';
        }
        isCollapsed = !isCollapsed;
    };

    const initEventListeners = () => {
        document.getElementById('toggle-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleCollapse();
        });
        document.getElementById('ui-header').addEventListener('dblclick', toggleCollapse);

        document.getElementById('save-config').addEventListener('click', () => {
            config.title = document.getElementById('post-title').value;
            config.contentRaw = document.getElementById('content-list').value;
            config.interval = parseInt(document.getElementById('post-interval').value);
            config.autoStartOnLoad = document.getElementById('auto-start').checked;
            saveConfig();
        });

        document.getElementById('start-btn').addEventListener('click', () => startAutoPosting(false));
        document.getElementById('stop-btn').addEventListener('click', () => {
            if (confirm('确定要结束并清空任务吗？')) {
                isRunning = false;
                clearTaskPool();
                updateProgressUI();
                showMessage('🔃 任务已结束', 'info');
            }
        });
    };

    const showMessage = (msg, type = 'info') => {
        if (!isUILoaded) return;
        const text = document.getElementById('progress-text');
        if (text) {
            text.textContent = msg;
            text.style.color = type === 'success' ? '#4CAF50' : type === 'error' ? '#F44336' : type === 'warning' ? '#FF9800' : '#2196F3';
        }
    };

    const updateProgressUI = () => {
        if (!isUILoaded) return;
        const pool = getTaskPool();
        const badge = document.getElementById('pool-badge');

        if (pool && pool.length > 0) {
            badge.style.display = 'inline-block';
            badge.textContent = `剩余: ${pool.length}`;
        } else {
            badge.style.display = 'none';
        }
    };

    const waitForElement = (selector, timeout) => {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const el = document.querySelector(selector);
                if (el) resolve(el);
                else if (Date.now() - start > timeout) reject(new Error('Timeout waiting for ' + selector));
                else setTimeout(check, 200);
            };
            check();
        });
    };

    const waitForCondition = (cond, timeout) => {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                if (cond()) resolve();
                else if (Date.now() - start > timeout) reject(new Error('Condition timeout'));
                else setTimeout(check, 200);
            };
            check();
        });
    };

    const findNewTopicButton = async () => {
        return new Promise((resolve) => {
            let attempts = 0;
            const check = () => {
                attempts++;
                // 优先使用专用类选择器
                let btn = document.querySelector('.createTopic, .newTopic, [class*="newTopic"], [class*="new-topic"]');
                // 兜底按文本匹配（限定在按钮/链接元素中，避免误匹配话题标题）
                if (!btn) {
                    const keywords = ['新建话题', '新话题', '发表话题', '发帖'];
                    const all = document.querySelectorAll('button, a, span, div[onclick], div[class*="btn"]');
                    for (const el of all) {
                        const txt = (el.textContent || '').trim();
                        if (txt.length < 10 && keywords.some(kw => txt.includes(kw))) {
                            btn = el;
                            break;
                        }
                    }
                }
                if (btn) {
                    resolve(btn);
                    return;
                }
                if (attempts < 10) setTimeout(check, 500);
                else resolve(null);
            };
            check();
        });
    };

    const fillEditorContent = async (content) => {
        try {
            const iframe = await waitForElement('iframe#ueditor_0, iframe#uiditor_0', 4000);
            await wait(800);
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!doc) return false;

            await waitForCondition(() => doc.body && doc.querySelector('body[contenteditable="true"]'), 3000);
            const body = doc.querySelector('body[contenteditable="true"]');
            if (!body) return false;

            body.innerHTML = '';
            const p = doc.createElement('p');
            p.textContent = content;
            body.appendChild(p);

            ['input', 'change', 'keyup'].forEach(evt => body.dispatchEvent(new Event(evt, { bubbles: true })));

            if (unsafeWindow.UE && unsafeWindow.UE.instants) {
                Object.keys(unsafeWindow.UE.instants).forEach(key => {
                    try {
                        unsafeWindow.UE.instants[key].fireEvent('contentChange');
                    } catch (e) {
                    }
                });
            }
            return true;
        } catch (e) {
            console.error('[发帖助手] 填写内容失败:', e);
            return false;
        }
    };

    const waitForPublishButtonEnabled = (timeout) => {
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                let btn = document.querySelector('.jb_btn_92:not(.jb_btn_92_disable)');
                if (!btn) {
                    const btns = document.querySelectorAll('button');
                    for (const b of btns) {
                        if ((b.textContent.includes('发布') || b.textContent.includes('发表')) && !b.disabled) {
                            btn = b;
                            break;
                        }
                    }
                }

                if (btn) resolve(btn);
                else if (Date.now() - start > timeout) resolve(null);
                else setTimeout(check, 300);
            };
            check();
        });
    };

    const postSingle = async (title, content) => {
        console.log('[发帖助手] 开始发帖:', content);

        const newTopicBtn = await findNewTopicButton();
        if (!newTopicBtn) throw new Error('找不到新建话题按钮');
        newTopicBtn.click();

        await waitForElement('.editContainer, iframe#ueditor_0, iframe#uiditor_0', 5000);
        await wait(1000);

        const titleInput = document.querySelector('.edit_title input') || document.querySelector('input[name="title"]');
        if (titleInput) {
            titleInput.value = title;
            titleInput.dispatchEvent(new Event('input', { bubbles: true }));
            titleInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const fillResult = await fillEditorContent(content);
        if (!fillResult) throw new Error('填写内容失败');

        await wait(1500);
        const publishBtn = await waitForPublishButtonEnabled(8000);
        if (!publishBtn) throw new Error('发布按钮未启用');

        publishBtn.click();

        try {
            // 等待编辑器容器消失（发帖成功后编辑器会关闭）
            const editorSelector = '.editContainer, iframe#ueditor_0';
            await waitForElement(editorSelector, 4000).then(() => {
                const observer = new MutationObserver(() => {
                    if (!document.querySelector(editorSelector)) {
                        observer.disconnect();
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
            });
        } catch (e) {
        }

        return true;
    };

    const startAutoPosting = async (isResume) => {
        isRunning = true;

        if (!isResume) {
            const rawText = document.getElementById('content-list').value;
            const contents = rawText.split('\n').filter(line => line.trim() !== '');

            if (contents.length === 0) {
                alert('内容列表不能为空！');
                isRunning = false;
                return;
            }

            config.title = document.getElementById('post-title').value;
            config.interval = parseInt(document.getElementById('post-interval').value);
            saveConfig();

            setTaskPool(contents);
            showMessage(`🚀 任务启动，共 ${contents.length} 条`, 'info');
        }

        let pool = getTaskPool();

        while (pool && pool.length > 0 && isRunning) {
            updateProgressUI();

            const currentContent = preConsumeTask();
            if (!currentContent) break;

            pool = getTaskPool();
            showMessage(`🔜 准备发布，剩余 ${pool.length} 条...`, 'info');

            try {
                const success = await postSingle(config.title, currentContent);

                if (success) {
                    showMessage(`✅ 发布成功`, 'success');

                    if (pool.length > 0 && isRunning) {
                        showMessage(`⏳ 等待 ${config.interval} 秒...`, 'info');
                        await wait(config.interval * 1000);
                    }
                } else {
                    throw new Error('发布函数返回失败');
                }
            } catch (error) {
                console.error('[发帖助手] 发帖出错，回滚任务:', error);
                showMessage(`❌ 发布失败，回滚任务，3秒后重试`, 'error');
                unshiftTask(currentContent);
                await wait(3000);
            }

            pool = getTaskPool();
        }

        pool = getTaskPool();
        if (pool && pool.length === 0) {
            clearTaskPool();
            updateProgressUI();
            showMessage(`🎉 所有任务已完成！`, 'success');
            isRunning = false;
        }
    };

    const checkAndResumeTask = () => {
        const pool = getTaskPool();
        if (pool && pool.length > 0) {
            showMessage(`🔄 检测到未完成任务 (剩余 ${pool.length} 条)`, 'warning');
            updateProgressUI();

            if (config.autoStartOnLoad) {
                setTimeout(() => startAutoPosting(true), 2000);
            }
        }
    };

    const init = () => {
        // 检测编辑器是否已加载（iframe 页面可能先显示讨论列表，编辑器延迟加载）
        const hasEditor = document.querySelector('iframe#ueditor_0') || window.UE;
        if (hasEditor) {
            loadConfig();
            createUI();
            initEventListeners();
            checkAndResumeTask();
            return;
        }

        // 编辑器未就绪，监听 DOM 变化等待加载
        const observer = new MutationObserver(() => {
            if (document.querySelector('iframe#ueditor_0') || window.UE) {
                observer.disconnect();
                loadConfig();
                createUI();
                initEventListeners();
                checkAndResumeTask();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // 30 秒后如果还没找到编辑器，停止监听
        setTimeout(() => observer.disconnect(), 30000);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
