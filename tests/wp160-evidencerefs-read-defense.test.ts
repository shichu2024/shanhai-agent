import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { makeHarness, sampleSpec, registerAndRelease, validInput, type Harness } from './helpers.js';
import { buildAgentInsight, parseEvidenceRefs } from '../src/modules/insight.js';

// TASK-160（每日优化第十五批）：evidenceRefs 读面防御收口（cli.ts / modules/insight.ts 六处，
// TASK-157 终审备案 P3-2 裁量落地）。
// 语义基准与门户视图面（第十四批 src/portal/view/evidenceRefs.ts）一致：
//   JSON 数组 → 原样数组；malformed（parse 抛出）或合法 JSON 非数组形态（标量字符串/数字/布尔/
//   null/对象）→ 空数组（evidenceCount=0、evidencePending=无证据=true、引用计数跳过）。
// 写入面（capabilityRegistry / evolution）恒为 JSON 数组不动；正常数组形态输出语义零变化。

function dbOf(rt: unknown): Database.Database {
  return (rt as unknown as { db: Database.Database }).db;
}

function insightDeps(h: Harness) {
  const rt = h.rt as unknown as Harness['rt'];
  return {
    db: dbOf(rt),
    trace: rt.trace,
    registry: rt.registry,
    capabilities: rt.capabilities,
  };
}

/** 种子：发布 agent + 一条带真实 failure 证据的 capability（confirm → active）+ 一条无证据 candidate */
function seedRows(h: Harness, agentId: string): { activeId: string; candidateId: string } {
  const versionId = registerAndRelease(h.rt, sampleSpec({ agentId }));
  const taskId = h.rt.tasks.createTask(agentId, validInput, 't');
  const recordId = h.rt.failures.record({
    taskId, agentId, agentVersionId: versionId, attemptNo: 1,
    failureClass: 'Model', subClass: 'schema_violation',
    message: 'wp160 防御演示', expectedVsActual: { expected: 'ok', actual: 'x' },
  });
  const active = h.rt.capabilities.add({
    agentId, kind: 'capability', statement: '可稳定产出摘要', evidence: [`failure:${recordId}`], by: 'tester',
  });
  h.rt.capabilities.confirm(active.capabilityId, 'human');
  const candidate = h.rt.capabilities.add({
    agentId, kind: 'limitation', statement: '长文截断风险草稿', evidence: [], by: 'tester',
  });
  return { activeId: active.capabilityId, candidateId: candidate.capabilityId };
}

function setRefs(h: Harness, capabilityId: string, raw: string): void {
  dbOf(h.rt).prepare('UPDATE capability_registry SET evidenceRefs = ? WHERE capabilityId = ?').run(raw, capabilityId);
}

describe('TASK-160 parseEvidenceRefs 纯函数（四形态语义基准）', () => {
  it('正常数组 → 原样返回（元素形态不碰）', () => {
    const arr = [{ kind: 'failure', id: 'r-1' }, { kind: 'task', id: 't-1' }];
    expect(parseEvidenceRefs(JSON.stringify(arr))).toEqual(arr);
  });

  it('空数组 → []', () => {
    expect(parseEvidenceRefs('[]')).toEqual([]);
  });

  it('malformed → []（不抛）', () => {
    expect(parseEvidenceRefs('{"broken')).toEqual([]);
    expect(parseEvidenceRefs('not-json')).toEqual([]);
  });

  it('合法 JSON 标量字符串 → []（不逐字符迭代）', () => {
    expect(parseEvidenceRefs(JSON.stringify('abc'))).toEqual([]);
  });

  it('数字/布尔/null/对象形态 → []', () => {
    expect(parseEvidenceRefs('42')).toEqual([]);
    expect(parseEvidenceRefs('true')).toEqual([]);
    expect(parseEvidenceRefs('null')).toEqual([]);
    expect(parseEvidenceRefs('{"kind":"failure"}')).toEqual([]);
  });
});

describe('TASK-160 insight 报告关键路径（buildAgentInsight 不抛 + 语义正确）', () => {
  it('malformed 行：报告不抛、evidenceCount=0、引用计数跳过、candidate evidencePending 口径不变', () => {
    const h = makeHarness([]);
    const { activeId } = seedRows(h, 'wp160-bad');
    setRefs(h, activeId, '{"broken');
    const insight = buildAgentInsight(insightDeps(h), 'wp160-bad', {});
    const entry = insight.assertions.active.entries.find((e) => e.capabilityId === activeId);
    expect(entry).toBeDefined();
    expect(entry!.evidenceCount).toBe(0);
    expect(insight.limitations.evidenceSummary).toEqual({});
    // candidate 行 refs 仍为正常空数组 → pending 计入
    expect(insight.assertions.openCandidates.evidencePending).toBe(1);
  });

  it('合法 JSON 标量字符串行：evidenceCount=0（非字符串长度）、evidenceSummary 无污染键', () => {
    const h = makeHarness([]);
    const { activeId } = seedRows(h, 'wp160-scalar');
    setRefs(h, activeId, JSON.stringify('abc'));
    const insight = buildAgentInsight(insightDeps(h), 'wp160-scalar', {});
    const entry = insight.assertions.active.entries.find((e) => e.capabilityId === activeId);
    expect(entry!.evidenceCount).toBe(0); // 旧行为会是 3（逐字符迭代）
    expect(insight.limitations.evidenceSummary).toEqual({}); // 旧行为会写入 undefined 键
  });

  it('malformed candidate 行：evidencePending 按 0 证据=true 计入（同口径防御）', () => {
    const h = makeHarness([]);
    const { candidateId } = seedRows(h, 'wp160-pend');
    setRefs(h, candidateId, 'not-json');
    const insight = buildAgentInsight(insightDeps(h), 'wp160-pend', {});
    expect(insight.assertions.openCandidates.evidencePending).toBe(1);
  });

  it('空数组与正常数组：语义回归不变（evidenceCount/evidenceSummary/回归钉死）', () => {
    const h = makeHarness([]);
    const { activeId } = seedRows(h, 'wp160-ok');
    const insight = buildAgentInsight(insightDeps(h), 'wp160-ok', {});
    const entry = insight.assertions.active.entries.find((e) => e.capabilityId === activeId);
    expect(entry!.evidenceCount).toBe(1);
    const counts = Object.values(insight.limitations.evidenceSummary).reduce((s, n) => s + n, 0);
    expect(counts).toBe(1);
    expect(insight.assertions.openCandidates.evidencePending).toBe(1); // 空数组 candidate → pending
  });
});

describe('TASK-160 CLI 面（源契约机械断言，TASK-113 源契约先例同款）', () => {
  it('cli.ts capability list/add 输出面消费 parseEvidenceRefs，无裸 JSON.parse(x.evidenceRefs)', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/cli.ts'), 'utf8');
    expect(src).toContain('parseEvidenceRefs');
    expect(src).not.toMatch(/JSON\.parse\((?:r|row)\.evidenceRefs\)/);
  });

  it('insight.ts 三消费面（entryOf/引用计数/evidencePending）无裸 JSON.parse(r.evidenceRefs)', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/modules/insight.ts'), 'utf8');
    expect(src).toContain('export function parseEvidenceRefs');
    expect(src).not.toMatch(/JSON\.parse\(r\.evidenceRefs\)/);
  });
});
