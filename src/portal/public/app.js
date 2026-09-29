// 山海门户前端（批次 6-1 骨架 + 6-2 读面全景 + 6-3 写操作流）：单页 + hash 路由 + 5s 轮询（§4.4）。
// 硬性底线（TASK-81）：Token 不写入任何静态资产文件——仅经输入框存 sessionStorage，运行期注入请求头。
// 逻辑口径与 src/portal/view/*.ts 纯函数模块同源（可测 TS 模块为规范源；本文件为零构建薄壳）。

const TOKEN_KEY = 'shanhai-portal-token';

const state = { token: sessionStorage.getItem(TOKEN_KEY) ?? '', timer: null, route: null };

document.getElementById('token-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const value = document.getElementById('token-input').value.trim();
  state.token = value;
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
  refreshTokenState();
  render(location.hash);
});

function refreshTokenState() {
  document.getElementById('token-state').textContent = state.token ? '已设置' : '未设置';
}

// TASK-96：消费 URL fragment 中的 Token（#token=...，由 CLI 首启自动拉起浏览器注入）——
// 与 src/portal/browser.ts tokenFromFragment 同源镜像；fragment 不发往服务端，读取后即从地址栏抹除。
function consumeTokenFragment() {
  const m = /^#token=(.+)$/.exec(location.hash);
  if (!m) return;
  state.token = m[1];
  sessionStorage.setItem(TOKEN_KEY, m[1]);
  history.replaceState(null, '', location.pathname + location.search);
  refreshTokenState();
  document.getElementById('token-input').value = m[1];
}

