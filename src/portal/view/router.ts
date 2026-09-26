// 第六阶段批次一（§4.4 / 假设 5 修订）：前端可纯函数化逻辑抽 TS 模块入覆盖分母。
// hash 路由解析（批次 6-1：tasks/approvals 两视图；后续批次扩视图注册表——女娲可插页面骨架，§4.5-4）。

export type PortalRoute =
  | { view: 'tasks' }
  | { view: 'task-detail'; id: string }
  | { view: 'approvals' }
  | { view: 'approval-detail'; id: string }
  | { view: 'not-found'; hash: string };

export function parseHash(hash: string): PortalRoute {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (h === '' || h === '/' || h === '/tasks') return { view: 'tasks' };
  const taskMatch = /^\/tasks\/([^/]+)$/.exec(h);
  if (taskMatch) return { view: 'task-detail', id: decodeURIComponent(taskMatch[1]) };
  if (h === '/approvals') return { view: 'approvals' };
  const approvalMatch = /^\/approvals\/([^/]+)$/.exec(h);
  if (approvalMatch) return { view: 'approval-detail', id: decodeURIComponent(approvalMatch[1]) };
  return { view: 'not-found', hash };
}
