// 第七阶段批次三（7-3/4）：观测·白泽·能力 HTML 构建（设计 V0.3 §7.2 FR-O-2，字符串面纯函数）。
// Agent 选择器（双源去重）+ 能力矩阵只读（capabilityListRow 实测投影，api.ts:37-53）。
// 明示：无 /api/agents 列表端点；V0.1 虚构字段（reflection 族）零出现。

import { buttonHtml, cardHtml, emptyStateHtml, esc, pageHeaderHtml, tableHtml } from './components.js';
import { formatTimestamp, shortId } from './format.js';
import {
  CAPABILITY_KIND_LABELS,
  CAPABILITY_ORIGIN_LABELS,
  CAPABILITY_STATUS_LABELS,
  truncateText,
} from './observeData.js';
import { observeTabsHtml } from './pages.js';

export interface CapabilityFilters {
  agent: string | null;
  kind: string | null;
  status: string | null;
}

export interface CapabilityRowUi {
  capabilityId: string;
  agentId: string;
  kind: string;
  origin: string;
  statement: string;
  status: string;
  evidenceRefCount: number;
  evidencePending: boolean;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface CapabilitiesModel {
  /** 双源去重排序的 Agent 列表（tasks + capabilities） */
  agents: ReadonlyArray<string>;
  filters: CapabilityFilters;
  rows: ReadonlyArray<CapabilityRowUi>;
  now: number;
}

const KIND_OPTIONS = ['capability', 'limitation'] as const;
const STATUS_OPTIONS = ['candidate', 'active', 'retired'] as const;

function selectorHtml(m: CapabilitiesModel): string {
  if (m.agents.length === 0) {
    return cardHtml({ title: 'Agent 选择器（前端聚合，无 /api/agents 端点）', body: emptyStateHtml({ title: '暂无 Agent 数据' }) });
  }
  const agentOpts = ['<option value="">全部 Agent</option>',
    ...m.agents.map((a) => `<option value="${esc(a)}"${m.filters.agent === a ? ' selected' : ''}>${esc(a)}</option>`),
  ].join('');
  const kindOpts = ['<option value="">全部类型</option>',
    ...KIND_OPTIONS.map((k) => `<option value="${k}"${m.filters.kind === k ? ' selected' : ''}>${esc(CAPABILITY_KIND_LABELS[k])}</option>`),
  ].join('');
  const statusOpts = ['<option value="">全部状态</option>',
    ...STATUS_OPTIONS.map((s) => `<option value="${s}"${m.filters.status === s ? ' selected' : ''}>${esc(CAPABILITY_STATUS_LABELS[s])}</option>`),
  ].join('');
  return cardHtml({
    title: 'Agent 选择器（前端聚合，无 /api/agents 端点）',
    body: `<div class="filter-bar">
      <label class="filter">Agent<select data-filter="agent">${agentOpts}</select></label>
      <label class="filter">类型<select data-filter="kind">${kindOpts}</select></label>
      <label class="filter">状态<select data-filter="status">${statusOpts}</select></label>
      <span class="hint">仅含近期有任务或有能力登记的 Agent</span>
      ${buttonHtml('清除筛选', 'ghost', 'data-action="clear-filters"')}
    </div>`,
  });
}

function matrixHtml(m: CapabilitiesModel): string {
  if (m.rows.length === 0) {
    return cardHtml({
      title: '能力矩阵（只读）',
      body: emptyStateHtml({ title: '当前筛选无匹配', hint: '调整筛选条件或清除筛选', actionLabel: '清除筛选', actionAttrs: 'data-action="clear-filters"' }),
    });
  }
  const rows = m.rows.map((r) => {
    const evidence = r.evidencePending
      ? '<span class="badge badge--pending-evidence">待补证据</span>'
      : String(r.evidenceRefCount);
    const decided = `${r.decidedAt ? esc(formatTimestamp(r.decidedAt)) : '—'}${r.decidedBy ? `（${esc(r.decidedBy)}）` : ''}`;
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
  }).join('');
  return tableHtml({
    caption: '能力矩阵（只读，capabilityListRow 实测投影）',
    columns: ['能力 ID', '类型', '来源', '陈述', '状态', '证据', '登记时间', '决议'],
    rowsHtml: rows,
  });
}

export function observeCapabilitiesHtml(m: CapabilitiesModel): string {
  const header = pageHeaderHtml({ view: 'observe-capabilities', title: '观测·白泽·能力' });
  return `${observeTabsHtml('observe-capabilities')}${header}${selectorHtml(m)}${matrixHtml(m)}`;
}
