// ==UserScript==
// @name         X 列表成员增强：从关注列表一键添加
// @namespace    jie-x-list-following-picker
// @version      0.2.0
// @description  在 X (x.com) 列表成员管理页注入面板：直接展示我关注的人，点一下加入列表，告别逐个搜索。添加成功以「列表成员数实际 +1」为准，X 服务端没生效会明确报错而不是假成功。
// @author       Jie
// @match        https://x.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ---------- 配置 ----------
  const PUBLIC_BEARER =
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const FEATURES = {
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  };
  const MAX_FOLLOWING = 1000; // 关注列表抓取上限（防失控）
  const MAX_KNOWN_MEMBERS = 250; // 「已在列表」标记最多拉取的现有成员数
  const ADD_GAP_MS = 250; // 两次添加的最小间隔

  // ---------- 状态 ----------
  let opMap = null; // operationName -> queryId
  let panel = null;
  let launcher = null;
  let currentListId = null;
  let listInfo = null; // {name, memberCount}
  let followingUsers = []; // {id, name, screen, avatar}
  let memberIds = new Set();
  let addQueue = Promise.resolve();
  let lastAddAt = 0;

  // ---------- 基础工具 ----------
  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function scanOps() {
    const chunkKey = Object.keys(window).find((k) => k.startsWith("webpackChunk"));
    if (!chunkKey) return {};
    const ops = {};
    for (const entry of window[chunkKey]) {
      const modules = entry && entry[1];
      if (!modules) continue;
      for (const mid in modules) {
        let src = "";
        try {
          src = modules[mid].toString();
        } catch (e) {
          continue;
        }
        if (!src.includes("operationName")) continue;
        for (const m of src.matchAll(/queryId:"([^"]+)",operationName:"([A-Za-z0-9_]+)"/g)) {
          ops[m[2]] = m[1];
        }
        for (const m of src.matchAll(/operationName:"([A-Za-z0-9_]+)",queryId:"([^"]+)"/g)) {
          ops[m[1]] = m[2];
        }
      }
    }
    return ops;
  }

  function getOp(name) {
    if (!opMap) opMap = scanOps();
    if (!opMap[name]) opMap = scanOps(); // 分包懒加载，重扫一次
    if (!opMap[name]) throw new Error(`接口 ${name} 的模块还没加载，请先打开一次列表成员管理页`);
    return opMap[name];
  }

  function myId() {
    const raw = getCookie("twid"); // 形如 u%3D123...
    const m = raw && raw.match(/u=(\d+)/);
    if (!m) throw new Error("拿不到你的用户 ID（twid），请确认已登录 x.com");
    return m[1];
  }

  async function xFetch(opName, { variables, features } = {}) {
    const qid = getOp(opName);
    let url, init;
    if (opName === "ListAddMember" || opName === "ListRemoveMember") {
      url = `/i/api/graphql/${qid}/${opName}`;
      init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queryId: qid, variables }),
      };
    } else {
      const p = new URLSearchParams();
      p.set("variables", JSON.stringify(variables));
      if (features) p.set("features", JSON.stringify(features));
      url = `/i/api/graphql/${qid}/${opName}?` + p.toString();
      init = { method: "GET" };
    }
    init.credentials = "include";
    init.headers = {
      ...(init.headers || {}),
      authorization: PUBLIC_BEARER,
      "x-csrf-token": getCookie("ct0") || "",
    };
    const r = await fetch(url, init);
    if (r.status === 429) throw new Error("触发 X 频率限制，等几分钟再操作");
    const j = await r.json().catch(() => null);
    // X 的 GraphQL 响应常附带 DecodeException 噪音（操作实际成功），成败交给调用方按效果判定
    if (!j || (!j.data && j.errors && j.errors.length)) {
      throw new Error(j ? j.errors.map((e) => e.message).join("; ") : `接口 ${opName} 返回非 JSON`);
    }
    return j;
  }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // ---------- 数据抓取 ----------
  function extractUsers(entries) {
    const users = [];
    let cursor = null;
    for (const e of entries || []) {
      if (e.entryId && e.entryId.startsWith("cursor-bottom-")) {
        cursor = e.content && e.content.value;
        continue;
      }
      if (!e.entryId || !e.entryId.startsWith("user-")) continue;
      const u = e.content && e.content.itemContent && e.content.itemContent.user_results
        && e.content.itemContent.user_results.result;
      if (!u || !u.rest_id) continue;
      users.push({
        id: u.rest_id,
        name: (u.core && u.core.name) || (u.legacy && u.legacy.name) || "",
        screen: (u.core && u.core.screen_name) || (u.legacy && u.legacy.screen_name) || "",
        avatar: (u.avatar && u.avatar.image_url)
          || (u.legacy && u.legacy.profile_image_url_https) || "",
      });
    }
    return { users, cursor };
  }

  function timelineEntries(j, rootPath) {
    let node = j && j.data;
    for (const k of rootPath) node = node && node[k];
    // rootPath 已走到 timeline.timeline / members_timeline.timeline，instructions 就在其上
    const instructions = (node && node.instructions) || [];
    const found = instructions.find((i) => i.type === "TimelineAddEntries");
    return (found && found.entries) || [];
  }

  async function loadFollowing(onPage) {
    const uid = myId();
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 40 && seen.size < MAX_FOLLOWING; page++) {
      const variables = { userId: uid, count: 100, includePromotedContent: false };
      if (cursor) variables.cursor = cursor;
      const j = await xFetch("Following", { variables, features: FEATURES });
      const { users, cursor: c } = extractUsers(timelineEntries(j, ["user", "result", "timeline", "timeline"]));
      for (const u of users) if (!seen.has(u.id)) { seen.add(u.id); followingUsers.push(u); }
      if (onPage) onPage();
      if (!c || users.length === 0) break;
      cursor = c;
    }
  }

  async function loadListMembers(listId) {
    let cursor;
    for (let page = 0; page < 5 && memberIds.size < MAX_KNOWN_MEMBERS; page++) {
      const variables = { listId, count: 50 };
      if (cursor) variables.cursor = cursor;
      const j = await xFetch("ListMembers", { variables, features: FEATURES });
      const { users, cursor: c } = extractUsers(timelineEntries(j, ["list", "members_timeline", "timeline"]));
      for (const u of users) memberIds.add(u.id);
      if (!c || users.length === 0) break;
      cursor = c;
    }
  }

  async function getListInfo(listId) {
    const j = await xFetch("ListByRestId", { variables: { listId }, features: FEATURES });
    const list = j && j.data && j.data.list;
    if (!list || typeof list.member_count !== "number") {
      throw new Error("ListByRestId 响应异常");
    }
    return { name: list.name || "", memberCount: list.member_count };
  }

  // 添加一个成员；以「列表成员数实际 +1」为成功标准，服务端没生效会抛错
  async function addMember(user) {
    // 节流：两次添加间隔不小于 ADD_GAP_MS
    const wait = lastAddAt + ADD_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAddAt = Date.now();

    const preCount = listInfo ? listInfo.memberCount : null;
    const j = await xFetch("ListAddMember", { variables: { listId: currentListId, userId: user.id } });

    // 快路径：本次响应自带的成员数已 +1
    let postCount = j && j.data && j.data.list && j.data.list.member_count;
    if (preCount != null && postCount === preCount + 1) {
      listInfo = { ...listInfo, memberCount: postCount };
      memberIds.add(user.id);
      return;
    }

    // 慢路径：响应没给出可信增量，独立查一次列表信息；仍没生效则再等一次（容忍 X 的一致性延迟）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const info = await getListInfo(currentListId);
        if (preCount == null || info.memberCount > preCount) {
          listInfo = info;
          memberIds.add(user.id);
          return;
        }
        listInfo = info;
      } catch (e) { /* 查询失败不掩盖添加结果，继续重试 */ }
      if (attempt === 0) await sleep(900);
    }
    throw new Error("X 服务端没有实际生效（成员数未增加），已回退，请稍后重试");
  }

  // ---------- UI ----------
  const CSS = `
  #xlp-launcher{position:fixed;right:20px;bottom:240px;z-index:99998;background:#1d9bf0;color:#fff;
    border:none;border-radius:9999px;padding:10px 16px;font-size:14px;font-weight:700;cursor:pointer;
    box-shadow:0 4px 12px rgba(0,0,0,.4);font-family:inherit}
  #xlp-launcher:hover{background:#1a8cd8}
  #xlp-panel{position:fixed;right:20px;bottom:60px;z-index:99999;width:400px;max-width:calc(100vw - 40px);
    height:72vh;background:#15202b;color:#e7e9ea;border-radius:16px;border:1px solid #38444d;
    box-shadow:0 8px 30px rgba(0,0,0,.6);display:flex;flex-direction:column;font-family:inherit}
  #xlp-panel header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;
    border-bottom:1px solid #38444d;font-weight:700;font-size:15px;gap:8px}
  #xlp-listname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #xlp-close{background:none;border:none;color:#71767b;font-size:20px;cursor:pointer;padding:0 4px;flex:none}
  #xlp-close:hover{color:#fff}
  #xlp-status{padding:8px 16px;font-size:12px;color:#71767b;border-bottom:1px solid #38444d;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis}
  #xlp-filter{margin:8px 16px;padding:8px 12px;background:#202e3a;border:1px solid #38444d;border-radius:8px;
    color:#e7e9ea;font-size:14px;outline:none}
  #xlp-filter:focus{border-color:#1d9bf0}
  #xlp-list{flex:1;overflow-y:auto;padding:4px 0}
  .xlp-row{display:flex;align-items:center;gap:10px;padding:8px 16px}
  .xlp-row:hover{background:#1e2732}
  .xlp-row.xlp-done{opacity:.55}
  .xlp-av{width:36px;height:36px;border-radius:50%;flex:none;background:#38444d}
  .xlp-info{flex:1;min-width:0}
  .xlp-name{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .xlp-screen{font-size:12px;color:#71767b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .xlp-add{flex:none;background:#1d9bf0;color:#fff;border:none;border-radius:9999px;padding:6px 14px;
    font-size:13px;font-weight:700;cursor:pointer}
  .xlp-add:hover{background:#1a8cd8}
  .xlp-add:disabled{background:#38444d;color:#71767b;cursor:default}
  .xlp-add.xlp-added{background:#00ba7c}
  .xlp-empty{padding:24px 16px;text-align:center;color:#71767b;font-size:13px}
  #xlp-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:100000;
    background:#f4212e;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;display:none;
    max-width:80vw}
  `;

  function toast(msg) {
    let t = document.getElementById("xlp-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "xlp-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.display = "none"; }, 3500);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function updateStatus(extra) {
    const s = document.getElementById("xlp-status");
    if (!s) return;
    const done = followingUsers.filter((u) => memberIds.has(u.id)).length;
    const listPart = listInfo ? ` · ${listInfo.name} ${listInfo.memberCount} 人` : "";
    s.textContent = `已加载 ${followingUsers.length} 个关注 · 其中 ${done} 人已在列表${listPart}`
      + (extra ? " · " + extra : "");
  }

  // 点击串行化：所有添加排队执行，避免并发下计数验证互相干扰
  function queueAdd(user, btn, row) {
    btn.disabled = true;
    btn.textContent = "添加中…";
    addQueue = addQueue.then(async () => {
      try {
        await addMember(user);
        btn.textContent = "✓ 已加";
        btn.classList.add("xlp-added");
        row.classList.add("xlp-done");
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "添加";
        toast("添加失败：" + err.message);
      }
      updateStatus();
    });
  }

  function renderRows() {
    const listEl = document.getElementById("xlp-list");
    if (!listEl) return;
    const kwEl = document.getElementById("xlp-filter");
    const kw = (kwEl && kwEl.value.trim().toLowerCase()) || "";
    listEl.textContent = "";
    const shown = followingUsers.filter(
      (u) => !kw || u.name.toLowerCase().includes(kw) || u.screen.toLowerCase().includes(kw)
    );
    if (!shown.length) {
      listEl.appendChild(el("div", "xlp-empty", kw ? "没有匹配的人" : "加载中…"));
      return;
    }
    for (const u of shown) {
      const row = el("div", "xlp-row" + (memberIds.has(u.id) ? " xlp-done" : ""));
      const av = el("img", "xlp-av");
      if (u.avatar) av.src = u.avatar;
      row.appendChild(av);
      const info = el("div", "xlp-info");
      info.appendChild(el("div", "xlp-name", u.name));
      info.appendChild(el("div", "xlp-screen", "@" + u.screen));
      row.appendChild(info);
      const inList = memberIds.has(u.id);
      const btn = el("button", "xlp-add" + (inList ? " xlp-added" : ""), inList ? "已在列表" : "添加");
      if (inList) btn.disabled = true;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!btn.disabled) queueAdd(u, btn, row);
      });
      row.appendChild(btn);
      row.addEventListener("click", () => window.open("/" + u.screen, "_blank"));
      listEl.appendChild(row);
    }
  }

  function openPanel(listId) {
    if (panel) { panel.remove(); panel = null; }
    currentListId = listId;
    listInfo = null;
    panel = el("div");
    panel.id = "xlp-panel";
    const header = el("header");
    const title = el("span");
    title.id = "xlp-listname";
    title.textContent = "我的关注 → 加入列表";
    header.appendChild(title);
    const closeBtn = el("button", null, "×");
    closeBtn.id = "xlp-close";
    closeBtn.addEventListener("click", () => { panel.remove(); panel = null; });
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const status = el("div");
    status.id = "xlp-status";
    status.textContent = "正在准备…";
    panel.appendChild(status);
    const filter = document.createElement("input");
    filter.id = "xlp-filter";
    filter.placeholder = "筛选名字 / @handle（本地过滤，不走搜索）";
    filter.addEventListener("input", renderRows);
    panel.appendChild(filter);
    const listEl = el("div");
    listEl.id = "xlp-list";
    listEl.appendChild(el("div", "xlp-empty", "加载中…"));
    panel.appendChild(listEl);
    document.body.appendChild(panel);

    (async () => {
      try {
        getOp("Following"); // 提前检查模块可用性
        followingUsers = []; // 重开面板时避免重复累加
        memberIds = new Set();
        // 列表基线信息（名称 + 成员数），添加后靠它核实效果
        getListInfo(listId).then((info) => {
          listInfo = info;
          title.textContent = `我的关注 → ${info.name}`;
          updateStatus();
        }).catch(() => {});
        await loadListMembers(listId);
        updateStatus("正在拉取关注列表…");
        await loadFollowing(() => { updateStatus(); renderRows(); });
        updateStatus();
        renderRows();
      } catch (err) {
        const listEl2 = document.getElementById("xlp-list");
        if (listEl2) {
          listEl2.textContent = "";
          listEl2.appendChild(el("div", "xlp-empty", "出错了：" + err.message));
        }
      }
    })();
  }

  function ensureLauncher(listId) {
    if (!launcher) {
      const style = document.createElement("style");
      style.textContent = CSS;
      document.head.appendChild(style);
      launcher = el("button", null, "＋从我的关注添加");
      launcher.id = "xlp-launcher";
      document.body.appendChild(launcher);
    }
    launcher.style.display = "block";
    // onclick 是单值属性：重复赋值只保留一个触发路径，避免面板并发打开
    launcher.onclick = () => openPanel(listId);
  }

  function hideLauncher() {
    if (launcher) launcher.style.display = "none";
    if (panel) { panel.remove(); panel = null; }
  }

  // SPA 路由监听：只在 /i/lists/<id>/members 显示入口
  setInterval(() => {
    const m = location.pathname.match(/\/i\/lists\/(\d+)\/members/);
    if (m) ensureLauncher(m[1]);
    else hideLauncher();
  }, 800);
})();
