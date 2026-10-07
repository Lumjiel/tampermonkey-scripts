// ==UserScript==
// @name         抖音下载器（视频/音频/BGM/封面）
// @namespace    http://tampermonkey.net/
// @version      1.5.1
// @description  拦截抖音网页版数据接口，捕获正在浏览的视频：下载无水印视频（多清晰度，含声音）、纯音轨（m4a）、背景音乐 BGM、封面图。面板顶部固定显示正在播放的视频，可收起成小球。
// @author       Lumjiel
// @match        https://www.douyin.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js
// ==/UserScript==

/* global lamejs */
(function () {
    'use strict';

    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const DBG = {
        fetchHooked: false,
        xhrHooked: false,
        respHooked: false,
        jsonHooked: false,
        urlsSeen: 0,
        parseFail: 0,
        mediaSeen: 0,
        jsonHits: 0,
        hooksReapplied: 0,
        errors: []
    };
    try {
        W.__DYDL_DEBUG = DBG;
    } catch (e) {
        /* 忽略 */
    }

    /* ============================================================
     * 一、数据捕获层
     * 数据可能走的路径全部挂钩：fetch / XHR / Response.prototype /
     * JSON.parse（终极兜底）。媒体流地址单独记录，用于反查当前播放视频。
     * ============================================================ */

    const store = new Map(); // aweme_id -> 归一化条目
    try {
        W.__DYDL_STORE_REF = store;
    } catch (e) {
        /* 忽略 */
    }
    const keyIndex = new Map(); // 媒体文件 tos key -> aweme_id
    const uriIndex = new Map(); // 视频 uri -> aweme_id
    const mediaMap = new Map(); // tos key -> { videoUrl, audioUrl, lastTs }
    let currentId = null;
    let currentKey = null;
    const uiListeners = new Set();
    const notify = () =>
        uiListeners.forEach((fn) => {
            try {
                fn();
            } catch (e) {
                /* 忽略 */
            }
        });

    const MEDIA_URL_RE =
        /douyinvod\.com|byteimg\.com|zjcdn\.com|bytetos\.com|douyinstatic\.com|\/video\/tos\//;
    const MEDIA_TRACK_RE = /media-(video|audio)-/;
    const TOS_KEY_RE = /\/video\/tos\/(?:cn\/)?[^/]+\/([^/?]+)/;
    const AWEME_URL_RE = /\/aweme\//;
    const PLAYING_URL_RE = /danmaku|stats|history\/write|play\/progress/;

    // 保存原始 JSON.parse，内部解析走它，避免递归
    const rawParse = W.JSON.parse;

    function tryParseJson(text) {
        try {
            return rawParse.call(W.JSON, text);
        } catch (e) {
            /* 忽略 */
        }
        // 兼容 chunked stream 接口（响应体带十六进制分块标记）
        try {
            return rawParse.call(
                W.JSON,
                text.replace(/(^|\r?\n)[0-9a-fA-F]{1,8}(\r?\n)/g, '')
            );
        } catch (e) {
            /* 忽略 */
        }
        // 兜底：从第一个 { 开始括号匹配
        const s = text.indexOf('{');
        if (s === -1) return null;
        let depth = 0,
            inStr = false,
            esc = false;
        for (let i = s; i < text.length; i++) {
            const c = text[i];
            if (esc) {
                esc = false;
                continue;
            }
            if (c === '\\') {
                esc = true;
                continue;
            }
            if (c === '"') {
                inStr = !inStr;
                continue;
            }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        return rawParse.call(W.JSON, text.slice(s, i + 1));
                    } catch (e) {
                        return null;
                    }
                }
            }
        }
        return null;
    }

    function collectAwemes(root, out) {
        if (!root || typeof root !== 'object' || out.length > 60) return;
        if (Array.isArray(root)) {
            for (const x of root) collectAwemes(x, out);
            return;
        }
        if (root.aweme_id && root.video && typeof root.video === 'object') {
            out.push(root);
            return;
        }
        for (const k in root) {
            const v = root[k];
            if (v && typeof v === 'object') collectAwemes(v, out);
        }
    }

    function pickUrl(addr) {
        if (!addr) return null;
        const list = Array.isArray(addr.url_list) ? addr.url_list : [];
        for (const u of list) {
            if (/^https:/.test(u) && !/aweme\/v1\/play/.test(u)) return u;
        }
        return list[0] || null;
    }

    function qualityLabel(height, width) {
        if (!height) return '默认';
        const short = Math.min(height, width || height);
        if (short >= 2000) return '4K';
        if (short >= 1400) return '2K';
        return short + 'p';
    }

    function codecLabel(entry, urlKey) {
        const s =
            (urlKey || '') +
            (entry && entry.is_h265 === 1 ? ' h265' : '') +
            (entry && entry.is_bytevc1 === 1 ? ' bytevc1' : '');
        if (/bytevc1|h265|hvc1/i.test(s)) return 'H.265';
        if (/h264|avc/i.test(s)) return 'H.264';
        return '';
    }

    // 建媒体指纹索引：条目 JSON 里出现的所有 /video/tos/ key 都指向这个视频
    function indexFingerprints(rawItem, id) {
        let s;
        try {
            s = JSON.stringify(rawItem);
        } catch (e) {
            return;
        }
        if (typeof s !== 'string') return;
        const matches =
            s.match(/\/video\/tos\/(?:cn\/)?[^/"\\]+\/([^/"\\?]+)/g) || [];
        for (const m of matches) {
            const key = m.match(/([^/]+)$/)[1];
            if (key && key.length > 8 && !keyIndex.has(key))
                keyIndex.set(key, id);
        }
        // uri 索引（用于 v1/play 直链兜底）
        const v = rawItem.video || {};
        const uris = [];
        if (v.play_addr && v.play_addr.uri) uris.push(v.play_addr.uri);
        const fpList = Array.isArray(v.bitrate_list)
            ? v.bitrate_list
            : Array.isArray(v.bit_rate)
              ? v.bit_rate
              : [];
        for (const b of fpList) {
            if (b.play_addr && b.play_addr.uri) uris.push(b.play_addr.uri);
        }
        for (const u of uris) if (!uriIndex.has(u)) uriIndex.set(u, id);
    }

    function normalizeItem(it) {
        const v = it.video || {};
        const qualities = [];
        const seenGear = new Map();

        // 清晰度列表：feed 接口用 bitrate_list，搜索/部分接口用 bit_rate；字段类型不稳定，强制收敛为数组
        const rawList = Array.isArray(v.bitrate_list)
            ? v.bitrate_list
            : Array.isArray(v.bit_rate)
              ? v.bit_rate
              : [];
        const audioList = Array.isArray(v.bit_rate_audio)
            ? v.bit_rate_audio
            : [];
        for (const b of rawList) {
            const addr = b.play_addr || (b.video && b.video.play_addr);
            const url = pickUrl(addr);
            if (!url) continue;
            const h =
                (b.play_addr && b.play_addr.height) ||
                (b.video && b.video.height) ||
                v.height ||
                0;
            const w =
                (b.play_addr && b.play_addr.width) ||
                (b.video && b.video.width) ||
                v.width ||
                0;
            const label = qualityLabel(h, w);
            const br = b.bit_rate || 0;
            const prev = seenGear.get(label);
            if (prev && prev.br >= br) continue;
            seenGear.set(label, {
                label,
                br,
                codec: codecLabel(b, (addr && addr.url_key) || url),
                size: (addr && addr.data_size) || 0,
                w,
                h,
                videoUrl: url
            });
        }
        for (const q of seenGear.values()) qualities.push(q);
        qualities.sort((a, b) => b.br - a.br);

        const defaultUrl =
            pickUrl(v.play_addr) ||
            (qualities[0] && qualities[0].videoUrl) ||
            null;

        let audioUrl = null,
            audioQ = -1;
        for (const x of audioList) {
            const u = pickUrl(x && x.audio_meta);
            if (u && (x.audio_quality || 0) >= audioQ) {
                audioUrl = u;
                audioQ = x.audio_quality || 0;
            }
        }
        if (!audioUrl) {
            for (const b of rawList) {
                const u = pickUrl(b.audio && b.audio.play_addr);
                if (u) {
                    audioUrl = u;
                    break;
                }
            }
        }

        return {
            id: String(it.aweme_id),
            desc: (it.desc || '').trim(),
            author:
                (it.author && (it.author.nickname || it.author.unique_id)) ||
                '未知作者',
            createTime: it.create_time || 0,
            duration: it.duration || v.duration || 0,
            uri: (v.play_addr && v.play_addr.uri) || null,
            coverUrl:
                pickUrl(v.cover) ||
                pickUrl(v.origin_cover) ||
                pickUrl(v.dynamic_cover) ||
                null,
            defaultUrl,
            qualities,
            audioUrl,
            musicUrl: pickUrl(it.music && it.music.play_url),
            stats: it.statistics || {},
            ts: Date.now(),
            playedTs: 0
        };
    }

    function ingest(rawItems) {
        let added = 0;
        for (const it of rawItems) {
            try {
                const n = normalizeItem(it);
                if (!n.id) continue;
                indexFingerprints(it, n.id);
                const isNew = !store.has(n.id);
                const merged = Object.assign(store.get(n.id) || {}, n);
                // 保留已知的播放时间
                merged.playedTs =
                    (store.get(n.id) && store.get(n.id).playedTs) || 0;
                store.set(n.id, merged);
                if (isNew) added++;
            } catch (e) {
                DBG.errors.push('ingest:' + e.message);
            }
        }
        DBG.size = store.size;
        // 新条目可能补全了当前播放视频的数据；指纹兜底仅在无显式信号时使用
        if (
            currentKey &&
            Date.now() - lastExplicitTs > 10000 &&
            keyIndex.get(currentKey)
        ) {
            setCurrentId(keyIndex.get(currentKey), 'fingerprint');
        }
        if (added || (currentId && store.has(currentId))) notify();
    }

    let lastExplicitTs = 0; // 最近一次显式播放信号（弹幕/统计/详情页 URL）的时间
    function setCurrentId(id, source) {
        if (!id) return;
        const it = store.get(id);
        if (it) it.playedTs = Date.now();
        if (source === 'url') {
            // 显式信号最可信：立即生效，并作废媒体指纹，防止预取的媒体流冒充
            lastExplicitTs = Date.now();
            currentKey = null;
        }
        if (id !== currentId) {
            currentId = id;
            notify();
        }
    }

    function markPlayingFromUrl(url, body) {
        const m =
            url.match(/group_id[=:](\d{15,25})/) ||
            (body || '').match(
                /(?:aweme_id|group_id)"?\s*[:=]\s*"?(\d{15,25})"?/
            );
        if (m) setCurrentId(m[1], 'url');
    }

    /* ---- 媒体流指纹：播放器拉流 = 正在播放这个视频 ---- */
    function noteMediaUrl(url) {
        DBG.mediaSeen++;
        const m = url.match(MEDIA_TRACK_RE);
        const keyM = url.match(TOS_KEY_RE);
        if (!m || !keyM) return;
        const key = keyM[1];
        currentKey = key;
        let rec = mediaMap.get(key);
        if (!rec) {
            rec = { videoUrl: null, audioUrl: null, lastTs: 0 };
            mediaMap.set(key, rec);
        }
        if (m[1] === 'video' && !rec.videoUrl) rec.videoUrl = url;
        if (m[1] === 'audio' && !rec.audioUrl) rec.audioUrl = url;
        rec.lastTs = Date.now();
        // 播放器会预取后续视频的媒体流，指纹只在没有显式信号时作兜底
        if (Date.now() - lastExplicitTs > 10000) {
            currentKey = key;
            const id = keyIndex.get(key);
            if (id) setCurrentId(id, 'fingerprint');
        }
    }

    function handleText(url, text) {
        DBG.urlsSeen++;
        if (!text || text.length < 50) return;
        if (PLAYING_URL_RE.test(url)) return markPlayingFromUrl(url, null); // 响应体可能是列表，不可信
        const j = tryParseJson(text);
        if (!j) {
            DBG.parseFail++;
            return;
        }
        const items = [];
        collectAwemes(j, items);
        if (items.length) ingest(items);
    }

    /* ---- 兜底网 1：JSON.parse（任何传输方式的数据最终都要解析） ---- */
    try {
        const origParse = W.JSON.parse;
        W.JSON.parse = function (t, ...rest) {
            const r = origParse.apply(this, arguments);
            try {
                if (
                    typeof t === 'string' &&
                    t.length > 200 &&
                    t.indexOf('"aweme_id"') !== -1
                ) {
                    DBG.jsonHits++;
                    const items = [];
                    collectAwemes(r, items);
                    if (items.length) ingest(items);
                }
            } catch (e) {
                DBG.errors.push('json:' + e.message);
            }
            return r;
        };
        DBG.jsonHooked = true;
    } catch (e) {
        DBG.errors.push('hookJson:' + e.message);
    }

    /* ---- 兜底网 2：Response.prototype（SDK 包了 fetch 也逃不掉） ---- */
    try {
        const RP = W.Response && W.Response.prototype;
        if (RP) {
            for (const method of ['json', 'text']) {
                const orig = RP[method];
                if (typeof orig !== 'function') continue;
                RP[method] = async function (...args) {
                    const r = await orig.apply(this, args);
                    try {
                        const u = this.url || '';
                        if (MEDIA_URL_RE.test(u)) {
                            if (MEDIA_TRACK_RE.test(u)) noteMediaUrl(u);
                        } else if (AWEME_URL_RE.test(u)) {
                            handleText(
                                u,
                                typeof r === 'string'
                                    ? r
                                    : rawParse.call(W.JSON, JSON.stringify(r))
                            );
                        }
                    } catch (e) {
                        /* 忽略 */
                    }
                    return r;
                };
            }
            DBG.respHooked = true;
        }
    } catch (e) {
        DBG.errors.push('hookResp:' + e.message);
    }

    /* ---- 主通道：fetch + XHR ---- */
    function makeFetchWrapper(orig) {
        const wrapper = async function (...args) {
            const res = await orig.apply(this, args);
            try {
                const url = String((args[0] && args[0].url) || args[0] || '');
                if (MEDIA_URL_RE.test(url)) {
                    if (MEDIA_TRACK_RE.test(url)) noteMediaUrl(url);
                } else if (AWEME_URL_RE.test(url)) {
                    const reqBody =
                        args[1] && typeof args[1].body === 'string'
                            ? args[1].body
                            : null;
                    if (PLAYING_URL_RE.test(url))
                        markPlayingFromUrl(url, reqBody);
                    else
                        res.clone()
                            .text()
                            .then((t) => handleText(url, t))
                            .catch(() => {});
                }
            } catch (e) {
                DBG.errors.push('fetch:' + e.message);
            }
            return res;
        };
        try {
            wrapper.__dydl = true;
        } catch (e) {
            /* 忽略 */
        }
        return wrapper;
    }
    try {
        W.fetch = makeFetchWrapper(W.fetch);
        DBG.fetchHooked = true;
    } catch (e) {
        DBG.errors.push('hookFetch:' + e.message);
    }
    setInterval(() => {
        try {
            if (typeof W.fetch === 'function' && !W.fetch.__dydl) {
                W.fetch = makeFetchWrapper(W.fetch);
                DBG.hooksReapplied++;
            }
        } catch (e) {
            /* 忽略 */
        }
    }, 3000);

    (function hookXhr() {
        const XHR = W.XMLHttpRequest;
        if (!XHR || !XHR.prototype) return;
        const decoder =
            typeof TextDecoder !== 'undefined'
                ? new TextDecoder('utf-8')
                : null;
        function extractText(xhr) {
            try {
                const rt = xhr.responseType;
                if (!rt || rt === 'text') return xhr.responseText;
                if (rt === 'json')
                    return xhr.response ? JSON.stringify(xhr.response) : null;
                if (rt === 'arraybuffer') {
                    const buf = xhr.response;
                    if (!buf || buf.byteLength > 12e6 || !decoder) return null;
                    return decoder.decode(new Uint8Array(buf));
                }
            } catch (e) {
                /* 忽略 */
            }
            return null;
        }
        function onLoad(xhr, body) {
            try {
                const url = xhr.__dyUrl || xhr.responseURL || '';
                if (!url) return;
                if (MEDIA_URL_RE.test(url)) {
                    if (MEDIA_TRACK_RE.test(url)) noteMediaUrl(url);
                    return;
                }
                if (!AWEME_URL_RE.test(url)) return;
                if (body && PLAYING_URL_RE.test(url))
                    markPlayingFromUrl(url, String(body));
                const text = extractText(xhr);
                if (text) handleText(url, text);
            } catch (e) {
                DBG.errors.push('xhr:' + e.message);
            }
        }
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url) {
            this.__dyUrl = String(url || '');
            return origOpen.apply(this, arguments);
        };
        XHR.prototype.send = function (body) {
            const xhr = this;
            if (!xhr.__dydlPatched) {
                xhr.__dydlPatched = true;
                xhr.addEventListener('load', () => onLoad(xhr, body));
                xhr.addEventListener('readystatechange', () => {
                    if (xhr.readyState === 4 && !xhr.__dydlDone) {
                        xhr.__dydlDone = true;
                        onLoad(xhr, body);
                    }
                });
            }
            return origSend.apply(this, arguments);
        };
        DBG.xhrHooked = true;
    })();

    /* ============================================================
     * 二、下载层
     * ============================================================ */

    function safeName(s) {
        return (s || '')
            .replace(/[\\/:*?"<>|\n\r\t#]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function buildFilename(item, ext, tag) {
        const parts = [
            safeName(item.author).slice(0, 30),
            safeName(item.desc).slice(0, 50)
        ];
        let name = parts.filter(Boolean).join(' - ');
        if (tag) name += ` [${tag}]`;
        return (name || item.id) + '.' + ext;
    }

    function toast(msg, isErr) {
        let box = document.getElementById('dydl-toast');
        if (!box) {
            box = document.createElement('div');
            box.id = 'dydl-toast';
            box.style.cssText =
                'position:fixed;left:50%;bottom:60px;transform:translateX(-50%);z-index:2147483647;' +
                'padding:9px 18px;border-radius:9px;font-size:13px;color:#fff;pointer-events:none;' +
                'transition:opacity .3s;font-family:system-ui,sans-serif;';
            (document.body || document.documentElement).appendChild(box);
        }
        box.textContent = msg;
        box.style.background = isErr
            ? 'rgba(220,38,38,.92)'
            : 'rgba(20,20,28,.92)';
        box.style.opacity = '1';
        clearTimeout(box.__t);
        box.__t = setTimeout(() => {
            box.style.opacity = '0';
        }, 2600);
    }

    function saveBlob(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 4000);
    }

    function gmXhrBlob(url, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function')
                return reject(new Error('no GM_xmlhttpRequest'));
            GM_xmlhttpRequest({
                url,
                responseType: 'blob',
                timeout: timeoutMs || 120000,
                onload: (r) =>
                    r.status >= 200 && r.status < 300
                        ? resolve(r.response)
                        : reject(new Error('HTTP ' + r.status)),
                onerror: () => reject(new Error('网络错误')),
                ontimeout: () => reject(new Error('超时'))
            });
        });
    }

    function download(url, filename, btn) {
        if (!url) return toast('该内容没有可用的下载地址', true);
        let reverted = false;
        const revert = () => {
            if (reverted || !btn) return;
            reverted = true;
            btn.disabled = false;
            btn.textContent = btn.__dydlLabel;
        };
        if (btn) {
            btn.__dydlLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = '下载中…';
            setTimeout(revert, 60000);
        }
        toast('开始下载：' + filename);
        const done = () => {
            if (btn) {
                btn.textContent = '已开始';
            }
            toast('已交给浏览器下载');
            setTimeout(revert, 2500);
        };
        // 最终兜底：复制直链，绝不用 window.open（无后缀下载会触发系统「选取应用」）
        const lastResort = (why) => {
            revert();
            try {
                GM_setClipboard(url);
            } catch (e) {
                /* 忽略 */
            }
            toast(
                '下载通道失败(' +
                    why +
                    ')，直链已复制到剪贴板，可粘贴到浏览器/IDM 下载',
                true
            );
        };
        // GM_download 报错时把真实原因亮出来（常见：TM「下载 BETA」扩展名白名单）
        const viaGmDownload = (onFail) => {
            if (typeof GM_download !== 'function')
                return onFail('no GM_download');
            try {
                GM_download({
                    url,
                    name: filename,
                    saveAs: false,
                    onload: done,
                    onerror: (e) => {
                        const msg = (e && (e.error || e.message)) || '未知错误';
                        toast('GM_download 失败：' + msg, true);
                        onFail(msg);
                    }
                });
            } catch (e) {
                onFail(e.message);
            }
        };
        const viaXhr = (timeoutMs) => () =>
            gmXhrBlob(url, timeoutMs)
                .then((blob) => {
                    saveBlob(blob, filename);
                    done();
                })
                .catch((e) => lastResort(e.message));
        // 大文件（视频）优先 GM_download（流式省内存）；小文件（音频/封面）优先内存 blob（文件名可靠）
        const isSmall = /\.(mp3|m4a|jpe?g)$/i.test(filename);
        if (isSmall) viaXhr(180000)();
        else viaGmDownload(viaXhr(600000)());
    }

    /* ---- MP3 转码下载：AAC(m4a) 解码为 PCM 后用 lamejs 编码成 mp3 ---- */
    function fetchArrayBuffer(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    url,
                    responseType: 'arraybuffer',
                    timeout: 180000,
                    onload: (r) =>
                        r.status >= 200 && r.status < 300
                            ? resolve(r.response)
                            : reject(new Error('HTTP ' + r.status)),
                    onerror: () => reject(new Error('网络错误')),
                    ontimeout: () => reject(new Error('超时'))
                });
                return;
            }
            fetch(url)
                .then((r) =>
                    r.ok
                        ? r.arrayBuffer()
                        : Promise.reject(new Error('HTTP ' + r.status))
                )
                .then(resolve, reject);
        });
    }

    function ensureLame() {
        if (typeof lamejs !== 'undefined') return Promise.resolve();
        return new Promise((resolve, reject) => {
            const urls = [
                'https://registry.npmmirror.com/lamejs/1.2.1/files/lame.min.js',
                'https://unpkg.com/lamejs@1.2.1/lame.min.js'
            ];
            let i = 0;
            const tryNext = () => {
                if (i >= urls.length)
                    return reject(new Error('mp3 编码库加载失败'));
                const s = document.createElement('script');
                s.src = urls[i++];
                s.onload = () =>
                    typeof lamejs !== 'undefined' ? resolve() : tryNext();
                s.onerror = tryNext;
                (document.head || document.documentElement).appendChild(s);
            };
            tryNext();
        });
    }

    async function downloadAsMp3(url, filename, btn) {
        if (!url) return toast('该内容没有可用的下载地址', true);
        // 已是 mp3（BGM）直接下
        if (/\.mp3($|\?)/i.test(url) || /douyinstatic\.com/.test(url))
            return download(url, filename, btn);
        let reverted = false;
        const setBtn = (t) => {
            if (btn && !reverted) btn.textContent = t;
        };
        const revert = () => {
            if (reverted || !btn) return;
            reverted = true;
            btn.disabled = false;
            btn.textContent = btn.__dydlLabel;
        };
        if (btn) {
            btn.__dydlLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = '获取音频…';
            setTimeout(revert, 180000);
        }
        try {
            toast('正在下载音频并转码为 mp3…');
            const buf = await fetchArrayBuffer(url);
            setBtn('解码中…');
            const AC = W.AudioContext || W.webkitAudioContext;
            if (!AC) throw new Error('浏览器不支持音频解码');
            const ac = new AC();
            const audio = await new Promise((res, rej) => {
                const p = ac.decodeAudioData(buf, res, rej);
                if (p && p.then) p.then(res, rej);
            });
            try {
                ac.close();
            } catch (e) {
                /* 忽略 */
            }
            await ensureLame();
            const chs = Math.min(audio.numberOfChannels, 2);
            const rate = audio.sampleRate;
            const enc = new lamejs.Mp3Encoder(chs, rate, 128);
            const toInt16 = (f32) => {
                const out = new Int16Array(f32.length);
                for (let i = 0; i < f32.length; i++) {
                    const s = Math.max(-1, Math.min(1, f32[i]));
                    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
                }
                return out;
            };
            const left = toInt16(audio.getChannelData(0));
            const right = chs > 1 ? toInt16(audio.getChannelData(1)) : null;
            const blocks = [];
            const BLOCK = 1152;
            let pos = 0;
            const total = left.length;
            const encodeChunk = () => {
                const t0 = performance.now();
                while (pos < total && performance.now() - t0 < 40) {
                    // 分片编码，避免卡 UI
                    const l = left.subarray(pos, pos + BLOCK);
                    const r = right ? right.subarray(pos, pos + BLOCK) : null;
                    const d =
                        chs > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
                    if (d.length) blocks.push(new Int8Array(d));
                    pos += BLOCK;
                }
                if (btn && !reverted)
                    btn.textContent =
                        '转码 ' + Math.round((pos / total) * 100) + '%';
                if (pos < total) {
                    setTimeout(encodeChunk, 0);
                    return;
                }
                const end = enc.flush();
                if (end.length) blocks.push(new Int8Array(end));
                const blob = new Blob(blocks, { type: 'audio/mpeg' });
                saveBlob(blob, filename);
                if (btn) btn.textContent = '已开始';
                toast('mp3 转码完成，已交给浏览器下载');
                setTimeout(revert, 2500);
            };
            encodeChunk();
        } catch (e) {
            revert();
            toast('mp3 转码失败：' + e.message + '（已改下原始 m4a）', true);
            download(url, filename.replace(/\.mp3$/, '.m4a'), btn);
        }
    }

    // uri 直链兜底：内部 play API，302 到带音轨的合成 mp4
    function playApiUrl(uri) {
        return `https://www.douyin.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`;
    }

    function fmtSize(bytes) {
        if (!bytes) return '';
        if (bytes > 1e8) return (bytes / 1e8).toFixed(2) + ' GB';
        if (bytes > 1e5) return Math.round((bytes / 1e6) * 10) / 10 + ' MB';
        return Math.round(bytes / 1e3) + ' KB';
    }

    /* ============================================================
     * 三、可视化面板
     * ============================================================ */

    const CSS = `
#dydl-ball{position:fixed;z-index:2147483647;width:28px;height:28px;border-radius:50%;
  background:linear-gradient(135deg,#fe2c55 0%,#25f4ee 140%);
  box-shadow:0 2px 10px rgba(0,0,0,.4);cursor:pointer;user-select:none;
  display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;
  font-family:system-ui,sans-serif;transition:transform .15s;}
#dydl-ball:hover{transform:scale(1.12);}
#dydl-panel{position:fixed;z-index:2147483647;width:316px;max-height:72vh;display:flex;flex-direction:column;
  background:rgba(18,18,26,.94);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  border:1px solid rgba(255,255,255,.09);border-radius:12px;color:#eee;
  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;
  box-shadow:0 10px 36px rgba(0,0,0,.5);}
#dydl-head{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:move;user-select:none;
  border-bottom:1px solid rgba(255,255,255,.07);}
#dydl-head .dydl-title{font-weight:700;font-size:12.5px;flex:1;}
#dydl-head .dydl-title small{opacity:.45;font-weight:400;margin-left:6px;}
.dydl-icon-btn{width:22px;height:22px;border:none;border-radius:6px;background:rgba(255,255,255,.08);
  color:#ccc;cursor:pointer;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;
  font-family:inherit;}
.dydl-icon-btn:hover{background:rgba(255,255,255,.16);color:#fff;}
#dydl-inputrow{display:flex;gap:6px;padding:8px 10px 0;}
.dydl-input{flex:1;min-width:0;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
  border-radius:8px;color:#eee;font-size:11.5px;padding:6px 10px;outline:none;font-family:inherit;}
.dydl-input:focus{border-color:rgba(37,244,238,.5);}
.dydl-input::placeholder{color:#666;}
#dydl-body{overflow-y:auto;padding:8px 10px 10px;scrollbar-width:thin;scrollbar-color:#333 transparent;}
#dydl-body::-webkit-scrollbar{width:4px}
#dydl-body::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
.dydl-card{border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:8px;margin-bottom:6px;
  background:rgba(255,255,255,.035);}
.dydl-card.dydl-current{border-color:rgba(254,44,85,.55);background:rgba(254,44,85,.06);}
.dydl-cover{width:44px;height:58px;object-fit:cover;border-radius:6px;flex:none;background:#222;}
.dydl-row{display:flex;gap:8px;}
.dydl-info{flex:1;min-width:0;}
.dydl-title2{font-weight:600;font-size:11.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden;word-break:break-all;}
.dydl-meta{margin-top:4px;font-size:10.5px;color:#888;display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.dydl-tag{padding:1px 6px;border-radius:4px;background:rgba(37,244,238,.12);color:#25f4ee;font-size:10px;}
.dydl-tag.live{background:rgba(254,44,85,.14);color:#fe2c55;}
.dydl-btns{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap;position:relative;}
.dydl-btn{border:none;border-radius:7px;padding:4px 10px;font-size:11px;cursor:pointer;color:#fff;
  background:rgba(255,255,255,.09);transition:background .15s;font-family:inherit;}
.dydl-btn:hover{background:rgba(255,255,255,.17);}
.dydl-btn.primary{background:linear-gradient(135deg,#fe2c55,#ff5f7a);}
.dydl-btn.primary:hover{filter:brightness(1.12);}
.dydl-btn.cyan{background:rgba(37,244,238,.16);color:#25f4ee;}
.dydl-btn.cyan:hover{background:rgba(37,244,238,.26);}
.dydl-menu{position:absolute;bottom:calc(100% + 5px);left:0;min-width:190px;max-height:230px;overflow-y:auto;
  background:#1c1c28;border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:4px;
  box-shadow:0 8px 24px rgba(0,0,0,.55);z-index:10;}
.dydl-menu-item{padding:7px 9px;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between;gap:10px;
  font-size:11.5px;white-space:nowrap;}
.dydl-menu-item:hover{background:rgba(255,255,255,.09);}
.dydl-menu-item small{color:#777;font-size:10.5px;}
.dydl-empty{text-align:center;padding:20px 8px;color:#666;font-size:11.5px;line-height:1.9;}
.dydl-hint{font-size:10.5px;color:#999;line-height:1.7;}
.dydl-sec{font-size:10.5px;color:#777;margin:8px 2px 6px;display:flex;align-items:center;gap:8px;}
.dydl-sec::after{content:'';flex:1;height:1px;background:rgba(255,255,255,.07);}
`;

    function fmtDuration(ms) {
        if (!ms) return '';
        const s = Math.round(ms / 1000);
        const m = Math.floor(s / 60);
        return m + ':' + String(s % 60).padStart(2, '0');
    }

    function fmtNum(n) {
        if (n == null) return '';
        if (n >= 10000)
            return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
        return String(n);
    }

    function buildCard(item, isCurrent) {
        const card = document.createElement('div');
        card.className = 'dydl-card' + (isCurrent ? ' dydl-current' : '');
        card.dataset.id = item.id;

        const img = document.createElement('img');
        img.className = 'dydl-cover';
        img.loading = 'lazy';
        if (item.coverUrl) {
            img.src = item.coverUrl;
            img.onerror = () => {
                img.style.visibility = 'hidden';
            };
        }

        const info = document.createElement('div');
        info.className = 'dydl-info';
        const title = document.createElement('div');
        title.className = 'dydl-title2';
        title.textContent = item.desc || '(无标题)';
        const meta = document.createElement('div');
        meta.className = 'dydl-meta';
        meta.innerHTML =
            `<span class="dydl-author"></span>` +
            (item.duration
                ? `<span>${fmtDuration(item.duration)}</span>`
                : '') +
            `<span class="dydl-tag${isCurrent ? ' live' : ''}">${isCurrent ? '播放中' : '已捕获'}</span>`;
        meta.querySelector('.dydl-author').textContent = '@' + item.author;
        const st = item.stats || {};
        const statParts = [];
        if (st.digg_count) statParts.push('赞 ' + fmtNum(st.digg_count));
        if (st.comment_count) statParts.push('评 ' + fmtNum(st.comment_count));
        if (st.collect_count) statParts.push('藏 ' + fmtNum(st.collect_count));
        info.append(title, meta);
        if (statParts.length) {
            const stats = document.createElement('div');
            stats.className = 'dydl-meta';
            stats.textContent = statParts.join(' · ');
            info.append(stats);
        }

        const btns = document.createElement('div');
        btns.className = 'dydl-btns';

        const btnVideo = mkBtn(
            item.qualities.length ? `视频 ${item.qualities.length}档` : '视频',
            'primary'
        );
        const btnAudio = mkBtn('音频', 'cyan');
        btnVideo.title = '无水印合成 MP4，含声音';
        btnAudio.title = '视频原声，转码为 mp3（适合 AI 转录）';
        btns.append(btnVideo, btnAudio);
        // 没有独立音轨时「音频」用的就是 BGM，BGM 按钮不重复出现
        const showBgm = item.musicUrl && item.audioUrl;
        let btnBgm = null,
            btnCover = null;
        if (showBgm) {
            btnBgm = mkBtn('BGM');
            btnBgm.title = '作者使用的配乐原声，mp3';
            btns.append(btnBgm);
        }
        if (item.coverUrl) {
            btnCover = mkBtn('封面');
            btnCover.title = '视频封面原图';
            btns.append(btnCover);
        }

        btnAudio.onclick = () => {
            const url = item.audioUrl || item.musicUrl;
            if (!url) return toast('没有可用的音频地址', true);
            downloadAsMp3(url, buildFilename(item, 'mp3', '音频'), btnAudio);
        };
        if (btnBgm)
            btnBgm.onclick = () =>
                download(
                    item.musicUrl,
                    buildFilename(item, 'mp3', 'BGM'),
                    btnBgm
                );
        if (btnCover)
            btnCover.onclick = () =>
                download(
                    item.coverUrl,
                    buildFilename(item, 'jpeg', '封面'),
                    btnCover
                );

        let menu = null;
        const closeMenu = () => {
            if (menu) {
                menu.remove();
                menu = null;
            }
        };
        btnVideo.onclick = (e) => {
            e.stopPropagation();
            if (menu) return closeMenu();
            menu = document.createElement('div');
            menu.className = 'dydl-menu';
            const add = (text, sub, fn) => {
                const it = document.createElement('div');
                it.className = 'dydl-menu-item';
                it.innerHTML = `<span></span>` + (sub ? `<small></small>` : '');
                it.children[0].textContent = text;
                if (sub) it.children[1].textContent = sub;
                it.onclick = () => {
                    closeMenu();
                    fn();
                };
                menu.appendChild(it);
            };
            const defs = item.qualities.filter((q) => q.videoUrl);
            if (item.defaultUrl) {
                const top = defs[0];
                add(
                    '默认清晰度',
                    top ? `${top.label} · 含声音` : '含声音',
                    () => download(item.defaultUrl, buildFilename(item, 'mp4'))
                );
            } else if (item.uri) {
                add('默认清晰度(直链)', '含声音', () =>
                    download(playApiUrl(item.uri), buildFilename(item, 'mp4'))
                );
            }
            for (const q of defs) {
                const sub = [
                    fmtSize(q.size),
                    Math.round(q.br / 1000) + 'kbps',
                    q.codec
                ]
                    .filter(Boolean)
                    .join(' · ');
                add(`${q.label}`, sub, () =>
                    download(q.videoUrl, buildFilename(item, 'mp4', q.label))
                );
            }
            if (!defs.length && !item.defaultUrl && !item.uri)
                add('(未捕获到视频地址)', '', () => {});
            btns.appendChild(menu);
        };

        card.append(img, info, btns);
        return card;
    }

    // 正在播放但没有条目数据时的占位卡
    function buildPlaceholder(id) {
        const card = document.createElement('div');
        card.className = 'dydl-card dydl-current';
        const media = currentKey ? mediaMap.get(currentKey) : null;
        const hint = document.createElement('div');
        hint.className = 'dydl-hint';
        hint.innerHTML =
            `<b style="color:#fe2c55">正在播放的视频数据尚未捕获</b><br>` +
            `id: ${id}<br>通常是脚本注入晚于首屏数据。`;
        const fixBtn = mkBtn('打开详情页获取下载', 'primary');
        fixBtn.style.marginTop = '7px';
        fixBtn.onclick = () => {
            location.href = 'https://www.douyin.com/video/' + id;
        };
        hint.appendChild(document.createElement('br'));
        hint.appendChild(fixBtn);
        card.appendChild(hint);
        // 有媒体流地址时提供直接下载（视频无声，音频完整）
        if (media && (media.videoUrl || media.audioUrl)) {
            const btns = document.createElement('div');
            btns.className = 'dydl-btns';
            if (media.videoUrl) {
                const bv = mkBtn('视频(无声)', 'primary');
                bv.onclick = () =>
                    download(media.videoUrl, `抖音-${id}-video.mp4`);
                btns.appendChild(bv);
            }
            if (media.audioUrl) {
                const ba = mkBtn('音频', 'cyan');
                ba.onclick = () =>
                    download(media.audioUrl, `抖音-${id}-audio.m4a`);
                btns.appendChild(ba);
            }
            const note = document.createElement('div');
            note.className = 'dydl-hint';
            note.textContent =
                '以上是播放器实际拉流地址：视频轨无声音，音频轨完整。两个都要的话刷新后重进该视频即可拿到完整数据。';
            btns.appendChild(note);
            card.appendChild(btns);
        }
        return card;
    }

    /* ---- 分享链接精确解析 ---- */
    function resolveRedirect(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function')
                return reject(new Error('无 GM_xmlhttpRequest'));
            GM_xmlhttpRequest({
                url,
                method: 'GET',
                timeout: 15000,
                onload: (r) => resolve(r.finalUrl || url),
                onerror: () => reject(new Error('网络错误')),
                ontimeout: () => reject(new Error('超时'))
            });
        });
    }

    async function handlePaste(text) {
        const m = (text || '').match(/https?:\/\/[^\s"'，。,,]+/i);
        if (!m) return toast('没有在文本里找到链接', true);
        let url = m[0].replace(/[）。)】]+$/, '');
        toast('解析链接…');
        try {
            if (/v\.douyin\.com|iesdouyin\.com/.test(url)) {
                const finalUrl = await resolveRedirect(url);
                if (finalUrl) url = finalUrl;
            }
            const idm = url.match(/\/(?:video|note)\/(\d{15,25})/);
            if (!idm) return toast('链接里没有找到视频 id', true);
            const id = idm[1];
            const it = store.get(id);
            setCurrentId(id, 'url');
            if (it && (it.defaultUrl || it.qualities.length)) {
                toast('已定位到该视频');
            } else {
                toast('正在打开该视频页面获取数据…');
                setTimeout(() => {
                    location.href = 'https://www.douyin.com/video/' + id;
                }, 600);
            }
        } catch (e) {
            toast('解析失败：' + e.message, true);
        }
    }

    function mkBtn(text, cls) {
        const b = document.createElement('button');
        b.className = 'dydl-btn' + (cls ? ' ' + cls : '');
        b.textContent = text;
        return b;
    }

    /* ---- 拖拽（拖动后抑制点击） ---- */
    function makeDraggable(handle, target, onEnd) {
        const st = { down: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            st.down = true;
            st.moved = false;
            st.sx = e.clientX;
            st.sy = e.clientY;
            const rect = target.getBoundingClientRect();
            st.ox = rect.left;
            st.oy = rect.top;
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!st.down) return;
            if (
                !st.moved &&
                Math.abs(e.clientX - st.sx) + Math.abs(e.clientY - st.sy) < 5
            )
                return;
            st.moved = true;
            target.style.left =
                Math.max(
                    0,
                    Math.min(window.innerWidth - 40, st.ox + e.clientX - st.sx)
                ) + 'px';
            target.style.top =
                Math.max(
                    0,
                    Math.min(window.innerHeight - 40, st.oy + e.clientY - st.sy)
                ) + 'px';
            target.style.right = 'auto';
            target.style.bottom = 'auto';
        });
        window.addEventListener('mouseup', () => {
            if (!st.down) return;
            st.down = false;
            if (st.moved && onEnd && target.style.left) {
                onEnd({
                    left: parseInt(target.style.left),
                    top: parseInt(target.style.top)
                });
            }
            setTimeout(() => {
                st.moved = false;
            }, 80);
        });
        return () => st.moved;
    }

    function positionEl(el, pos, fallback) {
        if (pos && typeof pos.left === 'number') {
            el.style.left = pos.left + 'px';
            el.style.top = pos.top + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        } else {
            el.style.right = fallback.right + 'px';
            el.style.bottom = fallback.bottom + 'px';
        }
    }

    const LS_KEY = 'dydl_ui_state';
    function loadState() {
        try {
            return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }
    function saveState(patch) {
        try {
            localStorage.setItem(
                LS_KEY,
                JSON.stringify(Object.assign(loadState(), patch))
            );
        } catch (e) {
            /* 忽略 */
        }
    }

    let panel = null,
        ball = null,
        listBody = null;

    function buildUI() {
        if (
            document.getElementById('dydl-panel') ||
            document.getElementById('dydl-ball')
        )
            return;
        if (!document.body) return;

        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const st = loadState();

        panel = document.createElement('div');
        panel.id = 'dydl-panel';
        positionEl(panel, st.panelPos, { right: 20, bottom: 70 });
        panel.style.display = st.collapsed === 'panel' ? 'none' : '';

        const head = document.createElement('div');
        head.id = 'dydl-head';
        const title = document.createElement('div');
        title.className = 'dydl-title';
        title.textContent = '抖音下载器';
        const cnt = document.createElement('small');
        title.appendChild(cnt);
        const btnMin = mkIconBtn('—', () => {
            panel.style.display = 'none';
            ball.style.display = '';
            saveState({ collapsed: 'panel' });
        });
        head.append(title, btnMin);

        listBody = document.createElement('div');
        listBody.id = 'dydl-body';

        const inputRow = document.createElement('div');
        inputRow.id = 'dydl-inputrow';
        const inp = document.createElement('input');
        inp.className = 'dydl-input';
        inp.placeholder = '粘贴分享链接，回车精确下载';
        const goBtn = mkBtn('解析', 'cyan');
        const submit = () => {
            const v = inp.value.trim();
            if (v) {
                inp.value = '';
                handlePaste(v);
            }
        };
        goBtn.onclick = submit;
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
        });
        inputRow.append(inp, goBtn);
        panel.append(head, inputRow, listBody);
        document.body.appendChild(panel);
        makeDraggable(head, panel, (pos) => saveState({ panelPos: pos }));

        ball = document.createElement('div');
        ball.id = 'dydl-ball';
        const badge = document.createElement('span');
        ball.appendChild(badge);
        positionEl(ball, st.ballPos, { right: 20, bottom: 20 });
        ball.style.display = st.collapsed === 'panel' ? '' : 'none';
        document.body.appendChild(ball);
        const wasDrag = makeDraggable(ball, ball, (pos) =>
            saveState({ ballPos: pos })
        );
        ball.addEventListener('click', () => {
            if (wasDrag()) return;
            panel.style.display = '';
            ball.style.display = 'none';
            saveState({ collapsed: 'ball' });
            render();
        });

        document.addEventListener('click', (e) => {
            if (panel && !panel.contains(e.target)) {
                panel.querySelectorAll('.dydl-menu').forEach((m) => m.remove());
            }
        });

        render();
    }

    function mkIconBtn(text, onclick) {
        const b = document.createElement('button');
        b.className = 'dydl-icon-btn';
        b.textContent = text;
        b.onclick = onclick;
        return b;
    }

    function render() {
        if (!listBody) return;
        const ballEl = document.getElementById('dydl-ball');
        const currentItem = currentId ? store.get(currentId) : null;
        const currentKnown =
            currentItem &&
            (currentItem.defaultUrl ||
                currentItem.qualities.length ||
                currentItem.audioUrl);

        // 最近播放（不含当前），最多 2 条
        const recent = [...store.values()]
            .filter((it) => it.id !== currentId && it.playedTs > 0)
            .sort((a, b) => b.playedTs - a.playedTs)
            .slice(0, 2);

        if (ballEl)
            ballEl.firstChild.textContent =
                (currentId ? 1 : 0) + recent.length > 0
                    ? String((currentId ? 1 : 0) + recent.length)
                    : '↓';

        listBody.innerHTML = '';

        if (currentId) {
            const sec = document.createElement('div');
            sec.className = 'dydl-sec';
            sec.textContent = '当前视频';
            listBody.appendChild(sec);
            if (currentItem && currentKnown) {
                listBody.appendChild(buildCard(currentItem, true));
            } else {
                listBody.appendChild(buildPlaceholder(currentId));
            }
        }

        if (recent.length) {
            const sec = document.createElement('div');
            sec.className = 'dydl-sec';
            sec.textContent = '最近播放';
            listBody.appendChild(sec);
            for (const item of recent)
                listBody.appendChild(buildCard(item, false));
        }

        if (!currentId && !recent.length) {
            const empty = document.createElement('div');
            empty.className = 'dydl-empty';
            empty.textContent =
                '播放哪个视频，这里就显示哪个。\n也可以在上方粘贴分享链接，精确下载指定视频。';
            listBody.appendChild(empty);
        }
    }

    setInterval(buildUI, 1500);
    setInterval(() => {
        // 仅纯详情页路径才算「正在看」（搜索页 URL 是 /video/<旧id>/search/...，不能覆盖播放信号）
        const m = location.pathname.match(/^\/video\/(\d{15,25})\/?$/);
        if (m) setCurrentId(m[1], 'url');
    }, 1000);
    uiListeners.add(render);
})();
