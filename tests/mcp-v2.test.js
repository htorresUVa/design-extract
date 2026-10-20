import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildExtractTools } from '../src/mcp/extract-tools.js';

// A real extraction of example.com, so formatters see a genuine design shape.
const design = JSON.parse(readFileSync(new URL('./fixtures/example-design.json', import.meta.url), 'utf-8'));
const BIN = fileURLToPath(new URL('../bin/design-extract.js', import.meta.url));

async function extracted(extract = async () => design) {
  const t = buildExtractTools({ extract });
  const { job_id } = await t.call('extract_design', { url: 'example.com' });
  await t.jobs.get(job_id).promise;
  return { t, job_id };
}

describe('MCP live tools: jobs', () => {
  it('extract_design returns a running job and normalizes the URL', async () => {
    const seen = [];
    const t = buildExtractTools({ extract: async (url, opts) => { seen.push([url, opts]); return design; } });
    const res = await t.call('extract_design', { url: 'example.com', width: 390, dark: true });
    assert.equal(res.status, 'running');
    assert.ok(res.job_id);
    await t.jobs.get(res.job_id).promise;
    assert.deepEqual(seen, [['https://example.com', { width: 390, dark: true }]]);
  });

  it('get_job_status reports a summary once done', async () => {
    const { t, job_id } = await extracted();
    const status = await t.call('get_job_status', { job_id });
    assert.equal(status.status, 'done');
    assert.ok(status.finishedAt);
    assert.ok(Array.isArray(status.summary.fonts));
    assert.equal(status.summary.colorCount, design.colors.all.length);
  });

  it('refuses to read a job that is still running', async () => {
    const t = buildExtractTools({ extract: () => new Promise(() => {}) });
    const { job_id } = await t.call('extract_design', { url: 'example.com' });
    await assert.rejects(t.call('get_colors', { job_id }), /still running/);
  });

  it('surfaces a failed extraction', async () => {
    const { t, job_id } = await extracted(async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); });
    assert.equal((await t.call('get_job_status', { job_id })).status, 'failed');
    await assert.rejects(t.call('get_tokens', { job_id }), /ERR_NAME_NOT_RESOLVED/);
  });

  it('cancel_job discards the late result', async () => {
    let finish;
    const t = buildExtractTools({ extract: () => new Promise((r) => { finish = r; }) });
    const { job_id } = await t.call('extract_design', { url: 'example.com' });
    assert.equal((await t.call('cancel_job', { job_id })).status, 'cancelled');
    finish(design);
    await t.jobs.get(job_id).promise;
    assert.equal((await t.call('get_job_status', { job_id })).status, 'cancelled');
    await assert.rejects(t.call('get_colors', { job_id }), /cancelled/);
  });

  it('list_jobs lists every job', async () => {
    const { t } = await extracted();
    await t.call('extract_design', { url: 'example.org' });
    assert.equal((await t.call('list_jobs')).jobs.length, 2);
  });

  it('rejects unknown job ids and empty URLs', async () => {
    const t = buildExtractTools({ extract: async () => design });
    await assert.rejects(t.call('get_job_status', { job_id: 'nope' }), /unknown job_id/);
    await assert.rejects(t.call('extract_design', { url: '  ' }), /non-empty/);
  });
});

