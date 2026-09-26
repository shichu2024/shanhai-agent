// 山海门户前端骨架（批次 6-1）：单页 + hash 路由 + 5s 轮询（§4.4）。
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

async function api(path) {
  const res = await fetch(path, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
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
    ? `<p class="warning">检测到 ${running.length} 个运行中任务（可能正由其他进程执行）。若确认其进程已不存在，可执行显式崩溃恢复（批次 6-3 落地）。</p>`
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
}

async function renderTaskDetail(view, id) {
  const t = await api(`/api/tasks/${encodeURIComponent(id)}`);
  view.innerHTML = `<h2>任务 ${esc(t.taskId)}</h2>
    <dl>
      <dt>agent</dt><dd>${esc(t.agentId)} @ ${esc(t.agentVersionId)}</dd>
      <dt>状态</dt><dd class="status-${esc(t.status)}">${esc(STATUS_LABELS[t.status] || t.status)}</dd>
      <dt>创建 / 结束</dt><dd>${esc(t.createdAt)} → ${esc(t.endedAt ?? '—')}</dd>
      <dt>attempts / 模型调用 / tokens</dt><dd>${t.attemptCount} / ${t.modelCallCount} / ${t.tokensUsed}</dd>
      <dt>cancelReason</dt><dd>${esc(t.cancelReason ?? '—')}</dd>
    </dl>
    <details><summary>input（存储字节原样，已脱敏）</summary><pre>${esc(t.input)}</pre></details>
    <p><a href="#/tasks">← 返回任务列表</a></p>`;
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
    <p class="hint">决议操作（approve/deny）于批次 6-3 写面落地。</p>`;
}

async function renderApprovalDetail(view, id) {
  const d = await api(`/api/approvals/${encodeURIComponent(id)}`);
  const r = d.request;
  view.innerHTML = `<h2>审批 ${esc(r.requestId)}</h2>
    <dl>
      <dt>task</dt><dd><a href="#/tasks/${encodeURIComponent(r.taskId)}">${esc(r.taskId)}</a>（${esc(r.taskStatus)}）</dd>
      <dt>工具</dt><dd>${esc(r.toolId)}</dd>
      <dt>决议</dt><dd>${esc(DECISION_LABELS[r.decision] || r.decision)}</dd>
      <dt>请求 / 超时</dt><dd>${esc(r.requestedAt)} / ${esc(r.timeoutAt)}</dd>
      <dt>argsDigest</dt><dd>${esc(d.argsDigest ?? '—')}</dd>
      <dt>绑定</dt><dd>${d.binding ? `${esc(d.binding.agentVersionId)} @ ${esc(d.binding.contentHash)}` : '—'}</dd>
    </dl>
    <details ${d.snapshot ? 'open' : ''}><summary>快照（savedAt=${esc(d.snapshot?.savedAt ?? '—')}，contextBytes=${esc(d.snapshot?.contextBytes ?? '—')}）</summary>
      <p class="hint">快照上下文详情端点于批次 6-2 落地。</p></details>
    <p><a href="#/approvals">← 返回审批列表</a></p>`;
}

function restartPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    // 5s 轮询：仅列表视图自动刷新（§4.4；详情页手动刷新）
    if (state.route && (state.route.view === 'tasks' || state.route.view === 'approvals')) render(location.hash);
  }, 5000);
}

refreshTokenState();
window.addEventListener('hashchange', () => render(location.hash));
render(location.hash);
restartPolling();
