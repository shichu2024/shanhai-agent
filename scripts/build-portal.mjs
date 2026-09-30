#!/usr/bin/env node
import { build } from 'esbuild';
import { PORTAL_BUILD_OPTIONS } from './build-portal-options.mjs';

// 第七阶段批次一（7-1/4）：门户 UI 构建入口（package.json scripts.build:portal）。
// 产物直出 src/portal/public/ 并提交入库（方案 A 条件①）；新鲜度契约测试逐字节比对（条件③）。

await build(PORTAL_BUILD_OPTIONS);
console.log('[build:portal] 山海门户 UI 构建完成 → src/portal/public/（app.js, style.css）');