describe('MCP live tools: reading a finished job', () => {
  it('get_tokens returns DTCG tiers', async () => {
    const { t, job_id } = await extracted();
    const tokens = await t.call('get_tokens', { job_id });
    assert.ok(tokens.primitive && tokens.semantic);
  });

  it('get_colors, get_typography and get_components return their sections', async () => {
    const { t, job_id } = await extracted();
    assert.deepEqual(await t.call('get_colors', { job_id }), design.colors);
    assert.deepEqual(await t.call('get_typography', { job_id }), design.typography);
    assert.deepEqual((await t.call('get_components', { job_id })).components, design.components);
  });

  it('compute_drift reports a changed primary colour between two jobs', async () => {
    const changed = structuredClone(design);
    changed.colors.primary = { ...(changed.colors.primary || {}), hex: '#ff0000' };
    changed.colors.all = [...changed.colors.all, { hex: '#ff0000' }];
    const t = buildExtractTools({ extract: async (url) => (url.includes('preview') ? changed : design) });
    const base = await t.call('extract_design', { url: 'example.com' });
    const next = await t.call('extract_design', { url: 'preview.example.com' });
    await Promise.all([t.jobs.get(base.job_id).promise, t.jobs.get(next.job_id).promise]);
    const drift = await t.call('compute_drift', { job_id: next.job_id, baseline_job_id: base.job_id });
    const colors = drift.sections.find((s) => s.name === 'Colors');
    assert.ok(colors.onlyB.includes('#ff0000'));
  });

  it('get_findings returns lint results and the accessibility summary', async () => {
    const { t, job_id } = await extracted();
    const findings = await t.call('get_findings', { job_id });
    assert.ok(Array.isArray(findings.lint.findings));
    assert.deepEqual(findings.accessibility, design.accessibility);
  });

  it('export renders every format as text', async () => {
    const { t, job_id } = await extracted();
    for (const format of ['dtcg', 'tailwind', 'shadcn', 'figma', 'css', 'design-md']) {
      const out = await t.call('export', { job_id, format });
      assert.equal(out.format, format);
      assert.ok(typeof out.content === 'string' && out.content.length > 0, format);
    }
    await assert.rejects(t.call('export', { job_id, format: 'pdf' }), /format must be one of/);
  });

  it('figma_plan returns a script that runs against a figma global', async () => {
    const { t, job_id } = await extracted();
    const plan = await t.call('figma_plan', { job_id });
    assert.ok(t.list().some((d) => d.name === 'figma_plan'));
    assert.ok(plan.instructions.includes('use_figma'));
    assert.ok(plan.summary.collections.length > 0);

    const made = { collections: [], variables: [] };
    const figma = {
      currentPage: { children: [] },
      variables: {
        getLocalVariableCollectionsAsync: async () => made.collections,
        getLocalVariablesAsync: async () => made.variables,
        createVariableCollection: (name) => {
          const c = { id: `c${made.collections.length}`, name, modes: [{ modeId: 'm0', name: 'x' }], renameMode() {}, addMode: () => 'm1' };
          made.collections.push(c);
          return c;
        },
        createVariable: (name, col) => {
          const v = { id: `v${made.variables.length}`, name, variableCollectionId: col.id, setValueForMode() {}, setVariableCodeSyntax() {} };
          made.variables.push(v);
          return v;
        },
        createVariableAlias: (v) => ({ type: 'VARIABLE_ALIAS', id: v.id }),
      },
      getLocalTextStylesAsync: async () => [],
      getLocalEffectStylesAsync: async () => [],
      createTextStyle: () => ({}),
      createEffectStyle: () => ({}),
      listAvailableFontsAsync: async () => [],
      loadFontAsync: async () => {},
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const result = await new AsyncFunction('figma', plan.script)(figma);
    assert.equal(result.collections, plan.summary.collections.length);
    assert.ok(result.variables > 0);
  });

  it('figma_plan errors like other tools for unknown or running jobs', async () => {
    const t = buildExtractTools({ extract: () => new Promise(() => {}) });
    await assert.rejects(t.call('figma_plan', { job_id: 'nope' }), /unknown job_id/);
    const { job_id } = await t.call('extract_design', { url: 'example.com' });
    await assert.rejects(t.call('figma_plan', { job_id }), /still running/);
  });
});

describe('MCP server over stdio: v2', () => {
  function spawnServer() {
    return spawn(process.execPath, [BIN, 'mcp', '--output-dir', mkdtempSync(join(tmpdir(), 'designlang-mcp-'))]);
  }

  it('lists the live tools without any extraction on disk', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp', '--output-dir', mkdtempSync(join(tmpdir(), 'designlang-mcp-'))],
    });
    const client = new Client({ name: 'designlang-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ['extract_design', 'get_job_status', 'compute_drift', 'export', 'figma_plan', 'search_tokens']) {
        assert.ok(names.includes(n), n);
      }
      const res = await client.callTool({ name: 'get_job_status', arguments: { job_id: 'nope' } });
      assert.equal(res.isError, true);
    } finally {
      await client.close();
    }
  });

  it('serves an initialize that omits protocolVersion', async () => {
    const child = spawnServer();
    try {
      const reply = await new Promise((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (chunk) => {
          buf += chunk;
          const line = buf.split('\n').find((l) => l.trim());
          if (line && buf.includes('\n')) resolve(JSON.parse(line));
        });
        child.on('error', reject);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }) + '\n');
      });
      assert.equal(reply.error, undefined);
      assert.equal(typeof reply.result.protocolVersion, 'string');
    } finally {
      child.kill();
    }
  });
});
