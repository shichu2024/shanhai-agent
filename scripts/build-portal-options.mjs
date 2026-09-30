import { readFileSync } from 'node:fs';

// 第七阶段批次一（7-1/4）：门户 UI 构建选项单一事实源（设计 V0.3 §9 方案 A）。
// scripts/build-portal.mjs（写盘）与 tests/wp7-1-portal-freshness.test.ts（write:false 逐字节比对）
// 共享本模块——选项漂移即新鲜度契约测试失败。
// 门禁形态不变（D-43 口径修订）：单文件 IIFE、零 CDN、无框架运行时、运行期零依赖。

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const PORTAL_ENTRIES = {
  app: 'src/portal/ui/main.ts',
  style: 'src/portal/ui/styles.css',
};

export const PORTAL_OUTDIR = 'src/portal/public';

export const PORTAL_BUILD_OPTIONS = {
  entryPoints: PORTAL_ENTRIES,
  outdir: PORTAL_OUTDIR,
  bundle: true,
  write: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  charset: 'utf8',
  legalComments: 'none',
  minify: false, // 不压缩：保留 consumeTokenFragment 镜像契约字面量
  sourcemap: false,
  logLevel: 'silent',
  define: {
    __PORTAL_APP_VERSION__: JSON.stringify(String(pkg.version)),
  },
};
