// 第七阶段批次一（7-1/4）：hash 路由表（设计 V0.3 §3.1——全文唯一权威定义的 TS 面）。
// 形态遵循预裁定：hash 路由（server.ts 静态未命中即 404、无 SPA fallback，直路由深链接不可行）。
// 旧观测族路由兼容 = 前端 location.replace 一次性改写（legacyRedirect），服务端零变更。

export type PortalUiRoute =
  | { view: 'tasks' }
  | { view: 'task-detail'; id: string }
  | { view: 'approvals' }
  | { view: 'approval-detail'; id: string }
  | { view: 'observe' }
  | { view: 'observe-capabilities' }
  | { view: 'observe-evolution' }
  | { view: 'observe-evolution-detail'; id: string }
  | { view: 'observe-evidence' }
  | { view: 'agents' }
  | { view: 'agent-detail'; id: string }
  | { view: 'not-found'; hash: string };

export type PortalUiView = PortalUiRoute['view'];

export interface ParsedHash {
  route: PortalUiRoute;
  /** hash 内查询串（FR-T-2 URL 同步 / FR-AG-5 agent 预选 / FR-O-4 ref 直查） */
  query: Record<string, string>;
}

function splitQuery(raw: string): { path: string; query: string } {
  const q = raw.indexOf('?');
  if (q < 0) return { path: raw, query: '' };
  return { path: raw.slice(0, q), query: raw.slice(q + 1) };
}

function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  for (const [key, value] of new URLSearchParams(query)) out[key] = value;
  return out;
}

export function parseHash(hash: string): ParsedHash {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const { path, query } = splitQuery(raw);
  const q = parseQuery(query);

  if (path === '' || path === '/' || path === '/tasks') return { route: { view: 'tasks' }, query: q };
  const task = /^\/tasks\/([^/]+)$/.exec(path);
  if (task) return { route: { view: 'task-detail', id: decodeURIComponent(task[1]) }, query: q };
  if (path === '/approvals') return { route: { view: 'approvals' }, query: q };
  const approval = /^\/approvals\/([^/]+)$/.exec(path);
  if (approval) return { route: { view: 'approval-detail', id: decodeURIComponent(approval[1]) }, query: q };
  if (path === '/observe') return { route: { view: 'observe' }, query: q };
  if (path === '/observe/capabilities') return { route: { view: 'observe-capabilities' }, query: q };
  if (path === '/observe/evolution') return { route: { view: 'observe-evolution' }, query: q };
  const evolution = /^\/observe\/evolution\/([^/]+)$/.exec(path);
  if (evolution) return { route: { view: 'observe-evolution-detail', id: decodeURIComponent(evolution[1]) }, query: q };
  if (path === '/observe/evidence') return { route: { view: 'observe-evidence' }, query: q };
  if (path === '/agents') return { route: { view: 'agents' }, query: q };
  const agent = /^\/agents\/([^/]+)$/.exec(path);
  if (agent) return { route: { view: 'agent-detail', id: decodeURIComponent(agent[1]) }, query: q };
  return { route: { view: 'not-found', hash }, query: q };
}

/**
 * 旧路由一次性改写（§3.1 兼容表）：返回新 hash（含 # 前缀）或 null（无需改写）。
 * #/capabilities → #/observe/capabilities；#/evolution[/:id] → #/observe/evolution[/:id]；#/evidence → #/observe/evidence。
 * 其余原形态保留（含未知 hash → not-found，现实现既有行为）。
 */
export function legacyRedirect(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const { path, query } = splitQuery(raw);
  let target: string | null = null;
  if (path === '/capabilities') target = '/observe/capabilities';
  else if (path === '/evolution') target = '/observe/evolution';
  else if (path === '/evidence') target = '/observe/evidence';
  else {
    const evolution = /^\/evolution\/([^/]+)$/.exec(path);
    if (evolution) target = `/observe/evolution/${evolution[1]}`;
  }
  if (target === null) return null;
  return `#${target}${query ? `?${query}` : ''}`;
}
