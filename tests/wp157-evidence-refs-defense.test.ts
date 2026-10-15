// TASK-157（每日优化第十四批）：evidenceRefs 解析防御统一收口（TASK-151 终审备案）。
// 覆盖面：malformed JSON 字符串 / 合法 JSON 非数组形态（标量字符串、数字、布尔、字面量 null、对象）/ 空数组 / 正常数组，
// 逐函数覆盖：parseEvidenceRefs（统一辅助）/ capabilitySummary / evolutionSummary / capabilityListRow（api.ts 投影）。
// 列语义：evidenceRefs TEXT NOT NULL（db.ts:170/255）——null 列形态不存在，以 JSON 文本 "null" 形态覆盖。
// 语义基准：非数组形态一律视为无证据引用（evidenceCount=0 / evidenceRefs=[]），与 evidencePending 判定天然一致。
import { describe, expect, it } from 'vitest';

import { capabilityListRow } from '../src/portal/api.js';
import { capabilitySummary } from '../src/portal/view/capability.js';
import { parseEvidenceRefs } from '../src/portal/view/evidenceRefs.js';
import { evolutionSummary } from '../src/portal/view/evolution.js';
import type { CapabilityRow } from '../src/modules/capabilityRegistry.js';
import type { EvolutionCandidateRow } from '../src/modules/evolution.js';

const capRow = (evidenceRefs: string): CapabilityRow => ({
  capabilityId: 'cap-1',
  agentId: 'agent-a',
  kind: 'capability',
  statement: 's',
  origin: 'derived',
  evidenceRefs,
  statementDigest: 'd',
  status: 'candidate',
  createdAt: 't0',
  lastUpdatedAt: 't1',
  decidedAt: null,
  decidedBy: null,
});

const evoRow = (evidenceRefs: string): EvolutionCandidateRow => ({
  candidateId: 'c-1',
  agentId: 'agent-a',
  trigger: 'repeated_failure',
  evidenceRefs,
  status: 'open',
  proposedChange: null,
  createdAt: 't0',
  decidedAt: null,
  decidedBy: null,
  derivedVersionIds: '[]',
  dismissedAt: null,
});

describe('wp157 parseEvidenceRefs：统一解析辅助（非数组形态 → 空数组）', () => {
  it('malformed JSON 字符串 → []（不抛）', () => {
    expect(parseEvidenceRefs('{oops')).toEqual([]);
    expect(parseEvidenceRefs('[')).toEqual([]);
    expect(parseEvidenceRefs('')).toEqual([]);
  });

  it('合法 JSON 标量/对象形态 → []（字符串不取字符数当证据数）', () => {
    expect(parseEvidenceRefs('"abcdef"')).toEqual([]);
    expect(parseEvidenceRefs('5')).toEqual([]);
    expect(parseEvidenceRefs('true')).toEqual([]);
    expect(parseEvidenceRefs('null')).toEqual([]);
    expect(parseEvidenceRefs('{"taskId":"t"}')).toEqual([]);
  });

  it('数组形态 → 原样返回（长度与内容）', () => {
    expect(parseEvidenceRefs('[]')).toEqual([]);
    const refs = [{ kind: 'failure', id: 'f1' }, { kind: 'failure', id: 'f2' }];
    expect(parseEvidenceRefs(JSON.stringify(refs))).toEqual(refs);
  });
});

describe('wp157 capabilitySummary：malformed 不抛 + 非数组形态计 0（TASK-151 备案修复）', () => {
  it('malformed 字符串 → 不抛，evidenceCount=0，evidencePending=true', () => {
    const s = capabilitySummary(capRow('{oops'));
    expect(s.evidenceCount).toBe(0);
    expect(s.evidencePending).toBe(true);
    expect(s.statusLabel).toBe('待确认');
  });

  it('合法 JSON 标量字符串 → 计 0（不再取字符数 6）', () => {
    expect(capabilitySummary(capRow('"abcdef"')).evidenceCount).toBe(0);
  });

  it('字面量 null / 空数组 → 0；正常数组 → 实际长度', () => {
    expect(capabilitySummary(capRow('null')).evidenceCount).toBe(0);
    expect(capabilitySummary(capRow('[]')).evidenceCount).toBe(0);
    expect(capabilitySummary(capRow('[{"kind":"failure","id":"f1"},{"kind":"failure","id":"f2"}]')).evidenceCount).toBe(2);
    expect(capabilitySummary(capRow('[]')).evidencePending).toBe(true);
    expect(capabilitySummary(capRow('[{"kind":"failure","id":"f1"}]')).evidencePending).toBe(false);
  });

  it('非防御字段投影不变', () => {
    const s = capabilitySummary(capRow('[]'));
    expect(s.capabilityId).toBe('cap-1');
    expect(s.agentId).toBe('agent-a');
    expect(s.kind).toBe('capability');
  });
});

describe('wp157 evolutionSummary：非数组形态统一计 0（TASK-151 备案修复）', () => {
  it('malformed 字符串 → 0（既有 catch 语义保持）', () => {
    expect(evolutionSummary(evoRow('{oops')).evidenceCount).toBe(0);
  });

  it('合法 JSON 标量字符串 → 0（不再取字符数；备案实证 6 字符串 → 6）', () => {
    expect(evolutionSummary(evoRow('"abcdef"')).evidenceCount).toBe(0);
  });

  it('字面量 null / 数字 / 空数组 → 0；正常数组 → 实际长度', () => {
    expect(evolutionSummary(evoRow('null')).evidenceCount).toBe(0);
    expect(evolutionSummary(evoRow('5')).evidenceCount).toBe(0);
    expect(evolutionSummary(evoRow('[]')).evidenceCount).toBe(0);
    expect(evolutionSummary(evoRow('[{},{},{}]')).evidenceCount).toBe(3);
  });

  it('decided/状态标签投影不变', () => {
    const s = evolutionSummary(evoRow('[]'));
    expect(s.decided).toBe(false);
    expect(s.statusLabel).toBe('待裁决');
  });
});

describe('wp157 capabilityListRow（api.ts）：malformed 不抛 + 投影防御', () => {
  it('malformed 字符串 → evidenceRefs=[]、evidencePending=true（原直接抛）', () => {
    const row = capabilityListRow(capRow('{oops'));
    expect(row.evidenceRefs).toEqual([]);
    expect(row.evidencePending).toBe(true);
  });

  it('合法 JSON 标量字符串 → evidenceRefs=[]（不输出标量）', () => {
    expect(capabilityListRow(capRow('"abcdef"')).evidenceRefs).toEqual([]);
    expect(capabilityListRow(capRow('null')).evidenceRefs).toEqual([]);
  });

  it('数组形态原样投影（长度/内容/其余键不变）', () => {
    const refs = [{ kind: 'failure', id: 'f1' }];
    const row = capabilityListRow(capRow(JSON.stringify(refs)));
    expect(row.evidenceRefs).toEqual(refs);
    expect(row.evidencePending).toBe(false);
    expect(row.capabilityId).toBe('cap-1');
    expect(row.status).toBe('candidate');
  });
});
