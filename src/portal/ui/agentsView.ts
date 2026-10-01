// 第七阶段批次四（7-4/4）：Agent 目录与详情 HTML 构建（设计 V0.3 §7.5 FR-AG-1..5，字符串面纯函数）。
// Agent 页为工程视图：无神兽行（nav.ts 口径）；只读零写操作按钮；
// 反思族（reflection）与 attempts 字段零出现（V0.3 删除项）。

import { cardHtml, emptyStateHtml, esc, pageHeaderHtml, riskBadgeHtml, tableHtml } from './components.js';
import { formatTimestamp, shortId } from './format.js';
import {
  CAPABILITY_KIND_LABELS,
  CAPABILITY_ORIGIN_LABELS,
} from './observeData.js';
import {
  cardUiOf,
  insightUiOf,
  reportUiOf,
  trendBarsOf,
  type AgentCatalogRow,
  type CardUi,
  type InsightUi,
  type ReportUi,
  type TrendBarUi,
} from './agentsData.js';

// ---------- Agent 目录（#/agents） ----------

export interface AgentCatalogModel {
  rows: ReadonlyArray<AgentCatalogRow>;
  now: number;
}

export function agentCatalogHtml(m: AgentCatalogModel): string {
  const header = pageHeaderHtml({ view: 'agents', title: 'Agent 目录' });
  if (m.rows.length === 0) {
    const body = cardHtml({
      title: 'Agent 目录（前端聚合，无 /api/agents 端点）',
      body: emptyStateHtml({ title: '暂无 Agent 数据', hint: '近期有任务或有能力登记的 Agent 会出现在这里' }),
    });
    return `${header}${body}`;
  }
  const rows = m.rows.map((r) => `<tr>
    <td class="mono" title="${esc(r.agentId)}">${esc(r.agentId)}</td>
    <td>待确认 ${r.candidate} / 已生效 ${r.active} / 已退场 ${r.retired}</td>
    <td><a class="mono" href="#/agents/${encodeURIComponent(r.agentId)}">详情</a></td>
  </tr>`).join('');
  const table = tableHtml({
    caption: 'Agent 目录（tasks + capabilities 双源去重，前端聚合，无 /api/agents 端点）',
    columns: ['Agent', '能力登记', '操作'],
    rowsHtml: rows,
  });
  return `${header}${table}`;
}

// ---------- Agent 详情（#/agents/:id）四读面 ----------

export interface ZoneState<T> {
  data: T | null;
  error: string | null;
}

export interface AgentDetailModel {
  agentId: string;
  card: ZoneState<CardUi>;
  insight: ZoneState<InsightUi>;
  trend: ZoneState<{ bars: TrendBarUi[]; coverageNote: string; summary: { bucket: string; bucketCount: number; hasData: boolean; latestKey: string | null; latestRateLabel: string } }>;
  report: ZoneState<ReportUi>;
  bucket: 'day' | 'week';
  now: number;
}

function zoneErrorHtml(zone: string, message: string): string {
  return `<div class="error-state" role="alert"><p class="error-state__message">${zone}加载失败：${esc(message)}</p><button type="button" class="btn btn--secondary error-state__retry" data-action="retry">重试</button></div>`;
}

