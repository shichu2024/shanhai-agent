# 门户 UI 设计 Token（冻结）

> 冻结基线：设计 V0.3 §10（`docs/phase7/01-山海门户界面重设计-V0.3.md`，终审 2026-10-01）。
> 实现载体：`src/portal/ui/styles.css`（CSS 变量，经 esbuild 打包直出 `src/portal/public/style.css`）。
> 本文件为 token 名录冻结档；变更须回溯设计文档修订，不得单方面改值。

## 颜色（§10.2）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-primary` | `#F8FAFC` | 页面背景 |
| `--bg-secondary` | `#FFFFFF` | 卡片/面板背景 |
| `--bg-tertiary` | `#F1F5F9` | 悬浮/次级区域 |
| `--border-primary` | `#E2E8F0` | 常规分隔线 |
| `--border-secondary` | `#CBD5E1` | 强调边框 |
| `--text-primary` | `#0F172A` | 主文本 |
| `--text-secondary` | `#475569` | 次级文本 |
| `--text-muted` | `#64748B` | 弱化文本（≈4.76:1，AA） |
| `--color-primary` | `#2563EB` | 主操作/链接 |
| `--color-primary-hover` | `#1D4ED8` | 主操作悬停 |
| `--color-danger` | `#DC2626` | 危险操作/错误（≈4.54:1，AA） |
| `--color-warning` | `#B45309` | 警示（≈5.02:1，AA） |
| `--color-success` | `#15803D` | 成功（≈5.02:1，AA） |
| `--color-info` | `#2563EB` | 提示（与主色共用，≈5.16:1，AA） |

任务状态七值色板（text/bg/border 三件套，`--st-<status>-fg/bg/bd`）：created=`#475569/#F1F5F9/#CBD5E1`；queued=`#64748B/#F1F5F9/#CBD5E1`；running=`#1D4ED8/#DBEAFE/#93C5FD`；paused=`#6D28D9/#EDE9FE/#C4B5FD`；succeeded=`#15803D/#DCFCE7/#86EFAC`；failed=`#B91C1C/#FEE2E2/#FCA5A5`；cancelled=`#4B5563/#E5E7EB/#D1D5DB`。

风险档 L0..L4：L0/L1=绿系、L2=琥珀、L3/L4=高危红加粗（复用 `--color-danger` 与 failed 色板）。

## 字体（§10.3）

| Token | 值 |
|---|---|
| `--font-ui` | `-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif` |
| `--font-mono` | `ui-monospace, "Cascadia Mono", Consolas, monospace` |

## 字号

| Token | 值 | 用途 |
|---|---|---|
| `--fs-xs` | 12px | 辅助/标签 |
| `--fs-sm` | 13px | 正文 |
| `--fs-md` | 14px | 表格正文 |
| `--fs-lg` | 16px | 卡片标题 |
| `--fs-xl` | 20px | 页标题 |
| `--fs-2xl` | 24px | 统计卡数值 |

## 间距（4px 基准网格）

`--sp-1..--sp-8` = 4 / 8 / 12 / 16 / 24 / 32 px

## 圆角与阴影

| Token | 值 |
|---|---|
| `--r-sm` | 4px（按钮/输入） |
| `--r-md` | 6px（卡片） |
| `--r-full` | 9999px（徽章/状态点） |
| `--shadow-sm` | `0 1px 2px rgba(15,23,42,.06)`（卡片） |
| `--shadow-md` | `0 4px 12px rgba(15,23,42,.12)`（弹层/确认框） |

## 动效

仅过渡态 150ms ease（`--transition`）；`prefers-reduced-motion` 时全部禁用。
