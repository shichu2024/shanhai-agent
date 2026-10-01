// 第七阶段批次三（7-3/4）：观测·夔牛·证据控制器（设计 V0.3 §7.4 FR-O-4）。
// 唯一数据源 GET /api/evidence/:ref；?ref= 直落（任务详情证据区 / 演进详情证据链接共用）；
// 非空校验前端本地；错误面 invalid_ref(400)/not_found(404) 按 FR-WR-5 口径
// toast + 页内错误条双呈现；复制按钮写剪贴板。无轮询（按需查询页）。

import { apiGet } from './client.js';
import { explainFailure, type ApiFailure } from './errors.js';
import { observeEvidenceHtml, type EvidenceResultRow, type EvidenceUiState } from './observeEvidenceView.js';
import type { PageCtx, PageHandle } from './pageCtx.js';
import { loadToken } from './token.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function resultRowOf(data: unknown): EvidenceResultRow | null {
  if (!isRecord(data) || typeof data.ref !== 'string' || typeof data.digest !== 'string') return null;
  return {
    ref: data.ref,
    kind: typeof data.kind === 'string' ? data.kind : '',
    status: typeof data.status === 'string' ? data.status : '',
    occurredAt: typeof data.occurredAt === 'string' ? data.occurredAt : '',
    digest: data.digest,
    payload: typeof data.payload === 'string' ? data.payload : '',
  };
}

export function mountObserveEvidencePage(ctx: PageCtx, query: Record<string, string>): PageHandle {
  const deps = { fetchImpl: ctx.fetchImpl, token: loadToken };
  const state: EvidenceUiState = {
    inputValue: query.ref ?? '',
    lastQuery: '',
    result: null,
    emptyInput: false,
    errorText: null,
    errorCode: null,
    copied: false,
    copyFailed: false,
    payloadExpanded: false,
    loading: false,
  };

  function render(): void {
    ctx.view.innerHTML = observeEvidenceHtml(state);
  }

  async function lookup(rawRef: string): Promise<void> {
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
        state.errorText = '响应形状异常（缺 ref/digest 键）';
        state.errorCode = 'unknown';
      }
    } else {
      const failure = res as ApiFailure;
      state.result = null;
      state.errorText = explainFailure(failure);
      state.errorCode = failure.kind === 'http' ? failure.code : null;
    }
    render();
  }

  function onSubmit(ev: Event): void {
    ev.preventDefault();
    const value = (ev.target as { value?: string } | null)?.value;
    if (typeof value === 'string' && value.length > 0) {
      state.inputValue = value;
      void lookup(value);
      return;
    }
    void lookup(state.inputValue); // 真实 DOM：submit target 为 form，回退输入态
  }

  function onInput(ev: Event): void {
    const value = (ev.target as { value?: string } | null)?.value;
    if (typeof value === 'string') state.inputValue = value;
  }

  function onClick(ev: Event): void {
    const target = ev.target as { closest?: (sel: string) => { dataset: Record<string, string> } | null } | null;
    const hit = target?.closest?.('[data-action]');
    if (!hit) return;
    const action = hit.dataset.action;
    if (action === 'evidence-search') {
      void lookup(state.inputValue);
    } else if (action === 'copy-ref') {
      const ref = hit.dataset.ref ?? '';
      state.copyFailed = false;
      state.copied = false;
      const nav = (globalThis as unknown as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator;
      const p = nav?.clipboard?.writeText?.(ref);
      if (p && typeof p.then === 'function') {
        void p.then(() => {
          state.copied = true;
          render();
        }, () => {
          state.copyFailed = true; // 剪贴板被拒/不可用：如实降级提示，不静默
          render();
        });
      } else {
        state.copyFailed = true;
        render();
      }
    } else if (action === 'expand-payload') {
      state.payloadExpanded = true;
      render();
    }
  }

  ctx.view.addEventListener('submit', onSubmit);
  ctx.view.addEventListener('input', onInput);
  ctx.view.addEventListener('click', onClick);

  render();
  if (query.ref && query.ref.length > 0) void lookup(query.ref); // ?ref= 直落

  return {
    destroy(): void {
      ctx.view.removeEventListener('submit', onSubmit);
      ctx.view.removeEventListener('input', onInput);
      ctx.view.removeEventListener('click', onClick);
    },
  };
}
