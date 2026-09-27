import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// 第六阶段批次三（§4.3 / D-46 / P2-2 / P2-3 / P3-3）：resume 执行面——detached 子进程 spawn + 日志落盘 + 存活查询。
// 语义 ≡ CLI `task run --resume <id> --resumed-by manual-resume`：门户不执行任务主体，
// 只以同一命令行 spawn 独立 CLI 进程（入口 = path.resolve(process.argv[1])，复用 cli.ts approve-spawn 先例，
// 开发态/安装态同构）；Windows 平台事实：node 直启（process.execPath），不可 spawn .cmd。
// 门户进程内唯一运行时登记 = 日志文件索引（内存 map + 文件系统真源，§6 状态）。

/** 结构化错误（taskId 白名单违规等 → errormap 400） */
export class ResumeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ResumeError';
  }
}

/** taskId 白名单（P2-3）：防路径注入——首字符字母数字，限定 [A-Za-z0-9._-]，长度 ≤128 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isTaskIdSafe(taskId: string): boolean {
  return TASK_ID_RE.test(taskId);
}

function requireSafeTaskId(taskId: string): string {
  if (!isTaskIdSafe(taskId)) {
    throw new ResumeError(`taskId 含非法字符（白名单 [A-Za-z0-9._-]，收到：${taskId}）`, 'invalid_task_id');
  }
  return taskId;
}

/** CLI 入口解析（P2-2）：path.resolve(process.argv[1])——ts 直跑/dist 安装两形态同构 */
export function defaultCliEntry(): string {
  return path.resolve(process.argv[1] ?? 'dist/cli.js');
}

export interface ResumeSpawnResult {
  pid: number;
  logFile: string;
}

interface ResumeRecord {
  pid: number;
  logFile: string;
  startedAt: string;
}

export interface ResumeServiceOptions {
  dataDir: string;
  repoRoot: string;
  /** CLI 入口（缺省 defaultCliEntry()；测试可注入夹具脚本） */
  cliEntry?: string;
  /** 可执行（缺省 process.execPath——node 直启，Windows 不经 .cmd） */
  execPath?: string;
  /** Node 装载旗标（缺省 process.execArgv；测试可注入）——开发态（tsx 直跑）复现本进程装载器，dist 态为空数组 */
  execArgv?: string[];
}

export class ResumeService {
  private readonly entries = new Map<string, ResumeRecord>();

  constructor(private readonly opts: ResumeServiceOptions) {}

  /** 日志目录：data/portal/logs（与门户 Token 同级；不落业务数据，§3-5） */
  logsDir(): string {
    return path.join(this.opts.dataDir, 'portal', 'logs');
  }

  /**
   * detached spawn 续跑子进程（HTTP 不阻塞，§4.3）：
   * stdio 重定向到 resume-<taskId>-<hrtime>.log；env 显式钉 SHANHAI_DATA_DIR（子 CLI 打开同一库）；
   * cwd=repoRoot（子 CLI 的 repoRoot 语义与门户进程一致）。unref——子进程生命周期独立于门户。
   * 入口 = path.resolve(process.argv[1])（D-46/P2-2）；spawn 透传本进程 execArgv——
   * dist 形态为空数组（行为不变）；开发态（tsx 直跑）argv[1] 为 .ts 脚本，须复现本进程装载旗标方可执行
   * （Windows 假设 8 实测结论，node 直启不经 .cmd；零新依赖——旗标来自当前进程自身）。
   */
  spawnResume(taskId: string, by: string): ResumeSpawnResult {
    requireSafeTaskId(taskId);
    const dir = this.logsDir();
    mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, `resume-${taskId}-${process.hrtime.bigint().toString()}.log`);
    const fd = openSync(logFile, 'a');
    let child;
    try {
      child = spawn(
        this.opts.execPath ?? process.execPath,
        [
          ...(this.opts.execArgv ?? process.execArgv),
          this.opts.cliEntry ?? defaultCliEntry(),
          'task', 'run', '--resume', taskId, '--resumed-by', 'manual-resume', '--by', by,
        ],
        {
          detached: true,
          stdio: ['ignore', fd, fd],
          cwd: this.opts.repoRoot,
          env: { ...process.env, SHANHAI_DATA_DIR: this.opts.dataDir },
          windowsHide: true,
        },
      );
    } finally {
      closeSync(fd); // 子进程已复制句柄，父进程侧即关
    }
    const record: ResumeRecord = { pid: child.pid ?? -1, logFile, startedAt: new Date().toISOString() };
    this.entries.set(taskId, record); // 同任务多次 resume：最新一次胜出（A-36 重复 resume 语义）
    child.on('error', () => {
      /* spawn 失败：日志文件留空可查；任务状态以库为准（§5.2 失败路径） */
    });
    return { pid: record.pid, logFile };
  }

  /**
   * 最近一次 resume 日志：文件系统为真源，按 mtime 取最新 resume-<taskId>-<ns>.log（P2-3/P3-3——
   * 门户重启后内存 map 为空同样可查，即回落路径与常态同一条代码）；文件名形态精确匹配（尾段纯数字 ns），
   * taskId 相邻前缀任务不串档（t-m 不匹配 resume-t-m-2-9.log）。
   */
  readLog(taskId: string): { logFile: string; content: string } | null {
    requireSafeTaskId(taskId);
    const dir = this.logsDir();
    const nameRe = new RegExp(`^resume-${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.log$`);
    if (!existsSync(dir)) return null;
    let best: string | null = null;
    let bestMtime = -Infinity;
    for (const f of readdirSync(dir)) {
      if (!nameRe.test(f)) continue;
      const resolved = path.resolve(dir, f);
      if (!resolved.startsWith(dir + path.sep)) continue; // 目录前缀断言（防御性归一化校验）
      try {
        const mtimeMs = statSync(resolved).mtimeMs;
        if (mtimeMs > bestMtime) {
          bestMtime = mtimeMs;
          best = resolved;
        }
      } catch {
        continue; // 竞态删除等：跳过该候选
      }
    }
    if (best === null) return null;
    return { logFile: best, content: readFileSync(best, 'utf8') };
  }

  /** 存活查询（前端「已续跑」状态展示）：登记 pid + 日志位置；未登记 → null */
  statusOf(taskId: string): ResumeRecord | null {
    if (!isTaskIdSafe(taskId)) return null;
    return this.entries.get(taskId) ?? null;
  }
}
