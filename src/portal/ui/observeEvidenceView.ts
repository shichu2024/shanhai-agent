// 第七阶段批次三（7-3/4）：观测·夔牛·证据 HTML 构建（设计 V0.3 §7.4 FR-O-4，字符串面纯函数）。
// 三入口（页内输入框 / ?ref= 直落 / 跨页链接）；结果 = EvidenceViewRow 六键；
// payload >2048 默认折叠；错误面 toast + 页内错误条双呈现（FR-WR-5 口径）。
// 删除项：runs 表格与 integrity 区零出现。

import { buttonHtml, cardHtml, emptyStateHtml, esc, pageHeaderHtml, toastHtml } from './components.js';
import { formatTimestamp } from './format.js';
import { EVIDENCE_PAYLOAD_COLLAPSE_CHARS, digestHead, prettyJson } from './observeData.js';
import { observeTabsHtml } from './pages.js';

export interface EvidenceResultRow {
  ref: string;
  kind: string;
  status: string;
  occurredAt: string;
  digest: string;
  payload: string;
}

export interface EvidenceUiState {
  /** 输入框当前值 */
  inputValue: string;
  /** 最近一次查询的 ref */
  lastQuery: string;
  result: EvidenceResultRow | null;
  /** 非空校验未过提示 */
  emptyInput: boolean;
  /** 查询失败（toast + 页内错误条双呈现） */
  errorText: string | null;
  errorCode: string | null;
  copied: boolean;
  /** 剪贴板不可用（如未授权）时的如实降级提示 */
  copyFailed: boolean;
  payloadExpanded: boolean;
  loading: boolean;
}

function searchCardHtml(s: EvidenceUiState): string {
  const notice = s.emptyInput ? '<p class="input-error" role="alert">请输入证据引用（ref，格式 kind:id）</p>' : '';
  return cardHtml({
    title: '按引用查询（唯一数据源 GET /api/evidence/:ref，无证据列表端点）',
    body: `<form class="evidence-form" data-role="evidence-form">
      <input class="filter__search mono" type="search" placeholder="如 task:task-0a1b2c3d（kind:id）" value="${esc(s.inputValue)}" data-role="evidence-input" />
      ${buttonHtml('查询', 'primary', 'data-action="evidence-search"')}
    </form>${notice}
    <p class="hint">入口：本页输入 / 任务详情证据区链接 / 演进详情证据链接（?ref= 直落支持）</p>`,
  });
}

function resultHtml(s: EvidenceUiState): string {
  const r = s.result!;
  const pretty = prettyJson(r.payload);
  const collapsed = pretty.length > EVIDENCE_PAYLOAD_COLLAPSE_CHARS && !s.payloadExpanded;
  const payloadBlock = collapsed
    ? `<pre class="code-block code-block--collapsed"><code>${esc(pretty.slice(0, EVIDENCE_PAYLOAD_COLLAPSE_CHARS))}…</code></pre><button type="button" class="btn btn--ghost btn--sm" data-action="expand-payload">展开全部</button>`
    : `<pre class="code-block"><code>${esc(pretty)}</code></pre>`;
  const copiedNote = s.copied
    ? '<span class="hint">已复制</span>'
    : s.copyFailed
      ? '<span class="hint hint--error">复制失败（浏览器剪贴板不可用或未授权）——请手动选中复制</span>'
      : '';
  return cardHtml({
    title: '证据详情',
    body: `<dl class="kv-grid">
      <div class="kv"><dt>引用</dt><dd><code class="mono">${esc(r.ref)}</code><button type="button" class="btn btn--ghost btn--sm" data-action="copy-ref" data-ref="${esc(r.ref)}">复制</button>${copiedNote}</dd></div>
      <div class="kv"><dt>类型</dt><dd>${esc(r.kind)}</dd></div>
      <div class="kv"><dt>状态</dt><dd>${esc(r.status)}</dd></div>
      <div class="kv"><dt>发生时间</dt><dd>${esc(formatTimestamp(r.occurredAt))}</dd></div>
      <div class="kv"><dt>摘要</dt><dd class="mono" title="${esc(r.digest)}">${esc(digestHead(r.digest))}</dd></div>
    </dl>
    <p class="hint">payload（JSON 美化${pretty.length > EVIDENCE_PAYLOAD_COLLAPSE_CHARS ? `，${pretty.length} 字符默认折叠` : ''}）</p>
    ${payloadBlock}`,
  });
}

export function observeEvidenceHtml(s: EvidenceUiState): string {
  const header = pageHeaderHtml({ view: 'observe-evidence', title: '观测·夔牛·证据' });
  const toast = s.errorText ? toastHtml(`${s.errorText}${s.errorCode ? `（${s.errorCode}）` : ''}`, 'error') : '';
  const errorBar = s.errorText
    ? `<div class="error-state" role="alert">${s.errorCode ? `<span class="error-state__code">${esc(s.errorCode)}</span>` : ''}<p class="error-state__message">${esc(s.errorText)}</p></div>`
    : '';
  const result = s.result ? resultHtml(s) : (s.errorText ? '' : cardHtml({ title: '查询结果', body: emptyStateHtml({ title: '尚未查询', hint: '输入证据引用（ref）后回车或点击查询' }) }));
  return `${observeTabsHtml('observe-evidence')}${header}${toast}${searchCardHtml(s)}${errorBar}${result}`;
}
