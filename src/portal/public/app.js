"use strict";
(() => {
  // src/portal/ui/routes.ts
  function splitQuery(raw) {
    const q = raw.indexOf("?");
    if (q < 0) return { path: raw, query: "" };
    return { path: raw.slice(0, q), query: raw.slice(q + 1) };
  }
  function parseQuery(query) {
    const out = {};
    if (!query) return out;
    for (const [key, value] of new URLSearchParams(query)) out[key] = value;
    return out;
  }
  function parseHash(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    const { path, query } = splitQuery(raw);
    const q = parseQuery(query);
    if (path === "" || path === "/" || path === "/tasks") return { route: { view: "tasks" }, query: q };
    const task = /^\/tasks\/([^/]+)$/.exec(path);
    if (task) return { route: { view: "task-detail", id: decodeURIComponent(task[1]) }, query: q };
    if (path === "/approvals") return { route: { view: "approvals" }, query: q };
    const approval = /^\/approvals\/([^/]+)$/.exec(path);
    if (approval) return { route: { view: "approval-detail", id: decodeURIComponent(approval[1]) }, query: q };
    if (path === "/observe") return { route: { view: "observe" }, query: q };
    if (path === "/observe/capabilities") return { route: { view: "observe-capabilities" }, query: q };
    if (path === "/observe/evolution") return { route: { view: "observe-evolution" }, query: q };
    const evolution = /^\/observe\/evolution\/([^/]+)$/.exec(path);
    if (evolution) return { route: { view: "observe-evolution-detail", id: decodeURIComponent(evolution[1]) }, query: q };
    if (path === "/observe/evidence") return { route: { view: "observe-evidence" }, query: q };
    if (path === "/agents") return { route: { view: "agents" }, query: q };
    const agent = /^\/agents\/([^/]+)$/.exec(path);
    if (agent) return { route: { view: "agent-detail", id: decodeURIComponent(agent[1]) }, query: q };
    return { route: { view: "not-found", hash }, query: q };
  }
  function legacyRedirect(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    const { path, query } = splitQuery(raw);
    let target = null;
    if (path === "/capabilities") target = "/observe/capabilities";
    else if (path === "/evolution") target = "/observe/evolution";
    else if (path === "/evidence") target = "/observe/evidence";
    else {
      const evolution = /^\/evolution\/([^/]+)$/.exec(path);
      if (evolution) target = `/observe/evolution/${evolution[1]}`;
    }
    if (target === null) return null;
    return `#${target}${query ? `?${query}` : ""}`;
  }

  // src/portal/ui/nav.ts
  var OBSERVE_TABS = [
    { key: "overview", label: "总控", hash: "#/observe" },
    { key: "capabilities", label: "白泽·能力", hash: "#/observe/capabilities" },
    { key: "evolution", label: "女娲·演进", hash: "#/observe/evolution" },
    { key: "evidence", label: "夔牛·证据", hash: "#/observe/evidence" }
  ];
  function activeNavKey(view) {
    if (view === "tasks" || view === "task-detail") return "tasks";
    if (view === "approvals" || view === "approval-detail") return "approvals";
    if (view === "observe" || view === "observe-capabilities" || view === "observe-evolution" || view === "observe-evolution-detail" || view === "observe-evidence") return "observe";
    return null;
  }
  function activeObserveTabKey(view) {
    if (view === "observe") return "overview";
    if (view === "observe-capabilities") return "capabilities";
    if (view === "observe-evolution" || view === "observe-evolution-detail") return "evolution";
    if (view === "observe-evidence") return "evidence";
    return null;
  }
  var BEAST_HEADERS = {
    "tasks": { beast: "应龙", engineer: "任务工作台", tagline: "任务执行域：调度、运行与状态机", icon: "应" },
    "task-detail": { beast: "应龙", engineer: "任务工作台", tagline: "任务执行域：调度、运行与状态机", icon: "应" },
    "approvals": { beast: "玄武", engineer: "审批中心", tagline: "审批与发布守卫：风险分级与写前脱敏", icon: "玄" },
    "approval-detail": { beast: "玄武", engineer: "审批中心", tagline: "审批与发布守卫：风险分级与写前脱敏", icon: "玄" },
    "observe-capabilities": { beast: "白泽", engineer: "能力登记", tagline: "Capability Registry：能力画像与登记", icon: "白" },
    "observe-evolution": { beast: "女娲", engineer: "演进候选", tagline: "Evolution：演进候选清单（只读）", icon: "女" },
    "observe-evolution-detail": { beast: "女娲", engineer: "演进候选", tagline: "Evolution：演进候选清单（只读）", icon: "女" },
    "observe-evidence": { beast: "夔牛", engineer: "证据存证", tagline: "Evidence Store：证据存证与追溯", icon: "夔" }
  };
  function beastHeaderOf(view) {
    return BEAST_HEADERS[view] ?? null;
  }

  // src/portal/ui/token.ts
  var TOKEN_KEY = "shanhai-portal-token";
  function loadToken() {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  }
  function saveToken(value) {
    sessionStorage.setItem(TOKEN_KEY, value);
  }
  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
  }
  function consumeTokenFragment() {
    const m = /^#token=(.+)$/.exec(location.hash);
    if (!m) return null;
    saveToken(m[1]);
    history.replaceState(null, "", location.pathname + location.search);
    return m[1];
  }

  // src/portal/ui/connection.ts
  var CONNECTION_LABELS = {
    connected: "已连接",
    reconnecting: "重连中",
    disconnected: "已断开"
  };
  function initialConnection() {
    return { phase: "connected", failStreak: 0, firstFailureAt: null };
  }
  function outcomeFor(status) {
    if (status === "network-error") return "fail";
    if (status >= 500) return "fail";
    if (status === 401 || status === 403) return "ignored";
    return "ok";
  }
  function nextConnection(prev, outcome, now) {
    if (outcome === "ignored") return prev;
    if (outcome === "ok") return initialConnection();
    const failStreak = prev.failStreak + 1;
    const firstFailureAt = prev.firstFailureAt ?? now;
    return { phase: failStreak >= 2 ? "reconnecting" : prev.phase, failStreak, firstFailureAt };
  }
  function evaluateConnection(state, now) {
    if (state.phase === "reconnecting" && state.firstFailureAt !== null && now - state.firstFailureAt >= 3e4) {
      return { ...state, phase: "disconnected" };
    }
    return state;
  }

  // src/portal/ui/poll.ts
  function createPoller(opts) {
    let handle = null;
    let running = false;
    let visible = true;
    function schedule() {
      handle = opts.timerHost.set(run, opts.intervalMs);
    }
    async function run() {
      handle = null;
      if (!running || !visible) return;
      try {
        await opts.fn();
      } catch {
      }
      if (running && visible) schedule();
    }
    return {
      start() {
        if (running) return;
        running = true;
        if (visible) schedule();
      },
      stop() {
        running = false;
        if (handle !== null) {
          opts.timerHost.clear(handle);
          handle = null;
        }
      },
      onVisibility(visibleNext) {
        visible = visibleNext;
        if (!running) return;
        if (!visibleNext) {
          if (handle !== null) {
            opts.timerHost.clear(handle);
            handle = null;
          }
          return;
        }
        void run();
      }
    };
  }

  // src/portal/ui/components.ts
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }
  function emptyStateHtml(opts) {
    const action = opts.actionLabel ? `<button type="button" class="btn btn--primary">${esc(opts.actionLabel)}</button>` : "";
    const hint = opts.hint ? `<p class="empty-state__hint">${esc(opts.hint)}</p>` : "";
    return `<div class="empty-state"><div class="empty-state__icon" aria-hidden="true"></div><p class="empty-state__title">${esc(opts.title)}</p>${hint}${action}</div>`;
  }
  function cardHtml(opts) {
    const actions = opts.actionsHtml ? `<div class="card__actions">${opts.actionsHtml}</div>` : "";
    return `<section class="card"><header class="card__header"><h3 class="card__title">${esc(opts.title)}</h3>${actions}</header><div class="card__body">${opts.body}</div></section>`;
  }
  function pageHeaderHtml(opts) {
    const beast = beastHeaderOf(opts.view);
    const beastRow = beast ? `<div class="beast-row"><span class="beast-row__icon" aria-hidden="true">${esc(beast.icon)}</span><span class="beast-row__name">${esc(beast.beast)}·${esc(beast.engineer)}</span><span class="beast-row__tagline">${esc(beast.tagline)}</span></div>` : "";
    const actions = opts.actionsHtml ? `<div class="page-header__actions">${opts.actionsHtml}</div>` : "";
    return `<header class="page-header">${beastRow}<h2 class="page-header__title">${esc(opts.title)}</h2>${actions}</header>`;
  }

  // src/portal/ui/format.ts
  function shortId(id) {
    return id.slice(0, 8);
  }

  // src/portal/ui/pages.ts
  var BATCH_HINTS = {
    "tasks": "任务列表（统计卡/筛选/搜索/分页）由批次 7-2 交付",
    "task-detail": "任务详情（头部/时间线/事件流/证据区/关联区/操作区）由批次 7-2 交付",
    "approvals": "审批待办列表（重排/筛选/倒计时）由批次 7-2 交付",
    "approval-detail": "审批详情（影响范围/决议操作/参数摘要区）由批次 7-2 交付",
    "observe": "总控统计卡 + 合并时间线 + 快速入口由批次 7-3 交付",
    "observe-capabilities": "白泽·能力矩阵（Agent 选择器/筛选）由批次 7-3 交付",
    "observe-evolution": "女娲·演进候选列表（状态分组/详情侧栏，整页只读）由批次 7-3 交付",
    "observe-evolution-detail": "演进候选详情五区由批次 7-3 交付",
    "observe-evidence": "夔牛·证据按 ref 直查由批次 7-3 交付",
    "agents": "Agent 目录（前端去重聚合）由批次 7-4 交付",
    "agent-detail": "Agent 详情四读面（card/trend/insight/report）由批次 7-4 交付"
  };
  var PAGE_TITLES = {
    "tasks": "任务列表",
    "task-detail": "任务详情",
    "approvals": "待办审批",
    "approval-detail": "审批详情",
    "observe": "观测·总控",
    "observe-capabilities": "观测·白泽·能力",
    "observe-evolution": "观测·女娲·演进",
    "observe-evolution-detail": "观测·女娲·演进·详情",
    "observe-evidence": "观测·夔牛·证据",
    "agents": "Agent 目录",
    "agent-detail": "Agent 详情"
  };
  function detailTitle(view, id) {
    return `${PAGE_TITLES[view]}（${shortId(id)}）`;
  }
  function observeTabsHtml(view) {
    const active = activeObserveTabKey(view);
    const tabs = OBSERVE_TABS.map((t) => {
      const isActive = t.key === active;
      return `<a class="tab${isActive ? " active" : ""}" href="${t.hash}"${isActive ? ' aria-current="page"' : ""}>${esc(t.label)}</a>`;
    }).join("");
    return `<nav class="tabs" aria-label="观测二级导航">${tabs}</nav>`;
  }
  function placeholderPage(view, opts) {
    const title = opts?.id ? detailTitle(view, opts.id) : PAGE_TITLES[view];
    const body = cardHtml({
      title: "骨架预览",
      body: emptyStateHtml({ title: "建设中", hint: BATCH_HINTS[view] ?? "本页面内容由后续批次交付" })
    });
    return `${pageHeaderHtml({ view, title })}${body}`;
  }
  function renderContent(route, query) {
    switch (route.view) {
      case "tasks":
        return placeholderPage("tasks");
      case "task-detail":
        return placeholderPage("task-detail", { id: route.id });
      case "approvals":
        return placeholderPage("approvals");
      case "approval-detail":
        return placeholderPage("approval-detail", { id: route.id });
      case "observe":
        return `${observeTabsHtml("observe")}${placeholderPage("observe")}`;
      case "observe-capabilities":
        return `${observeTabsHtml("observe-capabilities")}${placeholderPage("observe-capabilities")}`;
      case "observe-evolution":
        return `${observeTabsHtml("observe-evolution")}${placeholderPage("observe-evolution")}`;
      case "observe-evolution-detail":
        return `${observeTabsHtml("observe-evolution-detail")}${placeholderPage("observe-evolution-detail", { id: route.id })}`;
      case "observe-evidence":
        return `${observeTabsHtml("observe-evidence")}${placeholderPage("observe-evidence")}`;
      case "agents":
        return placeholderPage("agents");
      case "agent-detail":
        return placeholderPage("agent-detail", { id: route.id });
      case "not-found":
        return `<div class="error-state" role="alert"><p class="error-state__message">未找到视图：${esc(route.hash)}</p><a class="btn btn--primary" href="#/tasks">返回首页</a></div>`;
    }
  }

  // src/portal/ui/main.ts
  var APP_VERSION = true ? "0.1.0" : "";
  var DEFAULT_TIMER_HOST = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle)
  };
  var PROBE_INTERVAL_MS = 1e4;
  function realDeps() {
    return {
      document: globalThis.document,
      window: globalThis,
      timerHost: DEFAULT_TIMER_HOST,
      fetchImpl: (input, init) => globalThis.fetch(input, init)
    };
  }
  function boot(opts = {}) {
    const doc = opts.document ?? globalThis.document;
    const win = opts.window ?? globalThis;
    const timerHost = opts.timerHost ?? DEFAULT_TIMER_HOST;
    const fetchImpl = opts.fetchImpl ?? realDeps().fetchImpl;
    const probeIntervalMs = opts.probeIntervalMs ?? PROBE_INTERVAL_MS;
    const view = doc.getElementById("view");
    const tokenStateEl = doc.getElementById("token-state");
    const connEl = doc.getElementById("connection-indicator");
    const versionEl = doc.getElementById("app-version");
    if (versionEl) versionEl.textContent = APP_VERSION;
    let conn = initialConnection();
    function refreshTokenState() {
      if (tokenStateEl) tokenStateEl.textContent = loadToken() ? "已设置" : "未设置";
    }
    function renderConnection() {
      if (!connEl) return;
      connEl.className = `conn conn--${conn.phase}`;
      connEl.textContent = CONNECTION_LABELS[conn.phase];
    }
    async function probe() {
      const token = loadToken();
      if (!token) {
        if (connEl) {
          connEl.className = "conn conn--unknown";
          connEl.textContent = "未认证（请设置 Token）";
        }
        return;
      }
      try {
        const res = await fetchImpl("/api/tasks?limit=1", { headers: { Authorization: `Bearer ${token}` } });
        conn = nextConnection(conn, outcomeFor(res.status), Date.now());
      } catch {
        conn = nextConnection(conn, "fail", Date.now());
      }
      conn = evaluateConnection(conn, Date.now());
      renderConnection();
    }
    const probePoller = createPoller({ intervalMs: probeIntervalMs, fn: probe, timerHost });
    function renderRoute() {
      const hash = location.hash;
      const redirect = legacyRedirect(hash);
      if (redirect) {
        location.replace(redirect);
        return;
      }
      if (!view) return;
      const { route, query } = parseHash(hash);
      view.innerHTML = renderContent(route, query);
      const navKey = activeNavKey(route.view);
      for (const link of doc.querySelectorAll("[data-nav]")) {
        const el = link;
        el.className = el.dataset.nav === navKey ? "nav-link active" : "nav-link";
      }
    }
    const tokenForm = doc.getElementById("token-form");
    tokenForm?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const input = doc.getElementById("token-input");
      const value = input ? input.value.trim() : "";
      if (value) saveToken(value);
      else clearToken();
      refreshTokenState();
      renderRoute();
      void probe();
    });
    connEl?.addEventListener("click", () => {
      void probe();
    });
    doc.addEventListener("visibilitychange", () => {
      probePoller.onVisibility(!doc.hidden);
    });
    win.addEventListener("hashchange", renderRoute);
    refreshTokenState();
    consumeTokenFragment();
    refreshTokenState();
    const tokenInput = doc.getElementById("token-input");
    if (tokenInput && loadToken()) tokenInput.value = loadToken();
    if (connEl) connEl.textContent = "检测中";
    renderRoute();
    probePoller.start();
  }
  if (typeof document !== "undefined") boot(realDeps());
})();