async function api(path) {
  const res = await fetch(path, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error((body && body.message) || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}

// 批次 6-3：写操作（POST 强制 application/json——415 由服务端协议层封堵，此处恒发送该头）
async function apiPost(path, bodyObj = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(bodyObj),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error((body && body.message) || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function routeOf(hash) {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (h === '' || h === '/' || h === '/tasks') return { view: 'tasks' };
  const t = /^\/tasks\/([^/]+)$/.exec(h);
  if (t) return { view: 'task-detail', id: decodeURIComponent(t[1]) };
  if (h === '/approvals') return { view: 'approvals' };
  const a = /^\/approvals\/([^/]+)$/.exec(h);
  if (a) return { view: 'approval-detail', id: decodeURIComponent(a[1]) };
  if (h === '/capabilities') return { view: 'capabilities' };
  if (h === '/evolution') return { view: 'evolution' };
  const e = /^\/evolution\/([^/]+)$/.exec(h);
  if (e) return { view: 'evolution-detail', id: decodeURIComponent(e[1]) };
  const g = /^\/agents\/([^/]+)$/.exec(h);
  if (g) return { view: 'agent-detail', id: decodeURIComponent(g[1]) };
  if (h === '/evidence') return { view: 'evidence' };
  return { view: 'not-found', hash };
}

function setActiveNav(view) {
  for (const link of document.querySelectorAll('[data-nav]')) {
    link.classList.toggle('active', link.dataset.nav === view);
  }
}

async function render(hash) {
  const view = document.getElementById('view');
  const route = routeOf(hash);
  state.route = route;
  setActiveNav(route.view === 'task-detail' ? 'tasks' : route.view === 'approval-detail' ? 'approvals' : route.view);
  try {
    if (route.view === 'tasks') await renderTasks(view);
    else if (route.view === 'task-detail') await renderTaskDetail(view, route.id);
    else if (route.view === 'approvals') await renderApprovals(view);
    else if (route.view === 'approval-detail') await renderApprovalDetail(view, route.id);
    else if (route.view === 'capabilities') await renderCapabilities(view);
    else if (route.view === 'evolution') await renderEvolution(view);
    else if (route.view === 'evolution-detail') await renderEvolutionDetail(view, route.id);
    else if (route.view === 'agent-detail') await renderAgentDetail(view, route.id);
    else if (route.view === 'evidence') renderEvidence(view);
    else view.innerHTML = `<p>未找到视图：${esc(route.hash)}</p>`;
  } catch (err) {
    view.innerHTML = `<p class="error">加载失败：${esc(err.message)}${err.status === 401 ? '（请先在右上角保存门户 Token）' : ''}</p>`;
  }
}

const STATUS_LABELS = { queued: '排队中', running: '运行中', paused: '已挂起', succeeded: '已成功', failed: '已失败', cancelled: '已取消' };
const DECISION_LABELS = { pending: '待审批', approved: '已批准', denied: '已拒绝', superseded: '已作废' };

async function renderTasks(view) {
  const data = await api('/api/tasks?limit=100');
  const running = data.tasks.filter((t) => t.status === 'running');
  const warning = running.length
    ? `<p class="warning">检测到 ${running.length} 个运行中任务（可能正由其他进程执行）。若确认其进程已不存在，可执行显式崩溃恢复
       <button id="crash-recovery-btn" type="button">崩溃恢复…</button>
       <span id="crash-recovery-out"></span></p>`
    : '';
  const rows = data.tasks
    .map(
      (t) => `<tr>
        <td><a href="#/tasks/${encodeURIComponent(t.taskId)}">${esc(t.taskId)}</a></td>
        <td>${esc(t.agentId)}</td>
        <td class="status-${esc(t.status)}">${esc(STATUS_LABELS[t.status] || t.status)}</td>
        <td>${esc(t.createdAt)}</td>
        <td>${t.attemptCount}</td><td>${t.modelCallCount}</td><td>${t.tokensUsed}</td>
      </tr>`,
    )
    .join('');
  view.innerHTML = `${warning}
    <h2>任务（共 ${data.total}）</h2>
    <table><thead><tr><th>taskId</th><th>agent</th><th>状态</th><th>创建时间</th><th>attempts</th><th>模型调用</th><th>tokens</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">（空）</td></tr>'}</tbody></table>`;
  const crashBtn = document.getElementById('crash-recovery-btn');
  if (crashBtn) {
    crashBtn.addEventListener('click', async () => {
      // 确认对话框（§5.1 逃生路径：明示误杀面——口径同 view/write.ts confirmCrashRecoveryText）
      const text = `将把所有 Running 任务（当前 ${running.length} 个）标记为 Failed(CrashRecovery)，并执行孤儿快照清理、pending 审批作废与 trace 索引对账。请先确认这些任务的执行进程确实已不存在——正在执行的任务会被误杀且不可恢复。确认继续？`;
      if (!window.confirm(text)) return;
      const out = document.getElementById('crash-recovery-out');
      try {
        const r = await apiPost('/api/portal/crash-recovery');
        const rep = r.report;
        out.innerHTML = ` 已执行：崩溃标记 ${rep.crashMarkedTasks.length}、索引对账 ${rep.reconciledTasks.length}、stale 警示（queued ${rep.staleQueuedTasks.length} / paused ${rep.stalePausedTasks.length}）`;
        render(location.hash);
      } catch (err) {
        out.innerHTML = ` <span class="error">失败：${esc(err.message)}</span>`;
      }
    });
  }
}

// 事件类型标签（与 src/portal/view/events.ts 同源镜像；未知事件回退原文）
const EVENT_LABELS = {
  task_created: '任务创建', task_queued: '进入队列', task_started: '开始执行', attempt_started: '尝试开始',
  model_call_completed: '模型调用完成', tool_call_requested: '工具调用请求', tool_call_executed: '工具调用完成',
  policy_denied: '策略拒绝', attempt_failed: '尝试失败', task_succeeded: '执行成功', task_failed: '执行失败',
  task_cancelled: '任务取消', crash_recovery_marked: '崩溃恢复标记', contract_checked: '契约校验',
  approval_requested: '审批请求', approval_decided: '审批决议', task_paused: '任务挂起', task_resumed: '任务续跑',
  task_delegated: '委托子任务', task_delegation_completed: '委托完成',
  memory_written: '记忆写入', memory_loaded: '记忆注入', memory_state_changed: '记忆状态迁移',
};

async function renderTaskDetail(view, id) {
  const enc = encodeURIComponent(id);
  const t = await api(`/api/tasks/${enc}`);
  const events = await api(`/api/tasks/${enc}/events`);
  const chain = await api(`/api/tasks/${enc}/evidence`);
  const eventRows = events
    .map(
      (e) => `<tr>
        <td>${esc(e.timestamp)}</td>
        <td>${esc(EVENT_LABELS[e.eventType] || e.eventType)}</td>
        <td>${esc(e.callKind ? `调用 ${e.callNo} · ${e.callKind}` : '—')}</td>
        <td>${esc(e.eventId)}</td>
      </tr>`,
    )
    .join('');
  const canCancel = ['queued', 'running', 'paused'].includes(t.status);
  const actions = `
    <div id="task-actions">
      ${t.status === 'paused' ? '<button id="resume-btn" type="button">续跑（manual-resume）</button>' : ''}
      ${canCancel ? `<select id="cancel-mode">${t.status === 'running' ? '' : '<option value="graceful">graceful</option>'}<option value="force">force</option></select>
      <button id="cancel-btn" type="button">取消任务</button>` : ''}
      <span id="task-action-out" class="hint"></span>
    </div>
    <details id="resume-log-box" style="display:none"><summary>resume 子进程日志</summary><pre id="resume-log-pre"></pre></details>`;
  view.innerHTML = `<h2>任务 ${esc(t.taskId)}</h2>
    <dl>
      <dt>agent</dt><dd><a href="#/agents/${encodeURIComponent(t.agentId)}">${esc(t.agentId)}</a> @ ${esc(t.agentVersionId)}</dd>
      <dt>状态</dt><dd class="status-${esc(t.status)}">${esc(STATUS_LABELS[t.status] || t.status)}</dd>
      <dt>创建 / 结束</dt><dd>${esc(t.createdAt)} → ${esc(t.endedAt ?? '—')}</dd>
      <dt>attempts / 模型调用 / tokens</dt><dd>${t.attemptCount} / ${t.modelCallCount} / ${t.tokensUsed}</dd>
      <dt>cancelReason</dt><dd>${esc(t.cancelReason ?? '—')}</dd>
    </dl>
    ${actions}
    <details><summary>input（存储字节原样，已脱敏）</summary><pre>${esc(t.input)}</pre></details>
    <h3>时间线（${events.length} 事件，原样）</h3>
    <table><thead><tr><th>时间</th><th>事件</th><th>调用面</th><th>eventId</th></tr></thead>
      <tbody>${eventRows || '<tr><td colspan="4">（无事件）</td></tr>'}</tbody></table>
    <h3>证据链（trace 对账 ${chain.trace.consistent ? '一致' : '分叉'}：索引 ${chain.trace.traceIndexRows} 行 / JSONL ${chain.trace.jsonlEvents} 事件）</h3>
    <dl>
      <dt>信封</dt><dd>${esc(chain.envelope.agentId)} @ ${esc(chain.envelope.agentVersionId)}（spec ${esc(chain.envelope.specContentHash.slice(0, 12))}…）</dd>
      <dt>委托链</dt><dd>祖先 ${chain.delegationChain.ancestors.length} / 后代 ${chain.delegationChain.descendants.length}</dd>
      <dt>失败 / 记忆关联</dt><dd>${chain.failures.length} / ${chain.memories.length}</dd>
    </dl>
    <p><a href="#/tasks">← 返回任务列表</a></p>`;
  const out = document.getElementById('task-action-out');
  const resumeBtn = document.getElementById('resume-btn');
  if (resumeBtn) {
    resumeBtn.addEventListener('click', async () => {
      try {
        const r = await apiPost(`/api/tasks/${enc}/resume`);
        const name = String(r.logFile).split(/[\\\\/]/).pop();
        out.textContent = `已 spawn 续跑子进程（resumedBy=manual-resume；日志 ${name}）——状态以库为准`;
        showResumeLog(enc);
        setTimeout(() => render(location.hash), 1500);
      } catch (err) {
        out.innerHTML = `<span class="error">续跑失败：${esc(err.message)}（可改用 CLI task run --resume 兜底）</span>`;
      }
    });
  }
  const cancelBtn = document.getElementById('cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      const mode = document.getElementById('cancel-mode').value;
      // running + graceful 服务端 409；force 二次确认（D-47：abortRequested 登记后等待原子调用边界）
      if (mode === 'force' && !window.confirm('强制中止将登记 abortRequested，于下一个原子调用边界生效（模型调用不打断）。确认？')) return;
      try {
        const r = await apiPost(`/api/tasks/${enc}/cancel`, { mode });
        out.textContent = `已取消（${r.mode}）：${r.note}`;
        setTimeout(() => render(location.hash), 800);
      } catch (err) {
        if (err.status === 409) out.innerHTML = `<span class="error">${esc(err.message)}</span>`;
        else out.innerHTML = `<span class="error">取消失败：${esc(err.message)}</span>`;
      }
    });
  }
}

async function showResumeLog(enc) {
  try {
    const log = await api(`/api/tasks/${enc}/resume-log`);
    const box = document.getElementById('resume-log-box');
    if (!box) return;
    box.style.display = '';
    document.getElementById('resume-log-pre').textContent = log.content || '（日志为空）';
  } catch {
    /* 无日志（未 resume 过）——保持折叠 */
  }
}

function timeoutLabel(row) {
  if (row.decision !== 'pending') return '—';
  const ms = row.timeoutRemainingMs ?? 0;
  if (ms <= 0) return '已超时';
  if (ms < 60000) return '<1 分钟';
  return `${Math.ceil(ms / 60000)} 分钟内`;
}

async function renderApprovals(view) {
  const rows = await api('/api/approvals?pending=true');
  const trs = rows
    .map(
      (r) => `<tr>
        <td><a href="#/approvals/${encodeURIComponent(r.requestId)}">${esc(r.requestId)}</a></td>
        <td><a href="#/tasks/${encodeURIComponent(r.taskId)}">${esc(r.taskId)}</a></td>
        <td>${esc(r.toolId)}</td>
        <td>${esc(DECISION_LABELS[r.decision] || r.decision)}</td>
        <td>${esc(r.taskStatus)}</td>
        <td>${esc(timeoutLabel(r))}</td>
      </tr>`,
    )
    .join('');
  view.innerHTML = `<h2>待审批（${rows.length}）</h2>
    <table><thead><tr><th>requestId</th><th>task</th><th>工具</th><th>决议</th><th>任务状态</th><th>剩余时间</th></tr></thead>
    <tbody>${trs || '<tr><td colspan="6">（无待审批）</td></tr>'}</tbody></table>
    <p class="hint">点击 requestId 进入详情执行 approve（只写决议，任务保持挂起，续跑为独立两步）/ deny（任务级终局）。</p>`;
}

async function renderApprovalDetail(view, id) {
  const enc = encodeURIComponent(id);
  const d = await api(`/api/approvals/${enc}`);
  const r = d.request;
  // 决议区（§5.2：approve 只写 decision（--detach 语义）；deny 任务级终局；approved+paused = 已批准待续跑）
  const decidable = r.decision === 'pending' && r.taskStatus === 'paused';
  const decisionPanel = decidable
    ? `<div id="approval-actions">
        <button id="approve-btn" type="button">批准（approve）</button>
        <input id="deny-reason" type="text" placeholder="拒绝理由（可选）" style="width: 220px" />
        <button id="deny-btn" type="button">拒绝（deny）</button>
        <span id="approval-action-out" class="hint"></span>
      </div>`
    : r.decision === 'approved' && r.taskStatus === 'paused'
      ? `<div id="approval-actions"><p class="warning">已批准，待续跑——<a href="#/tasks/${encodeURIComponent(r.taskId)}">前往任务页</a>点击「续跑」（resumedBy=manual-resume）。</p></div>`
      : '';
  view.innerHTML = `<h2>审批 ${esc(r.requestId)}</h2>
    <dl>
      <dt>task</dt><dd><a href="#/tasks/${encodeURIComponent(r.taskId)}">${esc(r.taskId)}</a>（${esc(r.taskStatus)}）</dd>
      <dt>工具</dt><dd>${esc(r.toolId)}</dd>
      <dt>决议</dt><dd>${esc(DECISION_LABELS[r.decision] || r.decision)}</dd>
      <dt>请求 / 超时</dt><dd>${esc(r.requestedAt)} / ${esc(r.timeoutAt)}</dd>
      <dt>argsDigest</dt><dd>${esc(d.argsDigest ?? '—')}</dd>
      <dt>绑定</dt><dd>${d.binding ? `${esc(d.binding.agentVersionId)} @ ${esc(d.binding.contentHash)}` : '—'}</dd>
    </dl>
    ${decisionPanel}
    <details ${d.snapshot ? 'open' : ''}><summary>快照（savedAt=${esc(d.snapshot?.savedAt ?? '—')}，contextBytes=${esc(d.snapshot?.contextBytes ?? '—')}）</summary>
      <p class="hint">快照上下文为 resume 执行面数据，门户只读展示元信息。</p></details>
    <p><a href="#/approvals">← 返回审批列表</a></p>`;
  const out = document.getElementById('approval-action-out');
  const approveBtn = document.getElementById('approve-btn');
  if (approveBtn) {
    approveBtn.addEventListener('click', async () => {
      try {
        const res = await apiPost(`/api/approvals/${enc}/approve`);
        out.textContent = `已批准（任务保持 ${res.taskStatus}，待续跑）`;
        setTimeout(() => render(location.hash), 600);
      } catch (err) {
        out.innerHTML = `<span class="error">批准失败：${esc(err.message)}</span>`;
      }
    });
  }
  const denyBtn = document.getElementById('deny-btn');
  if (denyBtn) {
    denyBtn.addEventListener('click', async () => {
      const reason = document.getElementById('deny-reason').value.trim();
      try {
        const res = await apiPost(`/api/approvals/${enc}/deny`, reason ? { reason } : {});
        out.textContent = `已拒绝（任务终态 ${res.taskStatus}/${res.cancelReason}）`;
        setTimeout(() => render(location.hash), 600);
      } catch (err) {
        out.innerHTML = `<span class="error">拒绝失败：${esc(err.message)}</span>`;
      }
    });
  }
}

// ---------- 批次 6-2：读面全景视图 ----------

const CAP_STATUS_LABELS = { candidate: '待确认', active: '已生效', retired: '已退场' };
const EVO_STATUS_LABELS = { open: '待裁决', confirmed: '已确认', dismissed: '已驳回' };

async function renderCapabilities(view) {
  const rows = await api('/api/capabilities');
  const trs = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.capabilityId.slice(0, 8))}…</td>
        <td><a href="#/agents/${encodeURIComponent(r.agentId)}">${esc(r.agentId)}</a></td>
        <td>${esc(r.kind)}</td>
        <td>${esc(r.origin)}</td>
        <td>${esc(r.statement)}</td>
        <td>${esc(CAP_STATUS_LABELS[r.status] || r.status)}</td>
        <td>${r.evidencePending ? '草稿（无证据）' : r.evidenceRefs.length}</td>
      </tr>`,
    )
    .join('');
  view.innerHTML = `<h2>能力/限制断言（${rows.length}）</h2>
    <table><thead><tr><th>capabilityId</th><th>agent</th><th>kind</th><th>origin</th><th>statement</th><th>状态</th><th>证据</th></tr></thead>
    <tbody>${trs || '<tr><td colspan="7">（空——Registry 无条目非错误）</td></tr>'}</tbody></table>`;
}

function jsonBlock(title, obj) {
  return `<details><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(obj, null, 2))}</pre></details>`;
}

async function renderAgentDetail(view, id) {
  const enc = encodeURIComponent(id);
  const [card, insight, trend, report] = await Promise.all([
    api(`/api/agents/${enc}/card`),
    api(`/api/agents/${enc}/insight`).catch(() => null),
    api(`/api/agents/${enc}/trend`),
    api(`/api/agents/${enc}/report`),
  ]);
  const insightSection = insight
    ? `<h3>自我认知报告</h3>
      <dl>
        <dt>断言面（active）</dt><dd>${esc(`capability ${insight.assertions.active.counts.capability} / limitation ${insight.assertions.active.counts.limitation}`)}；open candidates ${insight.assertions.openCandidates.total}（evidencePending ${insight.assertions.openCandidates.evidencePending}）</dd>
        <dt>行为面</dt><dd>${insight.behavior.status === 'ok' ? `正常（${insight.behavior.buckets.length} 桶）` : esc(insight.behavior.insufficientNote ?? '样本不足')}</dd>
        <dt>限制条目</dt><dd>${insight.limitations.entries.length}</dd>
      </dl>
      ${jsonBlock('insight 完整 JSON（只读制品，永不存储）', insight)}`
    : '<h3>自我认知报告</h3><p class="hint">（无当前指针版本——card 导出需显式 versionId 或已 release）</p>';
  view.innerHTML = `<h2>Agent ${esc(id)}</h2>
    <h3>Agent Card（声明面，只读派生）</h3>
    <dl>
      <dt>版本</dt><dd>${esc(card.versionId)}（spec ${esc(card.specVersion)}，content ${esc(card.contentHash.slice(0, 12))}…）</dd>
      <dt>职责</dt><dd>${esc(card.mission.responsibilities.join('；') || '—')}</dd>
      <dt>非目标</dt><dd>${esc(card.nonGoals.join('；') || '—')}</dd>
      <dt>工具</dt><dd>${card.tools.length} 项（${esc(card.tools.map((t) => `${t.toolId}:${t.riskLevel}`).join(', ') || '—')}）</dd>
    </dl>
    ${jsonBlock('card 完整 JSON', card)}
    ${insightSection}
    <h3>能力趋势（缺省 day 桶，近 30 天窗）</h3>
    <p>${trend.buckets.length ? `最新桶 ${esc(trend.buckets[trend.buckets.length - 1].key)}：任务 ${trend.buckets[trend.buckets.length - 1].tasks.total} / 通过率 ${trend.buckets[trend.buckets.length - 1].tasks.contractPassRate ?? 'null（无分母不假装）'}` : '（窗口内无数据）'} · ${esc(trend.coverage.note)}</p>
    ${jsonBlock('trend 完整 JSON', trend)}
    <h3>分组通过率报告</h3>
    <dl>
      <dt>分组</dt><dd>${report.groups.length} 组</dd>
      <dt>promote 判据</dt><dd>${esc(report.promoteCriteria.status)}（canary 样本 ${report.promoteCriteria.canarySample}）</dd>
      <dt>健康面板</dt><dd>${report.healthPanel.triggered ? '⚠️ OTel 触发条件已满足' : '未触发'}（Trace 事件 ${report.healthPanel.traceEventCount} / 文件 ${report.healthPanel.traceFileCount}）</dd>
    </dl>
    ${jsonBlock('report 完整 JSON', report)}
    <p><a href="#/tasks">← 返回任务列表</a></p>`;
}

async function renderEvolution(view) {
  const rows = await api('/api/evolution');
  const trs = rows
    .map(
      (r) => {
        let count = 0;
        try { count = JSON.parse(r.evidenceRefs).length; } catch { count = 0; }
        return `<tr>
          <td><a href="#/evolution/${encodeURIComponent(r.candidateId)}">${esc(r.candidateId.slice(0, 8))}…</a></td>
          <td><a href="#/agents/${encodeURIComponent(r.agentId)}">${esc(r.agentId)}</a></td>
          <td>${esc(r.trigger)}</td>
          <td>${esc(EVO_STATUS_LABELS[r.status] || r.status)}</td>
          <td>${count}</td>
          <td>${esc(r.createdAt)}</td>
        </tr>`;
      },
    )
    .join('');
  view.innerHTML = `<h2>演进候选（${rows.length}）</h2>
    <table><thead><tr><th>candidateId</th><th>agent</th><th>触发器</th><th>状态</th><th>证据</th><th>创建时间</th></tr></thead>
    <tbody>${trs || '<tr><td colspan="6">（空）</td></tr>'}</tbody></table>
    <p class="hint">门户读面不触发惰性聚合（零写入）——新候选由 CLI evolution list 聚合生成。</p>`;
}

async function renderEvolutionDetail(view, id) {
  const row = await api(`/api/evolution/${encodeURIComponent(id)}`);
  view.innerHTML = `<h2>演进候选 ${esc(row.candidateId)}</h2>
    <dl>
      <dt>agent</dt><dd><a href="#/agents/${encodeURIComponent(row.agentId)}">${esc(row.agentId)}</a></dd>
      <dt>触发器 / 状态</dt><dd>${esc(row.trigger)} / ${esc(EVO_STATUS_LABELS[row.status] || row.status)}</dd>
      <dt>提议变更</dt><dd>${esc(row.proposedChange ?? '—')}</dd>
    </dl>
    ${jsonBlock('候选完整 JSON（evidenceRefs 含证据回链）', row)}
    <p><a href="#/evolution">← 返回演进列表</a></p>`;
}

function renderEvidence(view) {
  view.innerHTML = `<h2>证据查询</h2>
    <p class="hint">ref 格式 <code>&lt;kind&gt;:&lt;id&gt;</code>，kind ∈ task / trace_event / failure / memory / eval（eval 为预留位）。</p>
    <form id="evidence-form">
      <input id="evidence-ref" type="text" placeholder="task:t-123456" style="width: 320px" />
      <button type="submit">查询</button>
    </form>
    <div id="evidence-result"><p class="hint">payload 为已脱敏落盘体原文（存储字节原样，不二次处理）。</p></div>`;
  document.getElementById('evidence-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const raw = document.getElementById('evidence-ref').value.trim();
    const out = document.getElementById('evidence-result');
    const parts = raw.split(':');
    if (parts.length !== 2 || !['task', 'trace_event', 'failure', 'memory', 'eval'].includes(parts[0]) || !parts[1]) {
      out.innerHTML = '<p class="error">ref 格式非法（须 <kind>:<id>，kind 在封闭枚举内）</p>';
      return;
    }
    try {
      const r = await api(`/api/evidence/${encodeURIComponent(raw)}`);
      out.innerHTML = `<dl>
          <dt>信封</dt><dd>${esc(r.envelope.agentId)} @ ${esc(r.envelope.agentVersionId)}（任务 ${esc(r.envelope.taskId)}）</dd>
          <dt>状态 / 时间</dt><dd>${esc(r.status)} / ${esc(r.occurredAt)}</dd>
          <dt>digest</dt><dd>${esc(r.digest.slice(0, 12))}…（sha256(payload)）</dd>
        </dl>
        <details ${r.payload.length > 2048 ? '' : 'open'}><summary>payload（${r.payload.length} 字符${r.payload.length > 2048 ? '，超 2KB 默认折叠' : ''}）</summary><pre>${esc(r.payload)}</pre></details>`;
    } catch (err) {
      out.innerHTML = `<p class="error">查询失败：${esc(err.message)}</p>`;
    }
  });
}

function restartPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    // 5s 轮询：仅列表视图自动刷新（§4.4；详情页手动刷新）
    if (state.route && (state.route.view === 'tasks' || state.route.view === 'approvals')) render(location.hash);
  }, 5000);
}

refreshTokenState();
consumeTokenFragment();
window.addEventListener('hashchange', () => render(location.hash));
render(location.hash);
restartPolling();