// FR-AG-1 能力卡区：卡片内容原文渲染（标题/正文区——服务端已排版的字段集）
function cardZoneHtml(m: AgentDetailModel): string {
  if (m.card.error !== null) return cardHtml({ title: '能力卡（card）', body: zoneErrorHtml('能力卡', m.card.error) });
  const c = m.card.data;
  if (c === null) return cardHtml({ title: '能力卡（card）', body: '<div class="loading-state" role="status">加载中……</div>' });
  const mission = c.mission.length > 0 ? `<ul>${c.mission.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p class="hint">—</p>';
  const nonGoals = c.nonGoals.length > 0 ? `<ul>${c.nonGoals.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p class="hint">—</p>';
  const tools = c.tools.length > 0
    ? `<ul class="card-tools">${c.tools.map((t) => `<li><span class="mono">${esc(t.toolId)}</span>${riskBadgeHtml(t.riskLevel)}</li>`).join('')}</ul>`
    : '<p class="hint">—</p>';
  return cardHtml({
    title: `能力卡（card · ${esc(shortId(c.versionId))}）`,
    body: `<dl class="kv-detail">
      <dt>agentId</dt><dd class="mono">${esc(c.agentId)}</dd>
      <dt>versionId</dt><dd class="mono" title="${esc(c.versionId)}">${esc(c.versionId)}</dd>
      <dt>specVersion / contentHash</dt><dd><span class="mono">${esc(c.specVersion)}</span> / <span class="mono" title="${esc(c.contentHash)}">${esc(shortId(c.contentHash))}</span></dd>
      <dt>mission</dt><dd>${mission}</dd>
      <dt>nonGoals</dt><dd>${nonGoals}</dd>
      <dt>tools</dt><dd>${tools}</dd>
      <dt>inputContract</dt><dd><span class="mono" title="${esc(c.inputContract.digest)}">${esc(shortId(c.inputContract.digest))}</span>（${esc(c.inputContract.type)}）</dd>
      <dt>outputContract</dt><dd><span class="mono" title="${esc(c.outputContract.digest)}">${esc(shortId(c.outputContract.digest))}</span>（${esc(c.outputContract.type)}）</dd>
      <dt>budgets</dt><dd><pre class="code-block">${esc(c.budgetsJson)}</pre></dd>
      <dt>approvalPolicy</dt><dd><pre class="code-block">${esc(c.approvalJson)}</pre></dd>
      <dt>evolutionPolicy</dt><dd><pre class="code-block">${esc(c.evolutionJson)}</pre></dd>
    </dl>`,
  });
}

// FR-AG-2 认知洞察区：三区（declared / assertions 内嵌三键 / behavior 近 30 天窗）
function insightZoneHtml(m: AgentDetailModel): string {
  if (m.insight.error !== null) return cardHtml({ title: '认知洞察（insight）', body: zoneErrorHtml('认知洞察', m.insight.error) });
  const i = m.insight.data;
  if (i === null) return cardHtml({ title: '认知洞察（insight）', body: '<div class="loading-state" role="status">加载中……</div>' });
  const declaredTools = Array.isArray(i.declared.tools)
    ? (i.declared.tools as unknown[]).filter((t): t is { toolId: string; riskLevel: string } => typeof t === 'object' && t !== null && typeof (t as { toolId?: unknown }).toolId === 'string')
    : [];
  const declared = `<div class="insight-zone">
    <h4>声明面（Agent Card 冻结字段子集）</h4>
    <dl class="kv-detail">
      <dt>versionId</dt><dd class="mono">${esc(i.versionId)}</dd>
      <dt>mission</dt><dd>${esc(prettyOf(i.declared.mission))}</dd>
      <dt>nonGoals</dt><dd>${esc(prettyOf(i.declared.nonGoals))}</dd>
      <dt>tools</dt><dd>${declaredTools.length > 0 ? declaredTools.map((t) => `<span class="mono">${esc(t.toolId)}</span>${riskBadgeHtml(t.riskLevel)}`).join(' ') : '—'}</dd>
    </dl>
  </div>`;
  const entries = i.activeEntries.length > 0
    ? `<ul class="assertion-list">${i.activeEntries.map((e) => `<li><span class="mono" title="${esc(e.capabilityId)}">${esc(shortId(e.capabilityId))}</span><span class="badge">${esc(CAPABILITY_KIND_LABELS[e.kind] ?? e.kind)}</span>${esc(e.statement)}<span class="hint">${esc(CAPABILITY_ORIGIN_LABELS[e.origin] ?? e.origin)} · 证据 ${e.evidenceCount}</span></li>`).join('')}</ul>`
    : '';
  const emptyHint = i.emptyHint !== null ? `<p class="hint hint--static">${esc(i.emptyHint)}</p>` : '';
  const assertions = `<div class="insight-zone">
    <h4>断言面（Registry 活跃断言）</h4>
    <p class="hint">活跃：capability ${i.activeCounts.capability} / limitation ${i.activeCounts.limitation}；待补证据候选 ${i.openCandidates.evidencePending}/${i.openCandidates.total}</p>
    ${emptyHint}${entries}
  </div>`;
  const behaviorNote = i.behaviorInsufficientNote !== null ? `<p class="hint hint--static">${esc(i.behaviorInsufficientNote)}</p>` : '';
  const behavior = `<div class="insight-zone">
    <h4>行为面（近 30 天趋势窗）</h4>
    <p class="hint">since ${esc(i.behaviorSince)} · status ${esc(i.behaviorStatus)}</p>
    ${behaviorNote}
  </div>`;
  return cardHtml({
    title: `认知洞察（insight · 生成于 ${esc(formatTimestamp(i.generatedAt))}）`,
    body: `${declared}${assertions}${behavior}`,
  });
}

function prettyOf(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v) ?? '—';
}

