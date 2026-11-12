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
      // 阈值随基线上浮由后续批次调整。
      enabled: true,
      thresholds: {
        statements: 95.5,
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
