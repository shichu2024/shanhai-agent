// 第七阶段批次三（7-3/4）：观测·女娲·演进详情控制器（设计 V0.3 §7.3 FR-O-3 详情五区）。
// GET /api/evolution/:id；只读，无轮询无写操作；404 not_found → 分类文案 + 返回列表出口。

import { apiGet } from './client.js';
import { explainFailure } from './errors.js';
import { parseEvolutionEvidenceRefs } from './observeData.js';
import { observeEvolutionDetailHtml, type EvolutionRowUi } from './observeEvolutionView.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { loadToken } from './token.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function mountObserveEvolutionDetailPage(ctx: PageCtx, id: string): PageHandle {
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
  let settled = false;

  function renderError(failure: { ok: false; kind: 'network' } | { ok: false; kind: 'http'; status: number; code: string; message: string }): void {
    const code = failure.kind === 'http' ? `<span class="error-state__code">${failure.code}</span>` : '';
    ctx.view.innerHTML = `<div class="error-state" role="alert">${code}<p class="error-state__message">${explainFailure(failure)}</p></div><p><a class="btn btn--secondary" href="#/observe/evolution">返回演进列表</a></p>`;
  }

  void (async (): Promise<void> => {
    const res = await apiGet(`/api/evolution/${encodeURIComponent(id)}`, deps);
    if (settled) return;
    if (!res.ok) {
      renderError(res);
      return;
    }
    const data = res.data;
    if (!isRecord(data) || typeof data.candidateId !== 'string') {
      renderError({ ok: false, kind: 'http', status: 0, code: 'unknown', message: '响应形状异常' });
      return;
    }
    const row: EvolutionRowUi = {
      candidateId: String(data.candidateId),
      agentId: typeof data.agentId === 'string' ? data.agentId : '',
      trigger: typeof data.trigger === 'string' ? data.trigger : '',
      status: typeof data.status === 'string' ? data.status : '',
      proposedChange: typeof data.proposedChange === 'string' ? data.proposedChange : null,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
      decidedAt: typeof data.decidedAt === 'string' ? data.decidedAt : null,
      decidedBy: typeof data.decidedBy === 'string' ? data.decidedBy : null,
    };
    const evidenceRefs = parseEvolutionEvidenceRefs(typeof data.evidenceRefs === 'string' ? data.evidenceRefs : null);
    ctx.view.innerHTML = observeEvolutionDetailHtml({ row, evidenceRefs });
  })();

  return {
    destroy(): void {
      settled = true; // 在途响应不再渲染（路由已切走）
    },
  };
}
