import { defineConfig } from 'vitest/config';

// 覆盖率口径（TASK-44 批次一；第三阶段批次一口径微调）：核心运行时模块（modules/runtime/db/evidence/hash/types）。
// 排除项为两阶段一致的入口/适配层，非本批次实现面：
//   cli.ts（CLI 入口，阶段一即无单测）、experiment/*（实验 runner 脚本）、
//   providers/anthropic.ts + providers/types.ts（真实 Provider 适配，环境缺密钥不可执行——阶段一诚实声明沿用）、
//   config.ts（配置装载，走独立验证）。
// 第三阶段批次一（D-21）：releaseScan 扫描入口已函数化（runReleaseScanCli）并纳入覆盖率——
// scripts/* 自排除面移出（口径调整随批进 DoD 报告；既有排除面未放宽，只收紧）。
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // 覆盖率门禁（TASK-238 每日优化第三十批）：`npm test` 即生效（enabled: true），
      // statements 阈值从 coverage 数据（json-summary）计算，免疫 v5 text 报表
      // 省略行显示缺陷（TASK-174 备案 P3-①）。
      // 起步锚 95.5% = 当前基线 95.59% 减 0.09pp 保守余量；仅 statements 一列
      // （循环单调门锚），branches/lines 不设防避免结构性不可达噪声。
      // 阈值随基线上浮由后续批次调整：TASK-241 收紧至 95.55（余量 0.04pp）。
      // 逐文件地板门（TASK-243 每日优化第三十三批，TASK-174 备案 P3-① 落地）：
      // vitest v5 语义下根级 perFile: true 会使全局聚合阈值（95.55）逐文件执法，
      // 故逐文件门采用 glob 条目携带 perFile 对象形态（语义等价：匹配文件逐文件 statements 地板）。
      // 主地板 80：基线 f7c5009 实测（json-summary），排除下述备案例外后，
      // 最低真文件为 portal/ui/observeEvidencePage.ts 81.70%，地板 80 留 1.7pp 余量。
      // 备案例外（逐个说明，不为过门改测试；例外文件不设主地板）：
      //   src/types.ts —— 纯封闭集类型定义文件，唯一可执行语句（TERMINAL_STATUSES
      //     模块级 Set 常量）v8 口径实测 0/1，覆盖率统计结构性失真，不设地板。
      // TASK-244 棘轮第一档：contractSchema.ts 补齐低频拒绝分支用例后实测 100%
      // （124/124），专用例外条目（例外地板 74）回收删除，该文件并入主地板 glob。
      // TASK-245 目录兜底：modules glob 由单层 `src/modules/*.ts` 收敛为递归
      // `src/modules/**/*.ts`（** 匹配零或多层目录，对现行平铺文件集合语义等价）。
      // TASK-246 全树兜底收口（P2 备案转化）：逐文件地板 perFile glob 由
      // 「顶层 `src/!(types).ts` + 六目录递归」三条收敛为单条全树递归兜底
      // `src/**/!(types).ts`（** 匹配零或多层目录）——src 全树任意深度 .ts 文件
      // （含未来新建顶层目录）均落入主地板 80，消除「目录内递归、顶层新目录逃门」
      // 的最后执法空隙。语义等价实证：对现行 87 个执法文件（报告文件 88 减
      // src/types.ts）逐文件前后集合完全一致（tinyglobby 实测 + 全量跑门）。
      // 名义豁免面披露：`!(types)` 形态豁免任意目录下名为 types.ts 的文件——
      // 现行全树仅顶层 src/types.ts（既有例外，语义不变）与 src/providers/types.ts
      // （coverage exclude 既有排除面，本就不受地板执法）；嵌套 types.ts 现不存在，
      // 未来若新增将不受逐文件地板约束（仍受全局聚合门 95.55 约束）——结构性失真
      // 备案随 TASK-243 备案例外一并记录，不借本批扩大回收。
      enabled: true,
      thresholds: {
        statements: 95.55,
        'src/**/!(types).ts': { perFile: { statements: 80 } },
      },
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli.ts',
        'src/config.ts',
        'src/experiment/**',
        'src/providers/anthropic.ts',
        'src/providers/types.ts',
      ],
    },
  },
});
