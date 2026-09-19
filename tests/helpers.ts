import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Runtime } from '../src/runtime.js';
import { MockProvider, type MockScript } from '../src/providers/mock.js';

export const WHITELIST = ['mock-model'];

export interface Harness {
  rt: Runtime;
  provider: MockProvider;
  dataDir: string;
  repoRoot: string;
}

export function makeHarness(script: MockScript = [], repoRoot = process.cwd()): Harness {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'shanhai-test-'));
  const provider = new MockProvider([...script]);
  const rt = Runtime.withProvider(provider, WHITELIST, dataDir, repoRoot);
  rt.startup('test');
  return { rt, provider, dataDir, repoRoot };
}

/** 符合 A1/A2 且通过两层校验的最小 Spec 模板（C1/C3 用例基座） */
export function sampleSpec(overrides: {
  agentId?: string;
  tools?: { toolId: string; riskLevel: string; controlledFields?: unknown }[];
  modelPolicy?: Record<string, unknown>;
  outputContract?: Record<string, unknown>;
  inputContract?: Record<string, unknown>;
  extraTop?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    specVersion: '1',
    identity: {
      agentId: overrides.agentId ?? 'docs-analyst',
      name: '文档分析员',
      description: '对 docs/ 目录做只读分析并产出结构化摘要（C1 真实业务只读任务）',
      author: 'WP-B',
    },
    mission: {
      responsibilities: ['对指定文档集产出结构化摘要'],
      nonResponsibilities: ['修改任何文件内容'],
    },
    inputContract: overrides.inputContract ?? {
      type: 'object',
      properties: {
        topic: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    outputContract: overrides.outputContract ?? {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 500 },
        filesCovered: { type: 'integer', minimum: 0, maximum: 1000 },
        verdict: { type: 'string', enum: ['ok', 'needs-review'] },
      },
      required: ['summary', 'filesCovered', 'verdict'],
      additionalProperties: false,
    },
    modelPolicy: {
      allowedModels: ['mock-model'],
      maxModelCalls: 10,
      maxTokens: 100000,
      ...overrides.modelPolicy,
    },
    toolPolicy: {
      tools: overrides.tools ?? [{ toolId: 'docs-list', riskLevel: 'L0' }],
    },
    ...overrides.extraTop,
  };
}

export function validOutput(): Record<string, unknown> {
  return { summary: '覆盖 3 份规格文档，全部含冻结约束章节。', filesCovered: 3, verdict: 'ok' };
}

export function registerAndRelease(rt: Runtime, spec: Record<string, unknown>): string {
  const versionId = rt.registry.registerSpec(spec, 'test', validationDepsOf(rt));
  const agentId = (spec.identity as { agentId: string }).agentId;
  rt.registry.release(agentId, versionId, 'test');
  return versionId;
}

export function validationDepsOf(rt: Runtime) {
  return {
    getTool: (id: string) => {
      const t = rt.registry.getTool(id);
      return t ? { toolId: t.toolId, riskLevel: t.riskLevel, status: t.status, implVersion: t.implVersion, controlledFieldsSchema: t.controlledFieldsSchema } : null;
    },
    modelWhitelist: rt.gateway.modelWhitelist,
  };
}

export const validInput = { topic: '第一阶段设计文档定稿' };