// FR-AG-3 趋势区：bucket 切换器 + TrendSummary + CSS bar 图（五键）+ coverage 注记
function trendZoneHtml(m: AgentDetailModel): string {
  const switcher = `<div class="filter-bar">
    <button type="button" class="btn${m.bucket === 'day' ? ' btn--primary' : ' btn--secondary'}" data-action="bucket-day"${m.bucket === 'day' ? ' aria-pressed="true"' : ''}>日桶</button>
    <button type="button" class="btn${m.bucket === 'week' ? ' btn--primary' : ' btn--secondary'}" data-action="bucket-week"${m.bucket === 'week' ? ' aria-pressed="true"' : ''}>周桶</button>
  </div>`;
  if (m.trend.error !== null) {
    return cardHtml({ title: '能力趋势（trend）', body: `${switcher}${zoneErrorHtml('能力趋势', m.trend.error)}` });
  }
  const t = m.trend.data;
  if (t === null) return cardHtml({ title: '能力趋势（trend）', body: `${switcher}<div class="loading-state" role="status">加载中……</div>` });
  const summary = `<p class="hint">bucket ${esc(t.summary.bucket)} · 共 ${t.summary.bucketCount} 桶 · 最新桶 ${esc(t.summary.latestKey ?? '—')} 通过率 ${esc(t.summary.latestRateLabel)}</p>`;
  const chart = t.summary.hasData
    ? `<div class="trend-bars">${t.bars.map((b) => `<div class="trend-bar-col"><div class="trend-bar" style="height:${Math.max(b.heightPct, 2)}%" title="${esc(b.key)}：total ${b.total} / succeeded ${b.succeeded} / excludedCancelled ${b.excludedCancelled} / contractFailures ${b.contractFailures} / 通过率 ${b.rateLabel}"></div><span class="trend-bar__key">${esc(b.key)}</span><span class="trend-bar__rate">${esc(b.rateLabel)}</span></div>`).join('')}</div>`
    : '<p class="hint hint--static">—（无分母不假装）</p>';
  return cardHtml({
    title: '能力趋势（trend · tasks 五键：total/succeeded/excludedCancelled/contractFailures/contractPassRate）',
    body: `${switcher}${summary}${chart}<p class="hint">${esc(t.coverageNote)}</p>`,
  });
}

// FR-AG-4 报告摘要区：五键 + 超时橙色徽章（>0）+ 健康触发提示条
function reportZoneHtml(m: AgentDetailModel): string {
  if (m.report.error !== null) return cardHtml({ title: '报告摘要（report）', body: zoneErrorHtml('报告摘要', m.report.error) });
  const r = m.report.data;
  if (r === null) return cardHtml({ title: '报告摘要（report）', body: '<div class="loading-state" role="status">加载中……</div>' });
  const timeoutBadge = r.approvalTimeoutCount > 0
    ? `<span class="badge badge--warn">审批超时 ${r.approvalTimeoutCount}</span>`
    : '<span class="badge">审批超时 0</span>';
  const healthBar = r.healthTriggered ? `<div class="warning" role="alert">${esc(r.healthNote)}</div>` : '';
  return cardHtml({
    title: '报告摘要（reportSummary 五键）',
    body: `<dl class="kv-detail">
      <dt>agentId</dt><dd class="mono">${esc(r.agentId)}</dd>
      <dt>分组数（groupCount）</dt><dd>${r.groupCount}</dd>
      <dt>晋升建议（promoteLabel）</dt><dd>${esc(r.promoteLabel)}</dd>
      <dt>审批超时（approvalTimeoutCount）</dt><dd>${timeoutBadge}</dd>
      <dt>健康触发（healthTriggered）</dt><dd>${r.healthTriggered ? '是' : '否'}</dd>
    </dl>${healthBar}${r.healthTriggered ? '' : `<p class="hint">${esc(r.healthNote)}</p>`}`,
  });
}

export function agentDetailHtml(m: AgentDetailModel): string {
  const header = pageHeaderHtml({ view: 'agent-detail', title: `Agent 详情（${shortId(m.agentId)}）` });
  const drillDown = cardHtml({
    title: '能力下钻',
    body: `<p><a class="btn btn--secondary" href="#/observe/capabilities?agent=${encodeURIComponent(m.agentId)}">查看该 Agent 的能力登记</a></p>`,
  });
  return `${header}${cardZoneHtml(m)}${insightZoneHtml(m)}${trendZoneHtml(m)}${reportZoneHtml(m)}${drillDown}`;
}

/** 控制器数据 → 视图模型归一（形状异常按错误条呈现，不假装渲染） */
export function cardZone(data: unknown): ZoneState<CardUi> {
  const ui = cardUiOf(data);
  return ui === null ? { data: null, error: '响应形状异常（Agent Card 键缺失）' } : { data: ui, error: null };
}

export function insightZone(data: unknown): ZoneState<InsightUi> {
  const ui = insightUiOf(data);
  return ui === null ? { data: null, error: '响应形状异常（insight 三区键缺失）' } : { data: ui, error: null };
}

export function reportZone(data: unknown): ZoneState<ReportUi> {
  const ui = reportUiOf(data);
  return ui === null ? { data: null, error: '响应形状异常（reportSummary 键缺失）' } : { data: ui, error: null };
}
