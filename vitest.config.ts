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
