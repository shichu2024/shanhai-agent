/**
 * TASK-127（每日优化第六批）：CLI 顶层命令族未知旗标 fail-fast（TASK-116 同族延伸）。
 *
 * 备案缺陷：main()（cli.ts）对顶层命令分发走 flagValue/rest.includes 逐个挑已知旗标，
 * 无任何未知旗标守卫——`shanhai task run <id> --resum`（手误少一字母）会静默忽略旗标、
 * 语义改变（本意 resume 却全新重跑），`--forc`/`--byy` 同理。
 *
 * 契约（对齐 portal 守卫 assertNoUnknownPortalTokens 模式）：
 * - 按命令族维护已知旗标白名单（值旗标+布尔旗标分列；--by 全命令通用——main 顶部统一消费）；
 * - 以 `--` 开头且不属于该命令已知集合的 token → fail-fast（错误含旗标名与该命令支持清单）；
 * - 值旗标消费模拟：被值旗标吞掉的下一 token 不算旗标名（取值形态留给既有 flagValue 语义）；
 * - 位置参数不守卫（顶层命令有位置参数面，与 portal 不同）；未收录命令键不守卫
 *   （未知命令/子命令仍由既有 usage() 分支处理，行为不变）。
 * 守卫在 cli.ts main() 中先于 Runtime.fromConfig 调用——未知旗标零副作用（不建库不写状态）。
 */

/** 命令旗标规格：值旗标（吞取值 token）与布尔旗标分列 */
export interface CommandFlagSpec {
  readonly valueFlags: readonly string[];
  readonly boolFlags: readonly string[];
}

/** --by 为全命令通用值旗标（main 顶部 `flagValue(rest, '--by')` 统一消费） */
const GLOBAL_VALUE_FLAGS: readonly string[] = ['--by'];

/** 嵌套子命令（第三段 op）：agent canary set/clear、tool mcp connect */
const NESTED_COMMANDS: readonly string[] = ['canary', 'mcp'];

/**
 * 顶层命令族旗标白名单（键 = `cmd sub [op]`，与 usage() 命令表逐一对照）。
 * 与 cli.ts 各分支实际消费的旗标一一对应——新增旗标须同步本表（源契约测试钉死键覆盖）。
 */
export const CLI_COMMAND_FLAGS: Record<string, CommandFlagSpec> = {
  'agent register': { valueFlags: ['--from-candidate'], boolFlags: [] },
  'agent release': { valueFlags: [], boolFlags: ['--no-pointer'] },
  'agent review': { valueFlags: [], boolFlags: [] },
  'agent deprecate': { valueFlags: [], boolFlags: [] },
  'agent rollback': { valueFlags: [], boolFlags: [] },
  'agent canary set': { valueFlags: ['--weight'], boolFlags: [] },
  'agent canary clear': { valueFlags: [], boolFlags: [] },
  'agent promote': { valueFlags: [], boolFlags: [] },
  'agent report': { valueFlags: ['--since'], boolFlags: [] },
  'agent list': { valueFlags: [], boolFlags: [] },
  'agent show': { valueFlags: [], boolFlags: [] },
  'agent card': { valueFlags: [], boolFlags: [] },
  'agent insight': { valueFlags: ['--since'], boolFlags: ['--json'] },
  'task create': { valueFlags: [], boolFlags: ['--draft', '--reviewed'] },
  'task run': { valueFlags: ['--strategy', '--resumed-by'], boolFlags: ['--resume'] },
  'task cancel': { valueFlags: [], boolFlags: ['--force'] },
  'task get': { valueFlags: [], boolFlags: [] },
  'approval list': { valueFlags: [], boolFlags: ['--pending'] },
  'approval show': { valueFlags: [], boolFlags: [] },
  'approval approve': { valueFlags: [], boolFlags: ['--detach'] },
  'approval deny': { valueFlags: ['--reason'], boolFlags: [] },
  'tool register': { valueFlags: ['--file'], boolFlags: [] },
  'tool list': { valueFlags: ['--kind', '--risk'], boolFlags: [] },
  'tool show': { valueFlags: [], boolFlags: [] },
  'tool retire': { valueFlags: [], boolFlags: [] },
  'tool mcp connect': { valueFlags: [], boolFlags: ['--yes'] },
  'memory list': { valueFlags: ['--agent'], boolFlags: [] },
  'evolution list': { valueFlags: [], boolFlags: [] },
  'evolution show': { valueFlags: [], boolFlags: [] },
  'evolution confirm': { valueFlags: ['--proposed-change'], boolFlags: [] },
  'evolution dismiss': { valueFlags: [], boolFlags: [] },
  'evidence show': { valueFlags: [], boolFlags: [] },
  'evidence task': { valueFlags: [], boolFlags: [] },
  'capability list': { valueFlags: ['--kind', '--status', '--agent'], boolFlags: [] },
  'capability add': { valueFlags: ['--kind', '--statement', '--statement-file', '--evidence'], boolFlags: [] },
  'capability confirm': { valueFlags: [], boolFlags: [] },
  'capability retire': { valueFlags: [], boolFlags: [] },
  'capability trend': { valueFlags: ['--since', '--until', '--bucket'], boolFlags: [] },
  'query t1': { valueFlags: [], boolFlags: [] },
  'query t2': { valueFlags: [], boolFlags: [] },
  'query t2p': { valueFlags: [], boolFlags: [] },
};

/**
 * 未知旗标守卫：对已收录命令键校验 rest 中全部 `--` token。
 * 未收录键（未知命令/子命令）直接返回——由既有 usage() 分支处理，行为不变。
 * 抛错形态与 portal 守卫一致（未知旗标：名 + 支持清单），由 main().catch 统一 JSON 化并 exit 1。
 */
export function assertNoUnknownCommandFlags(cmd: string, sub: string | undefined, rest: readonly string[]): void {
  let key = `${cmd} ${sub ?? ''}`;
  if (sub !== undefined && NESTED_COMMANDS.includes(sub)) {
    const op = rest.find((t) => !t.startsWith('--'));
    key = op === undefined ? `${cmd} ${sub} ` : `${cmd} ${sub} ${op}`;
  }
  const spec = CLI_COMMAND_FLAGS[key];
  if (spec === undefined) return; // 未收录键：不守卫（既有 usage() 行为）
  const valueFlags = [...GLOBAL_VALUE_FLAGS, ...spec.valueFlags];
  const supported = [...valueFlags, ...spec.boolFlags].join(' ');
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) continue; // 位置参数面不守卫
    if (valueFlags.includes(token)) {
      i++; // 值旗标消费模拟：下一 token 是取值（缺值/吞旗标形态留给既有 flagValue 语义）
      continue;
    }
    if (spec.boolFlags.includes(token)) continue;
    throw new Error(`未知旗标：${token}（shanhai ${key} 支持的旗标：${supported}）`);
  }
}
