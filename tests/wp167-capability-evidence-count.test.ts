import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { capRowsOf, mountObserveCapabilitiesPage } from '../src/portal/ui/observeCapabilitiesPage.js';
import type { PageCtx } from '../src/portal/ui/pageCtx.js';
import {
  fakeTimerHost,
  jsonResponse,
  makeSessionStorageStub,
  stubDoc,
  stubViewEl,
  type StubDoc,
  type StubEl,
} from './wp7-3-mount-stubs.js';

// TASK-167（第十八批 = D1 修复批）：能力矩阵证据列正常面渲染字面 undefined。
// 根因：capabilityListRow（api.ts:38-54）投影无 evidenceRefCount 键，视图读 r.evidenceRefCount
// 恒 undefined 上屏；capRowsOf 原样断言 API 行为 UI 模型（类型擦除掩盖缺键，7-3 引入）。
// 本批：控制器层显式投影（方案 1）——evidenceRefCount 派生自已防御解析的 evidenceRefs.length；
// 「API 行 → 单元格」映射测试钉死正常面计数断言，防再次类型擦除掩盖。

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

/** 严格复刻 capabilityListRow 实测投影（api.ts:38-54）——无 evidenceRefCount 键 */
function apiRow(partial: Partial<Record<string, unknown>> & { capabilityId: string }): Record<string, unknown> {
  return {
    capabilityId: 'cap-00001111',
    agentId: 'ag-1',
    kind: 'capability',
    origin: 'derived',
    statement: '能稳定完成 shell 调用',
    statementDigest: 'digest-abc',
    status: 'candidate',
    evidenceRefs: ['task:t-1', 'task:t-2'],
    evidencePending: false,
    createdAt: '2026-10-18T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    ...partial,
  };
}

describe('TASK-167 capRowsOf：API 行 → UI 模型显式投影（D1 修复）', () => {
  it('正常面：evidenceRefs 2 条 → evidenceRefCount=2（API 行无 evidenceRefCount 键也能派生）', () => {
    const rows = capRowsOf([apiRow({})]);
    expect(rows).toHaveLength(1);
    expect(rows[0].evidenceRefCount).toBe(2);
    expect(rows[0].evidencePending).toBe(false);
    expect(rows[0].capabilityId).toBe('cap-00001111');
  });

  it('单条证据 → evidenceRefCount=1（走查 B2 断言面：正常面应显示 1）', () => {
    const rows = capRowsOf([apiRow({ evidenceRefs: ['task:t-9'] })]);
    expect(rows[0].evidenceRefCount).toBe(1);
  });

  it('空证据（服务端 evidencePending=true）→ 计数 0 + pending 保持 true（既有「待补证据」行为不回退）', () => {
    const rows = capRowsOf([apiRow({ evidenceRefs: [], evidencePending: true })]);
    expect(rows[0].evidenceRefCount).toBe(0);
    expect(rows[0].evidencePending).toBe(true);
  });

  it('防御面：evidenceRefs 非数组（malformed/缺键）→ 计数 0 + pending 兜底 true', () => {
    const rows = capRowsOf([
      apiRow({ evidenceRefs: 'task:t-1 task:t-2', evidencePending: false }),
      apiRow({ capabilityId: 'cap-00002222', evidenceRefs: undefined, evidencePending: false }),
    ]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.evidenceRefCount).toBe(0);
      expect(r.evidencePending).toBe(true);
    }
  });

  it('非记录/缺必要键行仍被过滤；计数派生不破坏行过滤语义', () => {
    const rows = capRowsOf([null, 'x', { capabilityId: 1, status: 'candidate', agentId: 'ag' }, apiRow({})]);
    expect(rows).toHaveLength(1);
    expect(rows[0].capabilityId).toBe('cap-00001111');
  });

  it('非数组载荷 → 空数组（既有防御不回退）', () => {
    expect(capRowsOf(undefined)).toEqual([]);
    expect(capRowsOf({})).toEqual([]);
    expect(capRowsOf('nope')).toEqual([]);
  });
});

describe('TASK-167 挂载面：证据列单元格计数上屏（API 行 → 单元格）', () => {
  let view: StubEl;

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageStub({ 'shanhai-portal-token': 'tok-167' }));
    vi.stubGlobal('location', { hash: '#/observe/capabilities' });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function makeCtx(fetchImpl: (path: string) => Promise<Response>): PageCtx {
    view = stubViewEl();
    const doc = stubDoc();
    const { host } = fakeTimerHost();
    return {
      doc: doc as unknown as Document,
      view: view as unknown as HTMLElement,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timerHost: host,
      confirmBox: () => true,
      now: () => NOW,
    };
  }

  const fetchTwo = async (path: string): Promise<Response> => {
    if (path === '/api/tasks?limit=100') return jsonResponse({ tasks: [], total: 0 });
    if (path === '/api/capabilities') {
      return jsonResponse([
        apiRow({ capabilityId: 'cap-00001111', evidenceRefs: ['task:t-1'] }),
        apiRow({ capabilityId: 'cap-00002222', evidenceRefs: [], evidencePending: true }),
        apiRow({ capabilityId: 'cap-00003333', evidenceRefs: ['task:a', 'task:b', 'task:c'] }),
      ]);
    }
    throw new Error(`未预期的请求：${path}`);
  };

  it('正常面单元格显示数字计数（1/3），绝不上屏字面 undefined', async () => {
    const handle = mountObserveCapabilitiesPage(makeCtx(fetchTwo), {});
    await vi.waitFor(() => expect(view.innerHTML).toContain('cap-0000'));
    expect(view.innerHTML).toContain('<td>1</td>');
    expect(view.innerHTML).toContain('<td>3</td>');
    expect(view.innerHTML).not.toContain('undefined');
    expect(view.innerHTML).toContain('待补证据');
    handle.destroy();
  });
});
