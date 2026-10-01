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
  var STATUS_LABELS = {
    created: "已创建",
    queued: "排队中",
    running: "运行中",
    paused: "已暂停",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消"
  };
  function statusBadgeHtml(status) {
    const label = STATUS_LABELS[status] ?? status;
    return `<span class="badge badge--status-${esc(status)}"><span class="badge__dot"></span>${esc(label)}</span>`;
  }
  function riskBadgeHtml(level) {
    const high = level === "L3" || level === "L4";
    return `<span class="badge badge--risk${high ? " badge--danger" : ""}">${esc(level)}</span>`;
  }
  function buttonHtml(label, kind = "secondary", extra = "") {
    return `<button type="button" class="btn btn--${kind}"${extra ? ` ${extra}` : ""}>${esc(label)}</button>`;
  }
  function emptyStateHtml(opts) {
    const action = opts.actionLabel ? `<button type="button" class="btn btn--primary"${opts.actionAttrs ? ` ${opts.actionAttrs}` : ""}>${esc(opts.actionLabel)}</button>` : "";
    const hint = opts.hint ? `<p class="empty-state__hint">${esc(opts.hint)}</p>` : "";
    return `<div class="empty-state"><div class="empty-state__icon" aria-hidden="true"></div><p class="empty-state__title">${esc(opts.title)}</p>${hint}${action}</div>`;
  }
  function loadingStateHtml() {
    return '<div class="loading-state" role="status">加载中……</div>';
  }
  function cardHtml(opts) {
    const actions = opts.actionsHtml ? `<div class="card__actions">${opts.actionsHtml}</div>` : "";
    return `<section class="card"><header class="card__header"><h3 class="card__title">${esc(opts.title)}</h3>${actions}</header><div class="card__body">${opts.body}</div></section>`;
  }
  function tableHtml(opts) {
    const head = opts.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join("");
    return `<div class="table-wrap"><table class="table">${opts.caption ? `<caption>${esc(opts.caption)}</caption>` : ""}<thead><tr>${head}</tr></thead><tbody>${opts.rowsHtml}</tbody></table></div>`;
  }
  function toastHtml(message, type = "info") {
    return `<div class="toast toast--${type}" role="${type === "error" ? "alert" : "status"}">${esc(message)}</div>`;
  }
  function pageHeaderHtml(opts) {
    const beast = beastHeaderOf(opts.view);
    const beastRow = beast ? `<div class="beast-row"><span class="beast-row__icon" aria-hidden="true">${esc(beast.icon)}</span><span class="beast-row__name">${esc(beast.beast)}·${esc(beast.engineer)}</span><span class="beast-row__tagline">${esc(beast.tagline)}</span></div>` : "";
    const actions = opts.actionsHtml ? `<div class="page-header__actions">${opts.actionsHtml}</div>` : "";
    return `<header class="page-header">${beastRow}<h2 class="page-header__title">${esc(opts.title)}</h2>${actions}</header>`;
  }

  // src/portal/ui/format.ts
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function formatTimestamp(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function relativeTime(iso, now) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "—";
    const diff = Math.max(0, now - t);
    const seconds = Math.floor(diff / 1e3);
    if (seconds < 10) return "刚刚";
    if (seconds < 60) return `${seconds} 秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86400)} 天前`;
  }
  function shortId(id) {
    return id.slice(0, 8);
  }
  function formatThousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // src/portal/ui/pages.ts
  var BATCH_HINTS = {
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
  function loadingPage(view, opts) {
    const title = opts?.id ? detailTitle(view, opts.id) : PAGE_TITLES[view];
    return `${pageHeaderHtml({ view, title })}${loadingStateHtml()}`;
  }
  function renderContent(route, query) {
    switch (route.view) {
      case "tasks":
        return loadingPage("tasks");
      case "task-detail":
        return loadingPage("task-detail", { id: route.id });
      case "approvals":
        return loadingPage("approvals");
      case "approval-detail":
        return loadingPage("approval-detail", { id: route.id });
      case "observe":
        return `${observeTabsHtml("observe")}${loadingPage("observe")}`;
      case "observe-capabilities":
        return `${observeTabsHtml("observe-capabilities")}${loadingPage("observe-capabilities")}`;
      case "observe-evolution":
        return `${observeTabsHtml("observe-evolution")}${loadingPage("observe-evolution")}`;
      case "observe-evolution-detail":
        return `${observeTabsHtml("observe-evolution-detail")}${loadingPage("observe-evolution-detail", { id: route.id })}`;
      case "observe-evidence":
        return `${observeTabsHtml("observe-evidence")}${loadingPage("observe-evidence")}`;
      case "agents":
        return placeholderPage("agents");
      case "agent-detail":
        return placeholderPage("agent-detail", { id: route.id });
      case "not-found":
        return `<div class="error-state" role="alert"><p class="error-state__message">未找到视图：${esc(route.hash)}</p><a class="btn btn--primary" href="#/tasks">返回首页</a></div>`;
    }
  }

  // src/portal/ui/client.ts
  function headers(deps, extra) {
    const h = { ...extra };
    const token = deps.token();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }
  async function toResult(res) {
    if (!res.ok) {
      let body = {};
      try {
        body = await res.json();
      } catch {
      }
      return {
        ok: false,
        kind: "http",
        status: res.status,
        code: typeof body.code === "string" ? body.code : "unknown",
        message: typeof body.message === "string" ? body.message : `HTTP ${res.status}`
      };
    }
    try {
      return { ok: true, data: await res.json() };
    } catch {
      return { ok: false, kind: "network" };
    }
  }
  async function apiGet(path, deps) {
    try {
      const res = await deps.fetchImpl(path, { headers: headers(deps) });
      return await toResult(res);
    } catch {
      return { ok: false, kind: "network" };
    }
  }
  async function apiPost(path, body, deps) {
    try {
      const res = await deps.fetchImpl(path, {
        method: "POST",
        headers: headers(deps, { "Content-Type": "application/json" }),
        body: JSON.stringify(body)
      });
      return await toResult(res);
    } catch {
      return { ok: false, kind: "network" };
    }
  }

  // src/portal/ui/errors.ts
  var UI_ERROR_TEXT = {
    // server.ts 错误面
    unauthorized: "Token 无效或已过期，请更新门户 Token 后重试",
    host_forbidden: "仅供本机访问",
    unsupported_media_type: "不应出现的 415（unsupported_media_type）——前端只用 GET/POST + JSON，出现即前端缺陷，已如实展示",
    method_not_allowed: "不应出现的 405（method_not_allowed）——前端只用 GET/POST，出现即前端缺陷，已如实展示",
    // api.ts 参数校验
    bad_request: "请求参数无效",
    invalid_task_id: "请求参数无效（taskId 白名单违规）",
    invalid_ref: "证据 ref 格式非法",
    invalid_bound: "趋势时间参数非法（invalid_bound）",
    invalid_bucket: "趋势 bucket 参数非法（invalid_bucket）",
    // errormap 结构化码
    not_found: "对象不存在（可能已终局），刷新查看",
    already_decided: "该审批已决议（approve/deny 竞态后到方），刷新查看",
    task_not_paused: "任务当前状态不可续跑（已续跑或已终局）",
    version_mismatch: "审批绑定版本与任务当前版本不一致，刷新核对",
    timeout_applied: "请求已被惰性超时终局（denied + 任务终局），刷新查看",
    cross_process_graceful_unsupported: "跨进程任务不支持优雅取消——请改用强制中止（force）",
    not_implemented: "该能力为预留位，暂未实现（not_implemented）"
  };
  var NETWORK_ERROR_TEXT = "连接断开，操作结果未知——刷新核对后重试";
  function explainFailure(failure) {
    if (failure.kind === "network") return NETWORK_ERROR_TEXT;
    const known = UI_ERROR_TEXT[failure.code];
    if (known) return known;
    return `${failure.code}：${failure.message}`;
  }

  // src/portal/ui/pageCtx.ts
  function ds(dataset, kebab) {
    const camel = kebab.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    return dataset[kebab] ?? dataset[camel] ?? "";
  }

  // src/portal/ui/taskFilters.ts
  var SERVER_STATUSES = ["queued", "running", "paused", "succeeded", "failed", "cancelled"];
  var SEVEN_STATUSES = ["created", ...SERVER_STATUSES];
  var RANGE_OPTIONS = [
    { key: "today", label: "今天" },
    { key: "7d", label: "近 7 天" },
    { key: "30d", label: "近 30 天" },
    { key: "all", label: "全部" }
  ];
  var DEFAULT_RANGE = "7d";
  var RUNNING_STALE_MS = 10 * 6e4;
  function parseTaskFilters(query) {
    const status = query.status ?? "";
    const range = query.range ?? DEFAULT_RANGE;
    return {
      status: SEVEN_STATUSES.includes(status) ? status : null,
      agent: query.agent && query.agent.length > 0 ? query.agent : null,
      range: RANGE_OPTIONS.some((o) => o.key === range) ? range : DEFAULT_RANGE
    };
  }
  function taskFiltersQuery(f) {
    const parts = [];
    if (f.status !== null) parts.push(`status=${encodeURIComponent(f.status)}`);
    if (f.agent !== null) parts.push(`agent=${encodeURIComponent(f.agent)}`);
    if (f.range !== DEFAULT_RANGE) parts.push(`range=${f.range}`);
    return parts.join("&");
  }
  function rangeStartMs(range, now) {
    if (range === "all") return null;
    if (range === "today") {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    return now - (range === "7d" ? 7 : 30) * 864e5;
  }
  function localTaskPass(row, filters, searchPrefix, now) {
    if (filters.status !== null && row.status !== filters.status) return false;
    const start = rangeStartMs(filters.range, now);
    if (start !== null) {
      const t = Date.parse(row.createdAt);
      if (!Number.isNaN(t) && t < start) return false;
    }
    if (searchPrefix && !row.taskId.startsWith(searchPrefix)) return false;
    return true;
  }
  function isRunningStale(row, now) {
    if (row.status !== "running" || row.endedAt !== null) return false;
    const t = Date.parse(row.createdAt);
    if (Number.isNaN(t)) return false;
    return now - t > RUNNING_STALE_MS;
  }
  function countByStatus(rows) {
    const counts = { created: 0, queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const r of rows) {
      if (SEVEN_STATUSES.includes(r.status)) counts[r.status] += 1;
    }
    return counts;
  }

  // src/portal/ui/tasksView.ts
  function feedbackHtml(feedback) {
    if (!feedback) return "";
    const resume = feedback.resume ? `<div class="feedback__resume"><p class="feedback__note">${esc(feedback.resume.note)}</p><pre class="code-block"><code>${esc(feedback.resume.cli)}</code></pre><button type="button" class="btn btn--ghost btn--sm" data-action="view-resume-log" data-task-id="${esc(feedback.resume.taskId)}" data-log-url="${esc(feedback.resume.logUrl)}">查看续跑日志</button><span class="hint mono">${esc(feedback.resume.logUrl)}</span><div class="resume-log"${feedback.resume.logText ? "" : " hidden"}>${feedback.resume.logText ? esc(feedback.resume.logText) : ""}</div></div>` : "";
    return `<div class="feedback feedback--${feedback.kind}" role="${feedback.kind === "error" ? "alert" : "status"}"><p class="feedback__text">${esc(feedback.text)}</p>${resume}</div>`;
  }
  function statCardsHtml(counts, total, activeStatus) {
    const cards = ["created", "queued", "running", "paused", "succeeded", "failed", "cancelled"].map((status) => {
      const isActive = activeStatus === status;
      const tip = status === "created" ? ' title="created 不支持服务端筛选（api.ts 白名单六枚举）——点击为前端本地过滤"' : ` title="点击筛选 ${STATUS_LABELS[status]} 任务"`;
      return `<button type="button" class="stat-card${isActive ? " stat-card--active" : ""}${counts[status] === 0 ? " stat-card--zero" : ""}" data-action="stat" data-status="${status}"${tip}><span class="stat-card__value">${counts[status]}</span><span class="stat-card__label">${esc(STATUS_LABELS[status])}</span></button>`;
    }).join("");
    const totalCard = `<div class="stat-card stat-card--total"><span class="stat-card__value">${total}</span><span class="stat-card__label">合计</span></div>`;
    return `<div class="stat-grid" aria-label="任务状态统计（基于最近 100 条聚合）">${cards}${totalCard}</div>`;
  }
  function filterBarHtml(filters, agentOptions, search) {
    const statusOptions = [
      '<option value="">全部状态</option>',
      ...SERVER_STATUSES.map((s) => `<option value="${s}"${filters.status === s ? " selected" : ""}>${esc(STATUS_LABELS[s])}</option>`),
      `<option value="created"${filters.status === "created" ? " selected" : ""}>${esc(STATUS_LABELS.created)}（本地过滤）</option>`
    ].join("");
    const agentOpts = [
      '<option value="">全部 Agent</option>',
      ...agentOptions.map((a) => `<option value="${esc(a)}"${filters.agent === a ? " selected" : ""}>${esc(a)}</option>`)
    ].join("");
    const rangeOpts = RANGE_OPTIONS.map((o) => `<option value="${o.key}"${filters.range === o.key ? " selected" : ""}>${esc(o.label)}</option>`).join("");
    return `<div class="filter-bar">
    <label class="filter">状态<select data-filter="status">${statusOptions}</select></label>
    <label class="filter">Agent<select data-filter="agent">${agentOpts}</select></label>
    <label class="filter">时间范围<select data-filter="range">${rangeOpts}</select></label>
    <input class="filter__search" data-filter="search" type="search" placeholder="按任务 ID 前缀搜索" value="${esc(search)}" />
    <span class="hint">时间范围为前端过滤（服务端无时间参数）</span>
  </div>`;
  }
  function rowActionsHtml(row, stale) {
    const detail = `<a class="btn btn--ghost btn--sm" href="#/tasks/${encodeURIComponent(row.taskId)}">详情</a>`;
    if (stale) {
      return `${detail}<button type="button" class="btn btn--danger btn--sm" data-action="crash-recovery">显式崩溃恢复</button>`;
    }
    const cancel = ["queued", "running", "paused"].includes(row.status) ? `<button type="button" class="btn btn--secondary btn--sm" data-action="cancel" data-task-id="${esc(row.taskId)}" data-task-status="${esc(row.status)}">取消</button>` : "";
    const resume = row.status === "paused" ? `<button type="button" class="btn btn--primary btn--sm" data-action="resume" data-task-id="${esc(row.taskId)}">续跑</button>` : "";
    return `${detail}${cancel}${resume}`;
  }
  function staleMarkHtml() {
    return '<span class="stale-mark" title="该任务运行时间异常，可能是孤儿运行" aria-label="运行时间异常警告">⚠</span>';
  }
  function tasksPageHtml(m) {
    const header = pageHeaderHtml({ view: "tasks", title: "任务列表" });
    const stats = statCardsHtml(m.stats, m.total, m.filters.status);
    const filters = filterBarHtml(m.filters, m.agentOptions, m.search);
    let body;
    if (m.rows.length === 0) {
      const hasFilter = m.filters.status !== null || m.filters.agent !== null || m.filters.range !== "all" || m.search.length > 0;
      body = cardHtml({
        title: "任务列表",
        body: emptyStateHtml({
          title: "当前筛选无任务",
          hint: hasFilter ? "调整或清除筛选条件后再试" : "尚无任务记录",
          actionLabel: hasFilter ? "清除筛选" : void 0,
          actionAttrs: hasFilter ? 'data-action="clear-filters"' : void 0
        })
      });
    } else {
      const rowsHtml = m.rows.map((row) => {
        const stale = m.runningStaleIds.includes(row.taskId);
        return `<tr>
        <td><a class="mono" href="#/tasks/${encodeURIComponent(row.taskId)}" title="${esc(row.taskId)}">${esc(shortId(row.taskId))}</a></td>
        <td>${esc(row.agentId)}</td>
        <td>${statusBadgeHtml(row.status)}${stale ? staleMarkHtml() : ""}</td>
        <td>${row.attemptCount}</td>
        <td>${row.modelCallCount}</td>
        <td>${formatThousands(row.tokensUsed)}</td>
        <td>${esc(formatTimestamp(row.createdAt))}</td>
        <td class="row-actions">${rowActionsHtml(row, stale)}</td>
      </tr>`;
      }).join("");
      body = cardHtml({
        title: `任务列表（第 ${m.page + 1} 页 / 共 ${m.total} 条）`,
        body: tableHtml({
          columns: ["任务", "Agent", "状态", "尝试", "模型调用", "Token", "创建时间", "操作"],
          rowsHtml
        }),
        actionsHtml: pagerHtml(m.page, m.pageCount)
      });
    }
    const notice = m.runningStaleIds.length > 0 ? `<p class="warning">检测到 ${m.runningStaleIds.length} 个滞留运行任务——若确认其执行进程已不存在，可执行显式崩溃恢复（全局操作，将把所有 Running 任务标记为 Failed(CrashRecovery)）。</p>` : "";
    return `${header}${feedbackHtml(m.feedback)}${stats}${filters}${notice}${body}`;
  }
  function pagerHtml(page, pageCount) {
    if (pageCount <= 1) return "";
    return `<div class="pager">
    <button type="button" class="btn btn--secondary btn--sm" data-action="page-prev"${page <= 0 ? " disabled" : ""}>上一页</button>
    <span class="pager__label">第 ${page + 1} / ${pageCount} 页</span>
    <button type="button" class="btn btn--secondary btn--sm" data-action="page-next"${page >= pageCount - 1 ? " disabled" : ""}>下一页</button>
  </div>`;
  }

  // src/portal/view/write.ts
  function cancelModeFor(taskStatus) {
    if (taskStatus === "running") {
      return {
        gracefulDisabled: true,
        defaultMode: "force",
        hint: "该任务运行于独立进程，仅支持强制中止（下一个原子调用边界生效，模型调用不打断；graceful 仅执行进程内可见）"
      };
    }
    return { gracefulDisabled: false, defaultMode: "graceful", hint: "queued/paused 立即取消（既有 CAS 语义）；paused 取消将连带 pending 审批作废" };
  }
  function confirmCrashRecoveryText(runningCount) {
    return `将把所有 Running 任务（当前 ${runningCount} 个）标记为 Failed(CrashRecovery)，并执行孤儿快照清理、pending 审批作废与 trace 索引对账。请先确认这些任务的执行进程确实已不存在——正在执行的任务会被误杀且不可恢复。确认继续？`;
  }
  function approveActionHint(decision, taskStatus) {
    if (decision === "pending" && taskStatus === "paused") {
      return { decidable: true, hint: "approve 只写决议（任务保持挂起）；deny 为任务级终局（cancelled/approval_denied）" };
    }
    if (decision === "approved" && taskStatus === "paused") {
      return { decidable: false, hint: "已批准，待续跑——点击「续跑」以独立进程执行（resumedBy=manual-resume）" };
    }
    if (decision === "pending") {
      return { decidable: false, hint: `任务状态 ${taskStatus} 非挂起——审批不可决议（可能已被惰性超时终局，刷新查看）` };
    }
    return { decidable: false, hint: "该请求已终局（只读）" };
  }
  function resumeNote(result) {
    if (!result.spawned) return "续跑子进程未启动";
    const name = result.logFile.split(/[\\/]/).pop() ?? result.logFile;
    return `已 spawn 续跑子进程（resumedBy=manual-resume；日志 ${name}）——状态以任务页为准，子进程 CAS 失败时日志留因`;
  }

  // src/portal/ui/writeFlow.ts
  function cancelOp(taskId, taskStatus) {
    const mode = cancelModeFor(taskStatus);
    return {
      kind: "cancel",
      path: `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
      body: { mode: mode.defaultMode },
      confirmText: mode.hint
    };
  }
  function resumeOp(taskId) {
    return { kind: "resume", path: `/api/tasks/${encodeURIComponent(taskId)}/resume`, body: {} };
  }
  function crashRecoveryOp(runningCount) {
    return { kind: "crash-recovery", path: "/api/portal/crash-recovery", body: {}, confirmText: confirmCrashRecoveryText(runningCount) };
  }
  function approveOp(requestId) {
    return { kind: "approve", path: `/api/approvals/${encodeURIComponent(requestId)}/approve`, body: {} };
  }
  function denyOp(requestId) {
    return { kind: "deny", path: `/api/approvals/${encodeURIComponent(requestId)}/deny`, body: {} };
  }
  async function runWrite(op, deps) {
    if (op.confirmText !== void 0 && !deps.confirmBox(op.confirmText)) {
      return { ok: false, kind: "cancelled-by-user" };
    }
    let result;
    try {
      result = await deps.post(op.path, op.body ?? {});
    } catch {
      return { ok: false, kind: "network" };
    }
    if (result.ok) return { ok: true, kind: "success", data: result.data };
    if (result.kind === "network") return { ok: false, kind: "network" };
    return { ok: false, kind: "failure", status: result.status, code: result.code, message: result.message };
  }
  function createWriteGate() {
    let inFlight = false;
    return {
      acquire() {
        if (inFlight) return false;
        inFlight = true;
        return true;
      },
      release() {
        inFlight = false;
      }
    };
  }
  function resumeFeedback(result, taskId) {
    return {
      note: resumeNote(result),
      cli: `shanhai task run ${taskId} --resume --resumed-by manual-resume`,
      logUrl: `/api/tasks/${encodeURIComponent(taskId)}/resume-log`
    };
  }

  // src/portal/ui/tasksPage.ts
  var PAGE_SIZE = 20;
  var POLL_INTERVAL_MS = 5e3;
  var STATS_LIMIT = 100;
  function isListRow(row) {
    return typeof row === "object" && row !== null && typeof row.taskId === "string";
  }
  function asRows(data) {
    if (Array.isArray(data)) return data.filter(isListRow);
    const tasks = data.tasks;
    return Array.isArray(tasks) ? tasks.filter(isListRow) : [];
  }
  function mountTasksPage(ctx, query) {
    let filters = parseTaskFilters(query);
    let search = "";
    let page = 0;
    let stats = countByStatus([]);
    let statsTotal = 0;
    let rows = [];
    let total = 0;
    let feedback = null;
    let authFailed = false;
    const gate = createWriteGate();
    const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
    function listUrl() {
      const params = [];
      if (filters.status !== null && SERVER_STATUSES.includes(filters.status)) params.push(`status=${filters.status}`);
      if (filters.agent !== null) params.push(`agentId=${encodeURIComponent(filters.agent)}`);
      params.push(`limit=${PAGE_SIZE}`, `offset=${page * PAGE_SIZE}`);
      return `/api/tasks?${params.join("&")}`;
    }
    function visibleRows(now) {
      return rows.filter((row) => localTaskPass(row, filters, search, now));
    }
    function render() {
      const now = ctx.now();
      const shown = visibleRows(now);
      const runningStaleIds = rows.filter((row) => isRunningStale(row, now)).map((row) => row.taskId);
      const agentOptions = [...new Set(rows.map((r) => r.agentId))].sort();
      ctx.view.innerHTML = tasksPageHtml({
        stats,
        total: total > 0 ? total : statsTotal,
        rows: shown,
        runningStaleIds,
        page,
        pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        filters,
        agentOptions,
        search,
        feedback,
        now
      });
    }
    function renderAuthFailed() {
      ctx.view.innerHTML = `<header class="page-header"><div class="beast-row"><span class="beast-row__icon" aria-hidden="true">应</span><span class="beast-row__name">应龙·任务工作台</span><span class="beast-row__tagline">任务执行域：调度、运行与状态机</span></div><h2 class="page-header__title">任务列表</h2></header>
      <div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>`;
    }
    async function refresh() {
      if (authFailed) return;
      const [statsRes, listRes] = await Promise.all([
        apiGet(`/api/tasks?limit=${STATS_LIMIT}`, deps),
        apiGet(listUrl(), deps)
      ]);
      if (statsRes.ok === false && statsRes.kind === "http" && statsRes.status === 401 || listRes.ok === false && listRes.kind === "http" && listRes.status === 401) {
        authFailed = true;
        poller.stop();
        renderAuthFailed();
        return;
      }
      if (statsRes.ok) {
        const statsRows = asRows(statsRes.data);
        stats = countByStatus(statsRows);
        statsTotal = statsRows.length;
      }
      if (listRes.ok) {
        const body = listRes.data;
        rows = asRows(body);
        total = typeof body.total === "number" ? body.total : rows.length;
      }
      if (!statsRes.ok && !listRes.ok) {
      }
      render();
    }
    const poller = createPoller({ intervalMs: POLL_INTERVAL_MS, fn: refresh, timerHost: ctx.timerHost });
    function navigate(next) {
      filters = { ...next };
      page = 0;
      const q = taskFiltersQuery(next);
      location.hash = `#/tasks${q ? `?${q}` : ""}`;
    }
    async function refreshResumeLog(taskId) {
      const res = await apiGet(`/api/tasks/${encodeURIComponent(taskId)}/resume-log`, deps);
      const text = res.ok ? `续跑日志（${res.data.logFile ?? ""}）：
${String(res.data.content ?? "").slice(0, 4e3)}${res.data.truncated ? "\n……（已截断）" : ""}` : `续跑日志读取失败：${explainFailure({ ok: false, kind: "network" })}`;
      if (feedback?.resume) {
        feedback = { ...feedback, resume: { ...feedback.resume, logText: text } };
        render();
      }
    }
    async function handleWrite(kind, dataset) {
      if (!gate.acquire()) return;
      try {
        let op;
        if (kind === "cancel") op = cancelOp(ds(dataset, "task-id"), ds(dataset, "task-status"));
        else if (kind === "resume") op = resumeOp(ds(dataset, "task-id"));
        else if (kind === "crash-recovery") {
          const rc = Number(ds(dataset, "running-count"));
          op = crashRecoveryOp(Number.isFinite(rc) && ds(dataset, "running-count") !== "" ? rc : stats.running);
        } else return;
        const outcome = await runWrite(op, { confirmBox: ctx.confirmBox, post: (path, body) => apiPost(path, body, deps) });
        if (outcome.kind === "cancelled-by-user") return;
        if (outcome.ok) {
          const data = outcome.data;
          if (kind === "resume" && typeof data.taskId === "string") {
            const rf = resumeFeedback({ taskId: data.taskId, spawned: data.spawned === true, logFile: data.logFile ?? "" }, data.taskId);
            feedback = { kind: "success", text: "续跑请求已受理", resume: { ...rf, taskId: data.taskId } };
          } else if (kind === "crash-recovery") {
            feedback = { kind: "success", text: "崩溃恢复已执行（Running→Failed(CrashRecovery)、孤儿快照清理、pending 审批作废、trace 对账）" };
          } else {
            feedback = { kind: "success", text: `取消成功（mode=${data.mode ?? "—"}）` };
          }
        } else if (outcome.kind === "network") {
          feedback = { kind: "error", text: explainFailure({ ok: false, kind: "network" }) };
        } else {
          feedback = { kind: "error", text: `${explainFailure({ ok: false, kind: "http", status: outcome.status, code: outcome.code, message: outcome.message })}（${outcome.code}：${outcome.message}）` };
        }
        render();
        await refresh();
      } finally {
        gate.release();
      }
    }
    function onClick(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-action]");
      if (!hit) return;
      const action = hit.dataset.action;
      if (action === "stat") {
        const status = hit.dataset.status ?? "";
        navigate({ ...filters, status: filters.status === status ? null : status });
        return;
      }
      if (action === "clear-filters") {
        navigate({ status: null, agent: null, range: DEFAULT_RANGE });
        return;
      }
      if (action === "page-prev" && page > 0) {
        page -= 1;
        void refresh();
        return;
      }
      if (action === "page-next" && page < Math.ceil(total / PAGE_SIZE) - 1) {
        page += 1;
        void refresh();
        return;
      }
      if (action === "view-resume-log") {
        void refreshResumeLog(ds(hit.dataset, "task-id"));
        return;
      }
      if (action === "cancel" || action === "resume" || action === "crash-recovery") {
        void handleWrite(action, hit.dataset);
      }
    }
    function onChange(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-filter]");
      if (!hit) return;
      const key = hit.dataset.filter;
      const value = target?.value ?? "";
      if (key === "status") navigate({ ...filters, status: value.length > 0 ? value : null });
      else if (key === "agent") navigate({ ...filters, agent: value.length > 0 ? value : null });
      else if (key === "range") navigate({ ...filters, range: value || "7d" });
    }
    function onInput(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-filter]");
      if (!hit || hit.dataset.filter !== "search") return;
      search = target?.value ?? "";
      render();
    }
    function onVisibility(ev) {
      const t = ev?.target;
      const hidden = typeof t?.hidden === "boolean" ? t.hidden : ctx.doc.hidden;
      poller.onVisibility(!hidden);
    }
    ctx.view.addEventListener("click", onClick);
    ctx.view.addEventListener("change", onChange);
    ctx.view.addEventListener("input", onInput);
    ctx.doc.addEventListener("visibilitychange", onVisibility);
    void refresh();
    poller.start();
    return {
      destroy() {
        ctx.view.removeEventListener("click", onClick);
        ctx.view.removeEventListener("change", onChange);
        ctx.view.removeEventListener("input", onInput);
        ctx.doc.removeEventListener("visibilitychange", onVisibility);
        poller.stop();
      }
    };
  }

  // src/portal/ui/taskDetailView.ts
  function evidenceRowsOf(data) {
    if (typeof data !== "object" || data === null) return [];
    const chain = data;
    const rows = [];
    if (typeof chain.taskId === "string" && chain.taskId.length > 0) rows.push({ ref: `task:${chain.taskId}`, kind: "task" });
    const trace = typeof chain.trace === "object" && chain.trace !== null && Array.isArray(chain.trace.eventIds) ? chain.trace.eventIds : [];
    for (const e of trace) {
      if (typeof e === "string" && e.length > 0) rows.push({ ref: `trace_event:${e}`, kind: "trace_event" });
    }
    for (const f of Array.isArray(chain.failures) ? chain.failures : []) {
      if (typeof f === "object" && f !== null && typeof f.recordId === "string") {
        rows.push({ ref: `failure:${f.recordId}`, kind: "failure" });
      }
    }
    for (const m of Array.isArray(chain.memories) ? chain.memories : []) {
      if (typeof m === "object" && m !== null && typeof m.memoryId === "string") {
        rows.push({ ref: `memory:${m.memoryId}`, kind: "memory" });
      }
    }
    return rows;
  }
  var INPUT_COLLAPSE_LINES = 50;
  function collapseInput(input) {
    const lines = input.split("\n");
    if (lines.length <= INPUT_COLLAPSE_LINES) return { collapsed: false, head: input, full: input };
    return { collapsed: true, head: lines.slice(0, INPUT_COLLAPSE_LINES).join("\n"), full: input };
  }
  function headCardHtml(task) {
    const ended = task.endedAt ? esc(formatTimestamp(task.endedAt)) : "—";
    const cancel = task.status === "cancelled" && task.cancelReason ? `<div class="kv"><dt>取消原因</dt><dd>${esc(task.cancelReason)}</dd></div>` : "";
    return cardHtml({
      title: "任务信息",
      body: `<div class="detail-head">
      <div class="detail-head__id"><code class="mono">${esc(task.taskId)}</code><button type="button" class="btn btn--ghost btn--sm" data-action="copy-id" data-id="${esc(task.taskId)}">复制</button>${statusBadgeHtml(task.status)}</div>
      <dl class="kv-grid">
        <div class="kv"><dt>Agent</dt><dd>${esc(task.agentId)}</dd></div>
        <div class="kv"><dt>版本</dt><dd class="mono">${esc(task.agentVersionId)}</dd></div>
        <div class="kv"><dt>创建时间</dt><dd>${esc(formatTimestamp(task.createdAt))}</dd></div>
        <div class="kv"><dt>结束时间</dt><dd>${ended}</dd></div>
        <div class="kv"><dt>尝试次数</dt><dd>${task.attemptCount}</dd></div>
        <div class="kv"><dt>模型调用</dt><dd>${task.modelCallCount}</dd></div>
        <div class="kv"><dt>Token 用量</dt><dd>${formatThousands(task.tokensUsed)}</dd></div>
        ${cancel}
      </dl>
    </div>`
    });
  }
  function timelineHtml(task) {
    const end = task.endedAt ? esc(formatTimestamp(task.endedAt)) : "进行中";
    return cardHtml({
      title: "时间线",
      body: `<ol class="timeline">
      <li class="timeline__item"><span class="timeline__dot" aria-hidden="true"></span><span class="timeline__label">创建</span><span class="timeline__time">${esc(formatTimestamp(task.createdAt))}</span></li>
      <li class="timeline__item"><span class="timeline__dot" aria-hidden="true"></span><span class="timeline__label">结束</span><span class="timeline__time">${end}</span></li>
    </ol>`
    });
  }
  function inputHtml(task) {
    let pretty = task.input;
    try {
      pretty = JSON.stringify(JSON.parse(task.input), null, 2);
    } catch {
    }
    const collapsed = collapseInput(pretty);
    const body = collapsed.collapsed ? `<pre class="code-block code-block--collapsed"><code>${esc(collapsed.head)}</code></pre><button type="button" class="btn btn--ghost btn--sm" data-action="expand-input">展开全部</button><pre class="code-block" hidden><code>${esc(collapsed.full)}</code></pre>` : `<pre class="code-block"><code>${esc(pretty)}</code></pre>`;
    return cardHtml({ title: "输入", body });
  }
  function eventsHtml(events, excluded) {
    if (events.length === 0) {
      return cardHtml({ title: "事件流", body: emptyStateHtml({ title: "暂无事件" }) });
    }
    const types = [...new Set(events.map((e) => e.eventType))];
    const checks = types.map((t) => `<label class="check"><input type="checkbox" data-event-type="${esc(t)}"${excluded.has(t) ? "" : " checked"} /> ${esc(t)}</label>`).join("");
    const rows = events.filter((e) => !excluded.has(e.eventType)).map((e) => `<tr>
    <td class="mono">${esc(shortId(e.eventId))}</td>
    <td>${esc(e.eventType)}</td>
    <td>${esc(formatTimestamp(e.timestamp))}</td>
    <td>${e.callKind ? `调用 ${e.callNo ?? "—"} · ${esc(e.callKind)}` : "—"}</td>
    <td>${e.attemptNo ?? "—"}</td>
  </tr>`).join("");
    return cardHtml({
      title: "事件流",
      body: `<div class="event-filter">${checks}</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>事件</th><th>类型</th><th>时间</th><th>调用面</th><th>尝试</th></tr></thead><tbody>${rows}</tbody></table></div>`
    });
  }
  function evidenceHtml(evidence) {
    if (evidence.length === 0) {
      return cardHtml({ title: "证据", body: emptyStateHtml({ title: "本任务未登记证据引用" }) });
    }
    const rows = evidence.map((e) => `<tr>
    <td><a class="mono" href="#/observe/evidence?ref=${encodeURIComponent(e.ref)}">${esc(e.ref)}</a></td>
    <td>${esc(e.kind)}</td>
  </tr>`).join("");
    return cardHtml({ title: "证据", body: `<div class="table-wrap"><table class="table"><thead><tr><th>引用</th><th>类型</th></tr></thead><tbody>${rows}</tbody></table></div>` });
  }
  function relatedHtml(task, children) {
    const hasParent = task.parentTaskId !== null && task.parentTaskId.length > 0;
    if (!hasParent && children.length === 0) {
      return cardHtml({ title: "关联任务", body: emptyStateHtml({ title: "无关联任务" }) });
    }
    const parent = hasParent ? `<div class="kv"><dt>父任务</dt><dd><a class="mono" href="#/tasks/${encodeURIComponent(task.parentTaskId)}">${esc(shortId(task.parentTaskId))}</a></dd></div>` : "";
    const childRows = children.map((c) => `<tr>
    <td><a class="mono" href="#/tasks/${encodeURIComponent(c.taskId)}">${esc(shortId(c.taskId))}</a></td>
    <td>${statusBadgeHtml(c.status)}</td>
  </tr>`).join("");
    const childTable = children.length > 0 ? `<div class="table-wrap"><table class="table"><caption>子任务（${children.length}，基于最近 100 条前端聚合）</caption><thead><tr><th>任务</th><th>状态</th></tr></thead><tbody>${childRows}</tbody></table></div>` : "";
    return cardHtml({ title: "关联任务", body: `<dl class="kv-grid">${parent}</dl>${childTable}` });
  }
  function actionsHtml(task, stale, now) {
    const cancel = ["queued", "running", "paused"].includes(task.status) ? `<button type="button" class="btn btn--secondary" data-action="cancel" data-task-id="${esc(task.taskId)}" data-task-status="${esc(task.status)}">取消</button>` : "";
    const resume = task.status === "paused" ? `<button type="button" class="btn btn--primary" data-action="resume" data-task-id="${esc(task.taskId)}">续跑</button>` : "";
    const crash = stale || isRunningStale(task, now) ? `<button type="button" class="btn btn--danger" data-action="crash-recovery">显式崩溃恢复</button>` : "";
    const body = cancel || resume || crash ? `<div class="detail-actions">${cancel}${resume}${crash}</div>` : emptyStateHtml({ title: "当前状态无可用操作" });
    return cardHtml({ title: "操作", body });
  }
  function taskDetailHtml(m) {
    const title = `任务详情（${shortId(m.task.taskId)}）`;
    const header = pageHeaderHtml({ view: "task-detail", title });
    const stale = isRunningStale(m.task, m.now);
    const staleNotice = stale ? '<p class="warning">该任务运行时间异常，可能是孤儿运行——出口为显式崩溃恢复（全局操作），不提供取消以防误杀仍在执行的进程。</p>' : "";
    return `${header}${feedbackHtml(m.feedback)}${headCardHtml(m.task)}${timelineHtml(m.task)}${staleNotice}${inputHtml(m.task)}${eventsHtml(m.events, m.excludedEventTypes ?? /* @__PURE__ */ new Set())}${evidenceHtml(m.evidence)}${relatedHtml(m.task, m.children)}${actionsHtml(m.task, stale, m.now)}`;
  }

  // src/portal/ui/taskDetailPage.ts
  var POLL_INTERVAL_MS2 = 3e3;
  var CHILDREN_SCAN_LIMIT = 100;
  var TERMINAL_STATUSES = /* @__PURE__ */ new Set(["succeeded", "failed", "cancelled"]);
  function asObject(data) {
    return typeof data === "object" && data !== null ? data : {};
  }
  function mountTaskDetailPage(ctx, taskId) {
    let task = null;
    let events = [];
    let evidence = [];
    let children = [];
    let feedback = null;
    let authFailed = false;
    let excludedEventTypes = /* @__PURE__ */ new Set();
    let runningCount = 0;
    const gate = createWriteGate();
    const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
    function render() {
      if (!task) {
        ctx.view.innerHTML = '<div class="loading-state" role="status">加载中……</div>';
        return;
      }
      ctx.view.innerHTML = taskDetailHtml({ task, events, evidence, children, feedback, excludedEventTypes, now: ctx.now() });
    }
    async function refresh() {
      if (authFailed || task !== null && TERMINAL_STATUSES.has(task.status)) return;
      const base = `/api/tasks/${encodeURIComponent(taskId)}`;
      const [taskRes, eventsRes, evidenceRes, childrenRes] = await Promise.all([
        apiGet(base, deps),
        apiGet(`${base}/events`, deps),
        apiGet(`${base}/evidence`, deps),
        apiGet(`/api/tasks?limit=${CHILDREN_SCAN_LIMIT}`, deps)
      ]);
      if (!taskRes.ok && taskRes.kind === "http" && taskRes.status === 401) {
        authFailed = true;
        poller.stop();
        ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
        return;
      }
      if (!taskRes.ok && taskRes.kind === "http" && taskRes.status === 404) {
        poller.stop();
        ctx.view.innerHTML = `<div class="error-state" role="alert"><span class="error-state__code">not_found</span><p class="error-state__message">任务不存在：${taskId}</p><a class="btn btn--secondary" href="#/tasks">返回任务列表</a></div>`;
        return;
      }
      if (taskRes.ok) task = asObject(taskRes.data);
      if (eventsRes.ok) events = Array.isArray(eventsRes.data) ? eventsRes.data : [];
      if (evidenceRes.ok) {
        evidence = evidenceRowsOf(evidenceRes.data);
      }
      if (childrenRes.ok) {
        const tasks = Array.isArray(childrenRes.data.tasks) ? childrenRes.data.tasks : [];
        runningCount = tasks.filter((r) => r.status === "running").length;
        children = tasks.filter((r) => r.parentTaskId === taskId).map((r) => ({ taskId: String(r.taskId), status: String(r.status) }));
      }
      render();
      if (task !== null && TERMINAL_STATUSES.has(task.status)) poller.stop();
    }
    const poller = createPoller({ intervalMs: POLL_INTERVAL_MS2, fn: refresh, timerHost: ctx.timerHost });
    async function refreshResumeLog() {
      if (!feedback?.resume) return;
      const res = await apiGet(feedback.resume.logUrl, deps);
      const text = res.ok ? String(res.data.content ?? "").slice(0, 4e3) : `续跑日志读取失败：${res.ok ? "" : explainFailure(res)}`;
      feedback = { ...feedback, resume: { ...feedback.resume, logText: text } };
      render();
    }
    async function handleWrite(kind, dataset) {
      if (!gate.acquire()) return;
      try {
        let op;
        if (kind === "cancel") op = cancelOp(ds(dataset, "task-id") || taskId, ds(dataset, "task-status") || task?.status || "");
        else if (kind === "resume") op = resumeOp(ds(dataset, "task-id") || taskId);
        else if (kind === "crash-recovery") op = crashRecoveryOp(runningCount);
        else return;
        const outcome = await runWrite(op, { confirmBox: ctx.confirmBox, post: (path, body) => apiPost(path, body, deps) });
        if (outcome.kind === "cancelled-by-user") return;
        if (outcome.ok) {
          const data = outcome.data;
          if (kind === "resume" && typeof data.taskId === "string") {
            const rf = resumeFeedback({ taskId: data.taskId, spawned: data.spawned === true, logFile: data.logFile ?? "" }, data.taskId);
            feedback = { kind: "success", text: "续跑请求已受理", resume: { ...rf, taskId: data.taskId } };
          } else if (kind === "crash-recovery") {
            feedback = { kind: "success", text: "崩溃恢复已执行（Running→Failed(CrashRecovery)、孤儿快照清理、pending 审批作废、trace 对账）" };
          } else {
            feedback = { kind: "success", text: `取消成功（mode=${data.mode ?? "—"}）` };
          }
        } else if (outcome.kind === "network") {
          feedback = { kind: "error", text: explainFailure({ ok: false, kind: "network" }) };
        } else {
          feedback = { kind: "error", text: explainFailure({ ok: false, kind: "http", status: outcome.status, code: outcome.code, message: outcome.message }) };
        }
        render();
        await refresh();
      } finally {
        gate.release();
      }
    }
    function onClick(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-action]");
      if (!hit) return;
      const action = hit.dataset.action;
      if (action === "copy-id") {
        const id = hit.dataset.id ?? "";
        void navigator.clipboard?.writeText?.(id).catch(() => void 0);
        return;
      }
      if (action === "view-resume-log") {
        void refreshResumeLog();
        return;
      }
      if (action === "expand-input") {
        const hidden = ctx.view.querySelector(".code-block:not(.code-block--collapsed)");
        if (hidden) hidden.removeAttribute("hidden");
        const collapsed = ctx.view.querySelector(".code-block--collapsed");
        if (collapsed) collapsed.setAttribute("hidden", "");
        const btn = ev.target;
        if (typeof btn.setAttribute === "function") btn.setAttribute("hidden", "");
        return;
      }
      if (action === "cancel" || action === "resume" || action === "crash-recovery") {
        void handleWrite(action, hit.dataset);
      }
    }
    function onChange(ev) {
      const target = ev.target;
      const type = target?.dataset ? ds(target.dataset, "event-type") : "";
      if (!type) return;
      const next = new Set(excludedEventTypes);
      if (target?.checked === false) next.add(type);
      else next.delete(type);
      excludedEventTypes = next;
      render();
    }
    function onVisibility(ev) {
      const t = ev?.target;
      const hidden = typeof t?.hidden === "boolean" ? t.hidden : ctx.doc.hidden;
      poller.onVisibility(!hidden);
    }
    ctx.view.addEventListener("click", onClick);
    ctx.view.addEventListener("change", onChange);
    ctx.doc.addEventListener("visibilitychange", onVisibility);
    render();
    void refresh();
    poller.start();
    return {
      destroy() {
        ctx.view.removeEventListener("click", onClick);
        ctx.view.removeEventListener("change", onChange);
        ctx.doc.removeEventListener("visibilitychange", onVisibility);
        poller.stop();
      }
    };
  }

  // src/portal/ui/approvalsView.ts
  var APPROVAL_DECISION_LABELS = {
    pending: "待决议",
    approved: "已批准",
    denied: "已否决",
    superseded: "已作废"
  };
  var DECISION_KEYS = ["pending", "approved", "denied", "superseded"];
  function decisionBadgeHtml(decision) {
    const label = APPROVAL_DECISION_LABELS[decision] ?? decision;
    return `<span class="badge badge--decision-${esc(decision)}"><span class="badge__dot"></span>${esc(label)}</span>`;
  }
  function pendingViewRows(rows) {
    return rows.filter((r) => r.decision === "pending").sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  }
  function allViewRows(rows) {
    return [...rows];
  }
  var COUNTDOWN_CRITICAL_MS = 5 * 6e4;
  function countdownLabel(remainingMs) {
    if (remainingMs <= 0) return "已超时";
    if (remainingMs < 6e4) return "<1 分钟";
    return `${Math.ceil(remainingMs / 6e4)} 分钟内`;
  }
  function isCountdownCritical(remainingMs) {
    return remainingMs > 0 && remainingMs < COUNTDOWN_CRITICAL_MS;
  }
  function detailCountdownMs(timeoutAt, now) {
    const t = Date.parse(timeoutAt);
    if (Number.isNaN(t)) return 0;
    return Math.max(0, t - now);
  }
  function countdownHtml(row) {
    if (row.decision !== "pending") return '<span class="hint">—</span>';
    const cls = isCountdownCritical(row.timeoutRemainingMs) ? " countdown countdown--critical" : " countdown";
    return `<span class="${cls.trim()}">${esc(countdownLabel(row.timeoutRemainingMs))}</span>`;
  }
  function approvalsPageHtml(m) {
    const header = pageHeaderHtml({ view: "approvals", title: "待办审批" });
    const tabs = `<div class="filter-bar">
    <button type="button" class="btn ${m.mode === "pending" ? "btn--primary" : "btn--secondary"} btn--sm" data-action="view-pending">待办（pending=true）</button>
    <button type="button" class="btn ${m.mode === "all" ? "btn--primary" : "btn--secondary"} btn--sm" data-action="view-all">全部决议</button>
    ${m.mode === "all" ? `<label class="filter">决议<select data-filter="decision"><option value="">全部</option>${DECISION_KEYS.map((k) => `<option value="${k}"${m.decisionFilter === k ? " selected" : ""}>${esc(APPROVAL_DECISION_LABELS[k])}</option>`).join("")}</select></label>` : ""}
    <span class="hint">待办视图按等待最久置顶（超时风险优先，前端重排）</span>
  </div>`;
    let body;
    if (m.rows.length === 0) {
      body = cardHtml({ title: "审批列表", body: emptyStateHtml({ title: m.mode === "pending" ? "暂无待办审批" : "当前筛选无审批" }) });
    } else {
      const rowsHtml = m.rows.map((row) => `<tr>
      <td><a class="mono" href="#/approvals/${encodeURIComponent(row.requestId)}" title="${esc(row.requestId)}">${esc(shortId(row.requestId))}</a></td>
      <td><a class="mono" href="#/tasks/${encodeURIComponent(row.taskId)}" title="${esc(row.taskId)}">${esc(shortId(row.taskId))}</a>${statusBadgeHtml(row.taskStatus)}</td>
      <td class="mono">${esc(row.toolId)}</td>
      <td>${decisionBadgeHtml(row.decision)}</td>
      <td>${esc(formatTimestamp(row.requestedAt))}</td>
      <td>${countdownHtml(row)}</td>
    </tr>`).join("");
      body = cardHtml({
        title: `审批列表（第 ${m.page + 1} 页 / 共 ${m.pageCount} 页）`,
        body: tableHtml({
          columns: ["审批 ID", "任务", "工具", "决议", "请求时间", "超时倒计时"],
          rowsHtml
        }),
        actionsHtml: pagerHtml(m.page, m.pageCount)
      });
    }
    return `${header}${feedbackHtml(m.feedback)}${tabs}${body}`;
  }
  function decidedSectionHtml(req) {
    if (req.decision === "pending") return '<p class="hint">尚未决议</p>';
    return `<dl class="kv-grid">
    <div class="kv"><dt>决议</dt><dd>${decisionBadgeHtml(req.decision)}</dd></div>
    <div class="kv"><dt>决议时间</dt><dd>${esc(formatTimestamp(req.decidedAt))}</dd></div>
  </dl>`;
  }
  function approvalDetailHtml(m) {
    const { request: req } = m.detail;
    const header = pageHeaderHtml({ view: "approval-detail", title: `审批详情（${shortId(req.requestId)}）` });
    const hint = approveActionHint(req.decision, m.taskStatus ?? "unknown");
    const taskBadge = m.taskStatus ? statusBadgeHtml(m.taskStatus) : '<span class="hint">—</span>';
    const countdownMs = detailCountdownMs(req.timeoutAt, m.now);
    const countdown = req.decision === "pending" ? `<span class="${isCountdownCritical(countdownMs) ? "countdown countdown--critical" : "countdown"}">${esc(countdownLabel(countdownMs))}</span>` : '<span class="hint">—</span>';
    const head = cardHtml({
      title: "审批信息",
      body: `<dl class="kv-grid">
      <div class="kv"><dt>审批 ID</dt><dd class="mono">${esc(req.requestId)}</dd></div>
      <div class="kv"><dt>任务</dt><dd><a class="mono" href="#/tasks/${encodeURIComponent(req.taskId)}">${esc(shortId(req.taskId))}</a></dd></div>
      <div class="kv"><dt>任务状态</dt><dd>${taskBadge}</dd></div>
      <div class="kv"><dt>工具</dt><dd class="mono">${esc(req.toolId)}</dd></div>
      <div class="kv"><dt>风险档</dt><dd>${riskBadgeHtml(req.riskLevel)}</dd></div>
      <div class="kv"><dt>请求时间</dt><dd>${esc(formatTimestamp(req.requestedAt))}</dd></div>
      <div class="kv"><dt>超时倒计时</dt><dd>${countdown}</dd></div>
    </dl>
    <p class="hint hint--static">${esc(hint.hint)}</p>`
    });
    const digest = cardHtml({
      title: "参数摘要",
      body: `<dl class="kv-grid">
      <div class="kv"><dt>参数摘要（argsDigest）</dt><dd class="mono">${esc(m.detail.argsDigest ?? "—")}</dd></div>
      <div class="kv"><dt>快照保存时间</dt><dd>${esc(formatTimestamp(m.detail.snapshot?.savedAt))}</dd></div>
      <div class="kv"><dt>快照字节量</dt><dd>${m.detail.snapshot ? formatThousands(m.detail.snapshot.contextBytes) : "—"}</dd></div>
      <div class="kv"><dt>版本内容哈希</dt><dd class="mono">${esc(m.detail.binding?.contentHash ?? "—")}</dd></div>
    </dl>
    <p class="hint">明文入参不离开服务端（PauseContext 不出库），前端不展示、不缓存。</p>`
    });
    const decided = cardHtml({ title: "决议", body: decidedSectionHtml(req) });
    const cliGuide = req.decision === "approved" ? `<pre class="code-block"><code>shanhai task run ${esc(req.taskId)} --resume --resumed-by manual-resume</code></pre>` : "";
    const actions = hint.decidable ? `<div class="detail-actions">
        <button type="button" class="btn btn--primary" data-action="approve">批准（approve）</button>
        <button type="button" class="btn btn--danger" data-action="deny">否决（deny，任务终局）</button>
      </div>` : '<p class="hint">当前状态不可决议</p>';
    const actionsCard = cardHtml({ title: "决议操作", body: `${actions}${cliGuide}` });
    return `${header}${feedbackHtml(m.feedback)}${head}${digest}${decided}${actionsCard}`;
  }

  // src/portal/ui/approvalsPage.ts
  var PAGE_SIZE2 = 20;
  var POLL_INTERVAL_MS3 = 5e3;
  function asRows2(data) {
    const rows = Array.isArray(data) ? data : [];
    return rows.filter((r) => typeof r === "object" && r !== null && typeof r.requestId === "string");
  }
  function mountApprovalsPage(ctx, _query) {
    void _query;
    let mode = "pending";
    let decisionFilter = null;
    let page = 0;
    let allFetched = [];
    let feedback = null;
    let authFailed = false;
    const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
    function viewRows() {
      const source = mode === "pending" ? pendingViewRows(allFetched) : allViewRows(allFetched);
      return mode === "all" && decisionFilter !== null ? source.filter((r) => r.decision === decisionFilter) : source;
    }
    function render() {
      const rows = viewRows();
      const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE2));
      const clamped = Math.min(page, pageCount - 1);
      ctx.view.innerHTML = approvalsPageHtml({
        mode,
        rows: rows.slice(clamped * PAGE_SIZE2, clamped * PAGE_SIZE2 + PAGE_SIZE2),
        page: clamped,
        pageCount,
        decisionFilter,
        feedback,
        now: ctx.now()
      });
    }
    async function refresh() {
      if (authFailed) return;
      const res = await apiGet(mode === "pending" ? "/api/approvals?pending=true" : "/api/approvals", deps);
      if (!res.ok && res.kind === "http" && res.status === 401) {
        authFailed = true;
        poller.stop();
        ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
        return;
      }
      if (res.ok) {
        allFetched = asRows2(res.data);
        render();
      }
    }
    const poller = createPoller({ intervalMs: POLL_INTERVAL_MS3, fn: refresh, timerHost: ctx.timerHost });
    function onClick(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-action]");
      if (!hit) return;
      const action = hit.dataset.action;
      if (action === "view-pending" && mode !== "pending") {
        mode = "pending";
        decisionFilter = null;
        page = 0;
        void refresh();
      } else if (action === "view-all" && mode !== "all") {
        mode = "all";
        page = 0;
        void refresh();
      } else if (action === "page-prev" && page > 0) {
        page -= 1;
        render();
      } else if (action === "page-next") {
        page += 1;
        render();
      }
    }
    function onChange(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-filter]");
      if (!hit || hit.dataset.filter !== "decision") return;
      decisionFilter = target?.value ? target.value : null;
      page = 0;
      render();
    }
    function onVisibility(ev) {
      const t = ev?.target;
      const hidden = typeof t?.hidden === "boolean" ? t.hidden : ctx.doc.hidden;
      poller.onVisibility(!hidden);
    }
    ctx.view.addEventListener("click", onClick);
    ctx.view.addEventListener("change", onChange);
    ctx.doc.addEventListener("visibilitychange", onVisibility);
    void refresh();
    poller.start();
    return {
      destroy() {
        ctx.view.removeEventListener("click", onClick);
        ctx.view.removeEventListener("change", onChange);
        ctx.doc.removeEventListener("visibilitychange", onVisibility);
        poller.stop();
      }
    };
  }

  // src/portal/ui/approvalDetailPage.ts
  function mountApprovalDetailPage(ctx, requestId) {
    let detail = null;
    let taskStatus = null;
    let feedback = null;
    let authFailed = false;
    const gate = createWriteGate();
    const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
    function render() {
      if (!detail) {
        ctx.view.innerHTML = '<div class="loading-state" role="status">加载中……</div>';
        return;
      }
      ctx.view.innerHTML = approvalDetailHtml({ detail, taskStatus, feedback, now: ctx.now() });
    }
    async function refresh() {
      if (authFailed) return;
      const res = await apiGet(`/api/approvals/${encodeURIComponent(requestId)}`, deps);
      if (!res.ok && res.kind === "http" && res.status === 401) {
        authFailed = true;
        ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
        return;
      }
      if (!res.ok && res.kind === "http" && res.status === 404) {
        ctx.view.innerHTML = `<div class="error-state" role="alert"><span class="error-state__code">not_found</span><p class="error-state__message">审批请求不存在：${requestId}</p><a class="btn btn--secondary" href="#/approvals">返回审批列表</a></div>`;
        return;
      }
      if (res.ok) {
        detail = res.data;
        const taskId = detail.request.taskId;
        const taskRes = await apiGet(`/api/tasks/${encodeURIComponent(taskId)}`, deps);
        if (taskRes.ok) {
          const status = taskRes.data.status;
          taskStatus = typeof status === "string" ? status : null;
        }
        render();
      }
    }
    async function decide(action) {
      if (!gate.acquire()) return;
      try {
        const fresh = await apiGet(`/api/approvals/${encodeURIComponent(requestId)}`, deps);
        if (fresh.ok) {
          detail = fresh.data;
          if (detail.request.decision !== "pending") {
            feedback = { kind: "error", text: "该审批已被处理" };
            const taskId = detail.request.taskId;
            const taskRes = await apiGet(`/api/tasks/${encodeURIComponent(taskId)}`, deps);
            if (taskRes.ok) {
              const status = taskRes.data.status;
              taskStatus = typeof status === "string" ? status : null;
            }
            render();
            return;
          }
        }
        const op = action === "approve" ? approveOp(requestId) : denyOp(requestId);
        const outcome = await runWrite(op, { confirmBox: ctx.confirmBox, post: (path, body) => apiPost(path, body, deps) });
        if (outcome.ok) {
          feedback = { kind: "success", text: action === "approve" ? "已批准（approve 只写决议，任务保持挂起）" : "已否决（deny 为任务级终局：cancelled/approval_denied）" };
        } else if (outcome.kind === "network") {
          feedback = { kind: "error", text: explainFailure({ ok: false, kind: "network" }) };
        } else if (outcome.kind === "failure") {
          feedback = { kind: "error", text: `${explainFailure({ ok: false, kind: "http", status: outcome.status, code: outcome.code, message: outcome.message })}（${outcome.code}：${outcome.message}）` };
        }
        await refresh();
      } finally {
        gate.release();
      }
    }
    function onClick(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-action]");
      if (!hit) return;
      if (hit.dataset.action === "approve") void decide("approve");
      else if (hit.dataset.action === "deny") void decide("deny");
    }
    ctx.view.addEventListener("click", onClick);
    render();
    void refresh();
    return {
      destroy() {
        ctx.view.removeEventListener("click", onClick);
      }
    };
  }

  // src/portal/ui/cache.ts
  function createCache(opts) {
    const store = /* @__PURE__ */ new Map();
    return {
      get(key, fetcher) {
        const hit = store.get(key);
        if (hit) {
          if (hit.inflight) return hit.inflight;
          if (opts.now() - hit.at <= opts.ttlMs) return Promise.resolve(hit.value);
        }
        store.set(key, { value: void 0, at: 0, inflight: null });
        const entry = store.get(key);
        const p = (async () => {
          try {
            const value = await fetcher();
            store.set(key, { value, at: opts.now(), inflight: null });
            return value;
          } catch (err) {
            if (store.get(key) === entry) store.delete(key);
            throw err;
          }
        })();
        entry.inflight = p;
        return p;
      },
      invalidate(key) {
        const cur = store.get(key);
        if (cur && cur.inflight) return;
        store.delete(key);
      },
      clear() {
        store.clear();
      },
      size() {
        return store.size;
      }
    };
  }

  // src/portal/ui/observeCache.ts
  var OBSERVE_CACHE_TTL_MS = 5e3;
  function createObserveCache(now) {
    return createCache({ ttlMs: OBSERVE_CACHE_TTL_MS, now });
  }
  var sharedInstance = null;
  function sharedObserveCache() {
    if (!sharedInstance) sharedInstance = createObserveCache(() => Date.now());
    return sharedInstance;
  }

  // src/portal/ui/observeData.ts
  var CAPABILITY_STATUS_LABELS = {
    candidate: "待确认",
    active: "已生效",
    retired: "已退场"
  };
  var CAPABILITY_KIND_LABELS = {
    capability: "能力",
    limitation: "局限"
  };
  var CAPABILITY_ORIGIN_LABELS = {
    derived: "派生",
    manual: "人工"
  };
  var EVOLUTION_STATUSES = ["open", "confirmed", "dismissed"];
  var EVOLUTION_STATUS_LABELS = {
    open: "待决策",
    confirmed: "已确认",
    dismissed: "已驳回"
  };
  var EVOLUTION_TRIGGER_LABELS = {
    repeated_failure: "重复失败",
    capability_degradation: "能力退化"
  };
  function taskSuccessRate(counts) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const denominator = total - (counts.cancelled ?? 0);
    if (denominator <= 0) return null;
    return counts.succeeded / denominator;
  }
  function capabilityStatusCounts(rows) {
    const counts = { candidate: 0, active: 0, retired: 0 };
    for (const r of rows) {
      if (r.status === "candidate" || r.status === "active" || r.status === "retired") counts[r.status] += 1;
    }
    return counts;
  }
  function mergeTimeline(tasks, approvals, maxTasks = 10) {
    const topTasks = [...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, maxTasks).map((t) => ({ kind: "task", at: t.createdAt, taskId: t.taskId, status: t.status }));
    const topApprovals = [...approvals].sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt)).map((a) => ({ kind: "approval", at: a.requestedAt, requestId: a.requestId, toolId: a.toolId }));
    return [...topTasks, ...topApprovals].sort((a, b) => {
      const d = Date.parse(b.at) - Date.parse(a.at);
      if (d !== 0) return d;
      return a.kind === b.kind ? 0 : a.kind === "task" ? -1 : 1;
    });
  }
  function oldestPendingRel(approvals, now) {
    if (approvals.length === 0) return "";
    let oldest = approvals[0].requestedAt;
    for (const a of approvals) {
      if (Date.parse(a.requestedAt) < Date.parse(oldest)) oldest = a.requestedAt;
    }
    return `最老待办 ${relativeTime(oldest, now)}`;
  }
  function collectAgentIds(tasks, capabilities) {
    return [.../* @__PURE__ */ new Set([...tasks.map((t) => t.agentId), ...capabilities.map((c) => c.agentId)])].sort();
  }
  function truncateText(text, max) {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
  }
  function firstLine(text) {
    if (!text) return "";
    const i = text.indexOf("\n");
    return i < 0 ? text : text.slice(0, i);
  }
  function parseEvolutionEvidenceRefs(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e) => typeof e === "object" && e !== null && typeof e.taskId === "string");
    } catch {
      return [];
    }
  }
  function taskEvidenceRef(taskId) {
    return `task:${taskId}`;
  }
  var EVIDENCE_PAYLOAD_COLLAPSE_CHARS = 2048;
  function digestHead(digest) {
    return digest.slice(0, 12);
  }
  function prettyJson(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  // src/portal/ui/observeOverviewView.ts
  var SEVEN = ["created", "queued", "running", "paused", "succeeded", "failed", "cancelled"];
  var QUICK_ENTRIES = [
    { label: "任务列表", hash: "#/tasks", hint: "应龙·任务工作台" },
    { label: "审批中心", hash: "#/approvals", hint: "玄武·审批与发布守卫" },
    { label: "Agent 目录", hash: "#/agents", hint: "Agent 目录与详情" },
    { label: "证据查询", hash: "#/observe/evidence", hint: "夔牛·按 ref 直查" }
  ];
  function taskStatsCardHtml(m) {
    const note = m.taskTotalAll > 100 ? '<p class="hint">基于最近 100 条（全量更多，客户端聚合口径）</p>' : "";
    const cards = SEVEN.map((s) => `<div class="stat-card${m.taskCounts[s] === 0 ? " stat-card--zero stat-card--muted" : ""}"><span class="stat-card__value">${m.taskCounts[s]}</span><span class="stat-card__label">${esc(STATUS_LABELS[s])}</span></div>`).join("");
    const rate = m.successRate === null ? "—" : `${Math.round(m.successRate * 100)}%`;
    const total = `<div class="stat-card stat-card--total"><span class="stat-card__value">${m.taskTotal}</span><span class="stat-card__label">合计</span></div>
    <div class="stat-card stat-card--total"><span class="stat-card__value">${rate}</span><span class="stat-card__label">成功率</span></div>`;
    return cardHtml({
      title: "任务统计（最近 100 条客户端聚合，无统计端点）",
      body: `<div class="stat-grid">${cards}${total}</div>${note}`
    });
  }
  function approvalsCardHtml(m) {
    const oldest = m.oldestPending ? `<p class="hint">${esc(m.oldestPending)}</p>` : '<p class="hint">当前无待办审批</p>';
    return cardHtml({
      title: "待办审批",
      body: `<div class="stat-grid"><div class="stat-card stat-card--total"><span class="stat-card__value">${m.pendingCount}</span><span class="stat-card__label">待决议</span></div></div>${oldest}`
    });
  }
  function capabilityCardHtml(m) {
    const statuses = ["candidate", "active", "retired"];
    const cards = statuses.map((s) => `<div class="stat-card${m.capabilityCounts[s] === 0 ? " stat-card--muted" : ""}"><span class="stat-card__value">${m.capabilityCounts[s]}</span><span class="stat-card__label">${esc(CAPABILITY_STATUS_LABELS[s])}</span></div>`).join("");
    return cardHtml({
      title: "能力登记",
      body: `<div class="stat-grid">${cards}</div>`
    });
  }
  function timelineHtml2(entries) {
    if (entries.length === 0) {
      return cardHtml({ title: "合并时间线（最新任务 + 待办审批）", body: emptyStateHtml({ title: "暂无动态" }) });
    }
    const rows = entries.map((e) => {
      if (e.kind === "task") {
        return `<li class="feed-item"><span class="feed-item__time">${esc(formatTimestamp(e.at))}</span><a class="mono" href="#/tasks/${encodeURIComponent(e.taskId)}" title="${esc(e.taskId)}">${esc(shortId(e.taskId))}</a>${statusBadgeHtml(e.status)}</li>`;
      }
      return `<li class="feed-item"><span class="feed-item__time">${esc(formatTimestamp(e.at))}</span><a class="mono" href="#/approvals/${encodeURIComponent(e.requestId)}" title="${esc(e.requestId)}">${esc(shortId(e.requestId))}</a><span class="hint">${esc(e.toolId)}</span>${decisionBadgeHtml("pending")}</li>`;
    }).join("");
    return cardHtml({
      title: "合并时间线（最新任务前 10 + 待办审批，时间倒序）",
      body: `<ul class="feed">${rows}</ul>`
    });
  }
  function quickEntriesHtml() {
    const items = QUICK_ENTRIES.map((q) => `<a class="entry-card" href="${q.hash}"><span class="entry-card__label">${esc(q.label)}</span><span class="entry-card__hint">${esc(q.hint)}</span></a>`).join("");
    return cardHtml({ title: "快速入口", body: `<div class="entry-grid">${items}</div>` });
  }
  function observeOverviewHtml(m) {
    const header = pageHeaderHtml({ view: "observe", title: "观测·总控" });
    return `${observeTabsHtml("observe")}${header}${taskStatsCardHtml(m)}${approvalsCardHtml(m)}${capabilityCardHtml(m)}${timelineHtml2(m.timeline)}${quickEntriesHtml()}`;
  }

  // src/portal/ui/observeOverviewPage.ts
  var POLL_INTERVAL_MS4 = 5e3;
  var STATS_LIMIT2 = 100;
  var TASKS_PATH = `/api/tasks?limit=${STATS_LIMIT2}`;
  var PENDING_PATH = "/api/approvals?pending=true";
  var CAPABILITIES_PATH = "/api/capabilities";
  function isRecord(v) {
    return typeof v === "object" && v !== null;
  }
  function taskRowsOf(data) {
    const body = isRecord(data) && Array.isArray(data.tasks) ? data.tasks : Array.isArray(data) ? data : [];
    return body.filter((r) => isRecord(r) && typeof r.taskId === "string");
  }
  function approvalRowsOf(data) {
    const rows = Array.isArray(data) ? data : [];
    return rows.filter((r) => isRecord(r) && typeof r.requestId === "string");
  }
  function capabilityRowsOf(data) {
    const rows = Array.isArray(data) ? data : [];
    return rows.filter((r) => isRecord(r) && typeof r.status === "string");
  }
  function mountObserveOverviewPage(ctx, opts = {}) {
    const cache = opts.cache ?? sharedObserveCache();
    const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
    let taskRows = [];
    let taskTotalAll = 0;
    let approvals = [];
    let capabilityRows = [];
    let authFailed = false;
    async function cachedGet(path) {
      try {
        return await cache.get(path, async () => {
          const r = await apiGet(path, deps);
          if (!r.ok) throw r;
          return r;
        });
      } catch (err) {
        return err;
      }
    }
    function render() {
      const counts = countByStatus(taskRows);
      ctx.view.innerHTML = observeOverviewHtml({
        taskCounts: counts,
        taskTotal: taskRows.length,
        taskTotalAll,
        successRate: taskSuccessRate(counts),
        pendingCount: approvals.length,
        oldestPending: oldestPendingRel(approvals, ctx.now()),
        capabilityCounts: capabilityStatusCounts(capabilityRows),
        timeline: mergeTimeline(taskRows, approvals),
        loading: false,
        now: ctx.now()
      });
    }
    function renderAuthFailed() {
      ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
    }
    async function refresh() {
      if (authFailed) return;
      const [tasksRes, approvalsRes, capabilitiesRes] = await Promise.all([
        cachedGet(TASKS_PATH),
        cachedGet(PENDING_PATH),
        cachedGet(CAPABILITIES_PATH)
      ]);
      const failed = [tasksRes, approvalsRes, capabilitiesRes].filter((r) => !r.ok);
      if (failed.some((r) => r.kind === "http" && r.status === 401)) {
        authFailed = true;
        poller.stop();
        renderAuthFailed();
        return;
      }
      if (tasksRes.ok) {
        taskRows = taskRowsOf(tasksRes.data);
        const total = isRecord(tasksRes.data) ? tasksRes.data.total : void 0;
        taskTotalAll = typeof total === "number" ? total : taskRows.length;
      }
      if (approvalsRes.ok) approvals = approvalRowsOf(approvalsRes.data);
      if (capabilitiesRes.ok) capabilityRows = capabilityRowsOf(capabilitiesRes.data);
      render();
    }
    const poller = createPoller({ intervalMs: POLL_INTERVAL_MS4, fn: refresh, timerHost: ctx.timerHost });
    function onVisibility(ev) {
      const t = ev?.target;
      const hidden = typeof t?.hidden === "boolean" ? t.hidden : ctx.doc.hidden;
      poller.onVisibility(!hidden);
    }
    ctx.doc.addEventListener("visibilitychange", onVisibility);
    void refresh();
    poller.start();
    return {
      destroy() {
        ctx.doc.removeEventListener("visibilitychange", onVisibility);
        poller.stop();
      }
    };
  }

  // src/portal/ui/observeCapabilitiesView.ts
  var KIND_OPTIONS = ["capability", "limitation"];
  var STATUS_OPTIONS = ["candidate", "active", "retired"];
  function selectorHtml(m) {
    if (m.agents.length === 0) {
      return cardHtml({ title: "Agent 选择器（前端聚合，无 /api/agents 端点）", body: emptyStateHtml({ title: "暂无 Agent 数据" }) });
    }
    const agentOpts = [
      '<option value="">全部 Agent</option>',
      ...m.agents.map((a) => `<option value="${esc(a)}"${m.filters.agent === a ? " selected" : ""}>${esc(a)}</option>`)
    ].join("");
    const kindOpts = [
      '<option value="">全部类型</option>',
      ...KIND_OPTIONS.map((k) => `<option value="${k}"${m.filters.kind === k ? " selected" : ""}>${esc(CAPABILITY_KIND_LABELS[k])}</option>`)
    ].join("");
    const statusOpts = [
      '<option value="">全部状态</option>',
      ...STATUS_OPTIONS.map((s) => `<option value="${s}"${m.filters.status === s ? " selected" : ""}>${esc(CAPABILITY_STATUS_LABELS[s])}</option>`)
    ].join("");
    return cardHtml({
      title: "Agent 选择器（前端聚合，无 /api/agents 端点）",
      body: `<div class="filter-bar">
      <label class="filter">Agent<select data-filter="agent">${agentOpts}</select></label>
      <label class="filter">类型<select data-filter="kind">${kindOpts}</select></label>
      <label class="filter">状态<select data-filter="status">${statusOpts}</select></label>
      <span class="hint">仅含近期有任务或有能力登记的 Agent</span>
      ${buttonHtml("清除筛选", "ghost", 'data-action="clear-filters"')}
    </div>`
    });
  }
  function matrixHtml(m) {
    if (m.rows.length === 0) {
      return cardHtml({
        title: "能力矩阵（只读）",
        body: emptyStateHtml({ title: "当前筛选无匹配", hint: "调整筛选条件或清除筛选", actionLabel: "清除筛选", actionAttrs: 'data-action="clear-filters"' })
      });
    }
    const rows = m.rows.map((r) => {
      const evidence = r.evidencePending ? '<span class="badge badge--pending-evidence">待补证据</span>' : String(r.evidenceRefCount);
      const decided = `${r.decidedAt ? esc(formatTimestamp(r.decidedAt)) : "—"}${r.decidedBy ? `（${esc(r.decidedBy)}）` : ""}`;
      return `<tr>
      <td class="mono" title="${esc(r.capabilityId)}">${esc(shortId(r.capabilityId))}</td>
      <td>${esc(CAPABILITY_KIND_LABELS[r.kind] ?? r.kind)}</td>
      <td>${esc(CAPABILITY_ORIGIN_LABELS[r.origin] ?? r.origin)}</td>
      <td title="${esc(r.statement)}">${esc(truncateText(r.statement, 80))}</td>
      <td>${esc(CAPABILITY_STATUS_LABELS[r.status] ?? r.status)}</td>
      <td>${evidence}</td>
      <td>${esc(formatTimestamp(r.createdAt))}</td>
      <td>${decided}</td>
    </tr>`;
    }).join("");
    return tableHtml({
      caption: "能力矩阵（只读，capabilityListRow 实测投影）",
      columns: ["能力 ID", "类型", "来源", "陈述", "状态", "证据", "登记时间", "决议"],
      rowsHtml: rows
    });
  }
  function observeCapabilitiesHtml(m) {
    const header = pageHeaderHtml({ view: "observe-capabilities", title: "观测·白泽·能力" });
    return `${observeTabsHtml("observe-capabilities")}${header}${selectorHtml(m)}${matrixHtml(m)}`;
  }

  // src/portal/ui/observeCapabilitiesPage.ts
  var POLL_INTERVAL_MS5 = 1e4;
  var STATS_LIMIT3 = 100;
  var TASKS_PATH2 = `/api/tasks?limit=${STATS_LIMIT3}`;
  var CAPABILITIES_BASE = "/api/capabilities";
  var KINDS = /* @__PURE__ */ new Set(["capability", "limitation"]);
  var STATUSES = /* @__PURE__ */ new Set(["candidate", "active", "retired"]);
  function parseCapabilityFilters(query) {
    const agent = query.agent && query.agent.length > 0 ? query.agent : null;
    const kind = KINDS.has(query.kind ?? "") ? query.kind : null;
    const status = STATUSES.has(query.status ?? "") ? query.status : null;
    return { agent, kind, status };
  }
  function capabilityFiltersQuery(f) {
    const parts = [];
    if (f.agent !== null) parts.push(`agent=${encodeURIComponent(f.agent)}`);
    if (f.kind !== null) parts.push(`kind=${f.kind}`);
    if (f.status !== null) parts.push(`status=${f.status}`);
    return parts.join("&");
  }
  function isRecord2(v) {
    return typeof v === "object" && v !== null;
  }
  function taskAgentRowsOf(data) {
    const body = isRecord2(data) && Array.isArray(data.tasks) ? data.tasks : Array.isArray(data) ? data : [];
    return body.filter((r) => isRecord2(r) && typeof r.agentId === "string");
  }
  function capRowsOf(data) {
    const rows = Array.isArray(data) ? data : [];
    return rows.filter((r) => isRecord2(r) && typeof r.capabilityId === "string" && typeof r.status === "string" && typeof r.agentId === "string");
  }
  function mountObserveCapabilitiesPage(ctx, query) {
    let filters = parseCapabilityFilters(query);
    let agents = [];
    let rows = [];
    let authFailed = false;
    const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
    function matrixPath() {
      const q = capabilityFiltersQuery(filters);
      return q ? `${CAPABILITIES_BASE}?${q}` : null;
    }
    function render() {
      ctx.view.innerHTML = observeCapabilitiesHtml({ agents, filters, rows, now: ctx.now() });
    }
    function renderAuthFailed() {
      ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
    }
    async function refresh() {
      if (authFailed) return;
      const [tasksRes, capsRes] = await Promise.all([
        apiGet(TASKS_PATH2, deps),
        apiGet(CAPABILITIES_BASE, deps)
        // 选择器源（全量）
      ]);
      if (tasksRes.ok === false && tasksRes.kind === "http" && tasksRes.status === 401 || capsRes.ok === false && capsRes.kind === "http" && capsRes.status === 401) {
        authFailed = true;
        poller.stop();
        renderAuthFailed();
        return;
      }
      if (tasksRes.ok && capsRes.ok) {
        agents = collectAgentIds(taskAgentRowsOf(tasksRes.data), capRowsOf(capsRes.data));
      }
      const path = matrixPath();
      if (path === null) {
        rows = capsRes.ok ? capRowsOf(capsRes.data) : rows;
        render();
        return;
      }
      const matrixRes = await apiGet(path, deps);
      if (matrixRes.ok === false && matrixRes.kind === "http" && matrixRes.status === 401) {
        authFailed = true;
        poller.stop();
        renderAuthFailed();
        return;
      }
      if (matrixRes.ok) rows = capRowsOf(matrixRes.data);
      render();
    }
    const poller = createPoller({ intervalMs: POLL_INTERVAL_MS5, fn: refresh, timerHost: ctx.timerHost });
    function navigate(next) {
      filters = { ...next };
      const q = capabilityFiltersQuery(next);
      location.hash = `#/observe/capabilities${q ? `?${q}` : ""}`;
    }
    function onClick(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-action]");
      if (!hit) return;
      if (hit.dataset.action === "clear-filters") navigate({ agent: null, kind: null, status: null });
    }
    function onChange(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-filter]");
      if (!hit) return;
      const key = hit.dataset.filter;
      const value = target?.value ?? "";
      const v = value.length > 0 ? value : null;
      if (key === "agent") navigate({ ...filters, agent: v });
      else if (key === "kind") navigate({ ...filters, kind: v });
      else if (key === "status") navigate({ ...filters, status: v });
    }
    function onVisibility(ev) {
      const t = ev?.target;
      const hidden = typeof t?.hidden === "boolean" ? t.hidden : ctx.doc.hidden;
      poller.onVisibility(!hidden);
    }
    ctx.view.addEventListener("click", onClick);
    ctx.view.addEventListener("change", onChange);
    ctx.doc.addEventListener("visibilitychange", onVisibility);
    void refresh();
    poller.start();
    return {
      destroy() {
        ctx.view.removeEventListener("click", onClick);
        ctx.view.removeEventListener("change", onChange);
        ctx.doc.removeEventListener("visibilitychange", onVisibility);
        poller.stop();
      }
    };
  }

  // src/portal/ui/observeEvolutionView.ts
  function evolutionGroups(rows) {
    return EVOLUTION_STATUSES.map((status) => ({
      status,
      rows: rows.filter((r) => r.status === status)
    }));
  }
  function evolutionStatusBadgeHtml(status) {
    return `<span class="badge badge--evolution-${esc(status)}"><span class="badge__dot"></span>${esc(EVOLUTION_STATUS_LABELS[status] ?? status)}</span>`;
  }
  function groupHtml(group) {
    if (group.rows.length === 0) {
      return cardHtml({ title: `${EVOLUTION_STATUS_LABELS[group.status]}（0）`, body: emptyStateHtml({ title: "本组暂无候选" }) });
    }
    const rows = group.rows.map((r) => {
      const summary = truncateText(firstLine(r.proposedChange), 80);
      return `<tr>
      <td class="mono"><a href="#/observe/evolution/${encodeURIComponent(r.candidateId)}" title="${esc(r.candidateId)}">${esc(shortId(r.candidateId))}</a></td>
      <td>${esc(r.agentId)}</td>
      <td>${esc(EVOLUTION_TRIGGER_LABELS[r.trigger] ?? r.trigger)}</td>
      <td title="${esc(firstLine(r.proposedChange))}">${esc(summary)}</td>
      <td>${r.decidedAt ? esc(formatTimestamp(r.decidedAt)) : "—"}</td>
    </tr>`;
    }).join("");
    return tableHtml({
      caption: `${EVOLUTION_STATUS_LABELS[group.status]}（${group.rows.length}）`,
      columns: ["候选 ID", "Agent", "触发", "变更摘要", "决议时间"],
      rowsHtml: rows
    });
  }
  function observeEvolutionHtml(rows) {
    const header = pageHeaderHtml({ view: "observe-evolution", title: "观测·女娲·演进" });
    if (rows.length === 0) {
      return `${observeTabsHtml("observe-evolution")}${header}${cardHtml({ title: "演进候选（只读）", body: emptyStateHtml({ title: "暂无演进候选", hint: "候选由 CLI 惰性聚合生成（门户读面零写入，D-48）" }) })}`;
    }
    const groups = evolutionGroups(rows).map(groupHtml).join("");
    return `${observeTabsHtml("observe-evolution")}${header}${groups}`;
  }
  function observeEvolutionDetailHtml(m) {
    const r = m.row;
    const title = `观测·女娲·演进·详情（${shortId(r.candidateId)}）`;
    const header = pageHeaderHtml({ view: "observe-evolution-detail", title });
    const zone1 = cardHtml({
      title: "状态",
      body: `<div class="detail-head"><code class="mono">${esc(r.candidateId)}</code>${evolutionStatusBadgeHtml(r.status)}</div>`
    });
    const zone2 = cardHtml({
      title: "触发与创建",
      body: `<dl class="kv-grid">
      <div class="kv"><dt>触发</dt><dd>${esc(EVOLUTION_TRIGGER_LABELS[r.trigger] ?? r.trigger)}</dd></div>
      <div class="kv"><dt>创建时间</dt><dd>${esc(formatTimestamp(r.createdAt))}</dd></div>
    </dl>`
    });
    const zone3 = cardHtml({
      title: "提议变更（全文）",
      body: `<pre class="code-block"><code>${esc(r.proposedChange ?? "")}</code></pre>`
    });
    const zone4 = m.evidenceRefs.length === 0 ? cardHtml({ title: "证据引用", body: emptyStateHtml({ title: "无证据引用" }) }) : cardHtml({
      title: "证据引用（点击跳夔牛·证据）",
      body: `<ul class="feed">${m.evidenceRefs.map((e) => `<li class="feed-item"><span class="feed-item__time">${esc(formatTimestamp(e.occurredAt))}</span><a class="mono" href="#/observe/evidence?ref=${encodeURIComponent(taskEvidenceRef(e.taskId))}" title="${esc(taskEvidenceRef(e.taskId))}">${esc(shortId(e.taskId))}</a><span class="hint">${esc(e.subClass)}</span></li>`).join("")}</ul>`
    });
    const zone5 = cardHtml({
      title: "决定信息",
      body: r.decidedAt ? `<dl class="kv-grid"><div class="kv"><dt>决议时间</dt><dd>${esc(formatTimestamp(r.decidedAt))}</dd></div><div class="kv"><dt>决议人</dt><dd>${esc(r.decidedBy ?? "—")}</dd></div></dl>` : '<p class="hint">尚未决策（confirm/dismiss 属后续批次，本页只读）</p>'
    });
    const back = '<p><a class="btn btn--secondary" href="#/observe/evolution">返回演进列表</a></p>';
    return `${observeTabsHtml("observe-evolution-detail")}${header}${zone1}${zone2}${zone3}${zone4}${zone5}${back}`;
  }

  // src/portal/ui/observeEvolutionPage.ts
  var POLL_INTERVAL_MS6 = 1e4;
  function isRecord3(v) {
    return typeof v === "object" && v !== null;
  }
  function rowsOf(data) {
    const rows = Array.isArray(data) ? data : [];
    return rows.filter((r) => isRecord3(r) && typeof r.candidateId === "string" && typeof r.status === "string");
  }
  function mountObserveEvolutionPage(ctx) {
    let rows = [];
    let authFailed = false;
    const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
    function render() {
      ctx.view.innerHTML = observeEvolutionHtml(rows);
    }
    function renderAuthFailed() {
      ctx.view.innerHTML = '<div class="error-state" role="alert"><p class="error-state__message">认证失效，请更新 Token 后重试</p></div>';
    }
    async function refresh() {
      if (authFailed) return;
      const res = await apiGet("/api/evolution", deps);
      if (!res.ok && res.kind === "http" && res.status === 401) {
        authFailed = true;
        poller.stop();
        renderAuthFailed();
        return;
      }
      if (res.ok) {
        rows = rowsOf(res.data);
        render();
      }
    }
    const poller = createPoller({ intervalMs: POLL_INTERVAL_MS6, fn: refresh, timerHost: ctx.timerHost });
    function onVisibility(ev) {
      const t = ev?.target;
      const hidden = typeof t?.hidden === "boolean" ? t.hidden : ctx.doc.hidden;
      poller.onVisibility(!hidden);
    }
    ctx.doc.addEventListener("visibilitychange", onVisibility);
    void refresh();
    poller.start();
    return {
      destroy() {
        ctx.doc.removeEventListener("visibilitychange", onVisibility);
        poller.stop();
      }
    };
  }

  // src/portal/ui/observeEvolutionDetailPage.ts
  function isRecord4(v) {
    return typeof v === "object" && v !== null;
  }
  function mountObserveEvolutionDetailPage(ctx, id) {
    const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
    let settled = false;
    function renderError(failure) {
      const code = failure.kind === "http" ? `<span class="error-state__code">${failure.code}</span>` : "";
      ctx.view.innerHTML = `<div class="error-state" role="alert">${code}<p class="error-state__message">${explainFailure(failure)}</p></div><p><a class="btn btn--secondary" href="#/observe/evolution">返回演进列表</a></p>`;
    }
    void (async () => {
      const res = await apiGet(`/api/evolution/${encodeURIComponent(id)}`, deps);
      if (settled) return;
      if (!res.ok) {
        renderError(res);
        return;
      }
      const data = res.data;
      if (!isRecord4(data) || typeof data.candidateId !== "string") {
        renderError({ ok: false, kind: "http", status: 0, code: "unknown", message: "响应形状异常" });
        return;
      }
      const row = {
        candidateId: String(data.candidateId),
        agentId: typeof data.agentId === "string" ? data.agentId : "",
        trigger: typeof data.trigger === "string" ? data.trigger : "",
        status: typeof data.status === "string" ? data.status : "",
        proposedChange: typeof data.proposedChange === "string" ? data.proposedChange : null,
        createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
        decidedAt: typeof data.decidedAt === "string" ? data.decidedAt : null,
        decidedBy: typeof data.decidedBy === "string" ? data.decidedBy : null
      };
      const evidenceRefs = parseEvolutionEvidenceRefs(typeof data.evidenceRefs === "string" ? data.evidenceRefs : null);
      ctx.view.innerHTML = observeEvolutionDetailHtml({ row, evidenceRefs });
    })();
    return {
      destroy() {
        settled = true;
      }
    };
  }

  // src/portal/ui/observeEvidenceView.ts
  function searchCardHtml(s) {
    const notice = s.emptyInput ? '<p class="input-error" role="alert">请输入证据引用（ref，格式 kind:id）</p>' : "";
    return cardHtml({
      title: "按引用查询（唯一数据源 GET /api/evidence/:ref，无证据列表端点）",
      body: `<form class="evidence-form" data-role="evidence-form">
      <input class="filter__search mono" type="search" placeholder="如 task:task-0a1b2c3d（kind:id）" value="${esc(s.inputValue)}" data-role="evidence-input" />
      ${buttonHtml("查询", "primary", 'data-action="evidence-search"')}
    </form>${notice}
    <p class="hint">入口：本页输入 / 任务详情证据区链接 / 演进详情证据链接（?ref= 直落支持）</p>`
    });
  }
  function resultHtml(s) {
    const r = s.result;
    const pretty = prettyJson(r.payload);
    const collapsed = pretty.length > EVIDENCE_PAYLOAD_COLLAPSE_CHARS && !s.payloadExpanded;
    const payloadBlock = collapsed ? `<pre class="code-block code-block--collapsed"><code>${esc(pretty.slice(0, EVIDENCE_PAYLOAD_COLLAPSE_CHARS))}…</code></pre><button type="button" class="btn btn--ghost btn--sm" data-action="expand-payload">展开全部</button>` : `<pre class="code-block"><code>${esc(pretty)}</code></pre>`;
    const copiedNote = s.copied ? '<span class="hint">已复制</span>' : s.copyFailed ? '<span class="hint hint--error">复制失败（浏览器剪贴板不可用或未授权）——请手动选中复制</span>' : "";
    return cardHtml({
      title: "证据详情",
      body: `<dl class="kv-grid">
      <div class="kv"><dt>引用</dt><dd><code class="mono">${esc(r.ref)}</code><button type="button" class="btn btn--ghost btn--sm" data-action="copy-ref" data-ref="${esc(r.ref)}">复制</button>${copiedNote}</dd></div>
      <div class="kv"><dt>类型</dt><dd>${esc(r.kind)}</dd></div>
      <div class="kv"><dt>状态</dt><dd>${esc(r.status)}</dd></div>
      <div class="kv"><dt>发生时间</dt><dd>${esc(formatTimestamp(r.occurredAt))}</dd></div>
      <div class="kv"><dt>摘要</dt><dd class="mono" title="${esc(r.digest)}">${esc(digestHead(r.digest))}</dd></div>
    </dl>
    <p class="hint">payload（JSON 美化${pretty.length > EVIDENCE_PAYLOAD_COLLAPSE_CHARS ? `，${pretty.length} 字符默认折叠` : ""}）</p>
    ${payloadBlock}`
    });
  }
  function observeEvidenceHtml(s) {
    const header = pageHeaderHtml({ view: "observe-evidence", title: "观测·夔牛·证据" });
    const toast = s.errorText ? toastHtml(`${s.errorText}${s.errorCode ? `（${s.errorCode}）` : ""}`, "error") : "";
    const errorBar = s.errorText ? `<div class="error-state" role="alert">${s.errorCode ? `<span class="error-state__code">${esc(s.errorCode)}</span>` : ""}<p class="error-state__message">${esc(s.errorText)}</p></div>` : "";
    const result = s.result ? resultHtml(s) : s.errorText ? "" : cardHtml({ title: "查询结果", body: emptyStateHtml({ title: "尚未查询", hint: "输入证据引用（ref）后回车或点击查询" }) });
    return `${observeTabsHtml("observe-evidence")}${header}${toast}${searchCardHtml(s)}${errorBar}${result}`;
  }

  // src/portal/ui/observeEvidencePage.ts
  function isRecord5(v) {
    return typeof v === "object" && v !== null;
  }
  function resultRowOf(data) {
    if (!isRecord5(data) || typeof data.ref !== "string" || typeof data.digest !== "string") return null;
    return {
      ref: data.ref,
      kind: typeof data.kind === "string" ? data.kind : "",
      status: typeof data.status === "string" ? data.status : "",
      occurredAt: typeof data.occurredAt === "string" ? data.occurredAt : "",
      digest: data.digest,
      payload: typeof data.payload === "string" ? data.payload : ""
    };
  }
  function mountObserveEvidencePage(ctx, query) {
    const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
    const state = {
      inputValue: query.ref ?? "",
      lastQuery: "",
      result: null,
      emptyInput: false,
      errorText: null,
      errorCode: null,
      copied: false,
      copyFailed: false,
      payloadExpanded: false,
      loading: false
    };
    function render() {
      ctx.view.innerHTML = observeEvidenceHtml(state);
    }
    async function lookup(rawRef) {
      const ref = rawRef.trim();
      state.inputValue = ref;
      state.copied = false;
      state.copyFailed = false;
      state.payloadExpanded = false;
      if (ref.length === 0) {
        state.emptyInput = true;
        state.errorText = null;
        state.errorCode = null;
        render();
        return;
      }
      state.emptyInput = false;
      state.lastQuery = ref;
      state.loading = true;
      render();
      const res = await apiGet(`/api/evidence/${encodeURIComponent(ref)}`, deps);
      state.loading = false;
      if (res.ok) {
        const row = resultRowOf(res.data);
        if (row) {
          state.result = row;
          state.errorText = null;
          state.errorCode = null;
        } else {
          state.result = null;
          state.errorText = "响应形状异常（缺 ref/digest 键）";
          state.errorCode = "unknown";
        }
      } else {
        const failure = res;
        state.result = null;
        state.errorText = explainFailure(failure);
        state.errorCode = failure.kind === "http" ? failure.code : null;
      }
      render();
    }
    function onSubmit(ev) {
      ev.preventDefault();
      const value = ev.target?.value;
      if (typeof value === "string" && value.length > 0) {
        state.inputValue = value;
        void lookup(value);
        return;
      }
      void lookup(state.inputValue);
    }
    function onInput(ev) {
      const value = ev.target?.value;
      if (typeof value === "string") state.inputValue = value;
    }
    function onClick(ev) {
      const target = ev.target;
      const hit = target?.closest?.("[data-action]");
      if (!hit) return;
      const action = hit.dataset.action;
      if (action === "evidence-search") {
        void lookup(state.inputValue);
      } else if (action === "copy-ref") {
        const ref = hit.dataset.ref ?? "";
        state.copyFailed = false;
        state.copied = false;
        const nav = globalThis.navigator;
        const p = nav?.clipboard?.writeText?.(ref);
        if (p && typeof p.then === "function") {
          void p.then(() => {
            state.copied = true;
            render();
          }, () => {
            state.copyFailed = true;
            render();
          });
        } else {
          state.copyFailed = true;
          render();
        }
      } else if (action === "expand-payload") {
        state.payloadExpanded = true;
        render();
      }
    }
    ctx.view.addEventListener("submit", onSubmit);
    ctx.view.addEventListener("input", onInput);
    ctx.view.addEventListener("click", onClick);
    render();
    if (query.ref && query.ref.length > 0) void lookup(query.ref);
    return {
      destroy() {
        ctx.view.removeEventListener("submit", onSubmit);
        ctx.view.removeEventListener("input", onInput);
        ctx.view.removeEventListener("click", onClick);
      }
    };
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
    let activePage = null;
    function mountPage(route, query) {
      if (!view) return;
      const ctx = {
        doc,
        view,
        fetchImpl,
        timerHost,
        confirmBox: opts.confirmBox ?? ((text) => win.confirm(text)),
        now: () => Date.now()
      };
      switch (route.view) {
        case "tasks":
          activePage = mountTasksPage(ctx, query);
          break;
        case "task-detail":
          activePage = mountTaskDetailPage(ctx, route.id);
          break;
        case "approvals":
          activePage = mountApprovalsPage(ctx, query);
          break;
        case "approval-detail":
          activePage = mountApprovalDetailPage(ctx, route.id);
          break;
        case "observe":
          activePage = mountObserveOverviewPage(ctx);
          break;
        case "observe-capabilities":
          activePage = mountObserveCapabilitiesPage(ctx, query);
          break;
        case "observe-evolution":
          activePage = mountObserveEvolutionPage(ctx);
          break;
        case "observe-evolution-detail":
          activePage = mountObserveEvolutionDetailPage(ctx, route.id);
          break;
        case "observe-evidence":
          activePage = mountObserveEvidencePage(ctx, query);
          break;
        default:
          activePage = null;
          break;
      }
    }
    function renderRoute() {
      const hash = location.hash;
      const redirect = legacyRedirect(hash);
      if (redirect) {
        location.replace(redirect);
        return;
      }
      if (!view) return;
      if (activePage) activePage.destroy();
      activePage = null;
      const { route, query } = parseHash(hash);
      view.innerHTML = renderContent(route, query);
      mountPage(route, query);
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
