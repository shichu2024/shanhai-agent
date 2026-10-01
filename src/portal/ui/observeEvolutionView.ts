// 第七阶段批次三（7-3/4）：观测·女娲·演进 HTML 构建（设计 V0.3 §7.3 FR-O-3，字符串面纯函数）。
// 列表按 status 三枚举分组（open 待决策 / confirmed 已确认 / dismissed 已驳回）+
// 详情五区；整页只读（confirm/dismiss 属 D-45 延后，无任何操作按钮）。
// evidenceRefs 条目渲染为可点击链接跳 #/observe/evidence?ref=task:<taskId>（FR-O-3 ④）。

import { cardHtml, emptyStateHtml, esc, pageHeaderHtml, tableHtml } from './components.js';
import { formatTimestamp, shortId } from './format.js';
import {
  EVOLUTION_STATUSES,
  EVOLUTION_STATUS_LABELS,
  EVOLUTION_TRIGGER_LABELS,
  firstLine,
  taskEvidenceRef,
  truncateText,
  type EvolutionEvidenceRefEntry,
  type EvolutionStatus,
} from './observeData.js';
import { observeTabsHtml } from './pages.js';

export interface EvolutionRowUi {
  candidateId: string;
  agentId: string;
  trigger: string;
  status: string;
  proposedChange: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** 列表行投影：candidateId 短码（悬停全码）/ agentId / trigger 中文 / proposedChange 首行截断 80 / decidedAt */
export function evolutionGroups(rows: ReadonlyArray<EvolutionRowUi>): Array<{ status: EvolutionStatus; rows: EvolutionRowUi[] }> {
  return EVOLUTION_STATUSES.map((status) => ({
    status,
    rows: rows.filter((r) => r.status === status),
  }));
}

export function evolutionStatusBadgeHtml(status: string): string {
  return `<span class="badge badge--evolution-${esc(status)}"><span class="badge__dot"></span>${esc(EVOLUTION_STATUS_LABELS[status] ?? status)}</span>`;
}

function groupHtml(group: { status: EvolutionStatus; rows: EvolutionRowUi[] }): string {
  if (group.rows.length === 0) {
    return cardHtml({ title: `${EVOLUTION_STATUS_LABELS[group.status]}（0）`, body: emptyStateHtml({ title: '本组暂无候选' }) });
  }
  const rows = group.rows.map((r) => {
    const summary = truncateText(firstLine(r.proposedChange), 80);
    return `<tr>
      <td class="mono"><a href="#/observe/evolution/${encodeURIComponent(r.candidateId)}" title="${esc(r.candidateId)}">${esc(shortId(r.candidateId))}</a></td>
      <td>${esc(r.agentId)}</td>
      <td>${esc(EVOLUTION_TRIGGER_LABELS[r.trigger] ?? r.trigger)}</td>
      <td title="${esc(firstLine(r.proposedChange))}">${esc(summary)}</td>
      <td>${r.decidedAt ? esc(formatTimestamp(r.decidedAt)) : '—'}</td>
    </tr>`;
  }).join('');
  return tableHtml({
    caption: `${EVOLUTION_STATUS_LABELS[group.status]}（${group.rows.length}）`,
    columns: ['候选 ID', 'Agent', '触发', '变更摘要', '决议时间'],
    rowsHtml: rows,
  });
}

export function observeEvolutionHtml(rows: ReadonlyArray<EvolutionRowUi>): string {
  const header = pageHeaderHtml({ view: 'observe-evolution', title: '观测·女娲·演进' });
  if (rows.length === 0) {
    return `${observeTabsHtml('observe-evolution')}${header}${cardHtml({ title: '演进候选（只读）', body: emptyStateHtml({ title: '暂无演进候选', hint: '候选由 CLI 惰性聚合生成（门户读面零写入，D-48）' }) })}`;
  }
  const groups = evolutionGroups(rows).map(groupHtml).join('');
  return `${observeTabsHtml('observe-evolution')}${header}${groups}`;
}

// ---------- 详情五区 ----------

export interface EvolutionDetailModel {
  row: EvolutionRowUi;
  evidenceRefs: ReadonlyArray<EvolutionEvidenceRefEntry>;
}

export function observeEvolutionDetailHtml(m: EvolutionDetailModel): string {
  const r = m.row;
  const title = `观测·女娲·演进·详情（${shortId(r.candidateId)}）`;
  const header = pageHeaderHtml({ view: 'observe-evolution-detail', title });

  // ① 状态徽章 + 候选全码
  const zone1 = cardHtml({
    title: '状态',
    body: `<div class="detail-head"><code class="mono">${esc(r.candidateId)}</code>${evolutionStatusBadgeHtml(r.status)}</div>`,
  });
  // ② trigger + createdAt
  const zone2 = cardHtml({
    title: '触发与创建',
    body: `<dl class="kv-grid">
      <div class="kv"><dt>触发</dt><dd>${esc(EVOLUTION_TRIGGER_LABELS[r.trigger] ?? r.trigger)}</dd></div>
      <div class="kv"><dt>创建时间</dt><dd>${esc(formatTimestamp(r.createdAt))}</dd></div>
    </dl>`,
  });
  // ③ proposedChange 全文（等宽预格式化）
  const zone3 = cardHtml({
    title: '提议变更（全文）',
    body: `<pre class="code-block"><code>${esc(r.proposedChange ?? '')}</code></pre>`,
  });
  // ④ evidenceRefs 列表（每条可点击跳证据页）
  const zone4 = m.evidenceRefs.length === 0
    ? cardHtml({ title: '证据引用', body: emptyStateHtml({ title: '无证据引用' }) })
    : cardHtml({
      title: '证据引用（点击跳夔牛·证据）',
      body: `<ul class="feed">${m.evidenceRefs.map((e) => `<li class="feed-item"><span class="feed-item__time">${esc(formatTimestamp(e.occurredAt))}</span><a class="mono" href="#/observe/evidence?ref=${encodeURIComponent(taskEvidenceRef(e.taskId))}" title="${esc(taskEvidenceRef(e.taskId))}">${esc(shortId(e.taskId))}</a><span class="hint">${esc(e.subClass)}</span></li>`).join('')}</ul>`,
    });
  // ⑤ 决定信息（open 态显「尚未决策」）
  const zone5 = cardHtml({
    title: '决定信息',
    body: r.decidedAt
      ? `<dl class="kv-grid"><div class="kv"><dt>决议时间</dt><dd>${esc(formatTimestamp(r.decidedAt))}</dd></div><div class="kv"><dt>决议人</dt><dd>${esc(r.decidedBy ?? '—')}</dd></div></dl>`
      : '<p class="hint">尚未决策（confirm/dismiss 属后续批次，本页只读）</p>',
  });

  const back = '<p><a class="btn btn--secondary" href="#/observe/evolution">返回演进列表</a></p>';
  return `${observeTabsHtml('observe-evolution-detail')}${header}${zone1}${zone2}${zone3}${zone4}${zone5}${back}`;
}
