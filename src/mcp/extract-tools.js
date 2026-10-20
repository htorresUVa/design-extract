// Live MCP tools: extract a URL as a background job, then read, diff, lint or
// export the finished design by job id. Pure over an injected job store, so
// tests run without a browser.

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createJobStore } from './jobs.js';
import { formatDtcgTokens } from '../formatters/dtcg-tokens.js';
import { formatTailwindV4 } from '../formatters/tailwind-v4.js';
import { formatShadcnTheme } from '../formatters/theme.js';
import { formatFigma } from '../formatters/figma.js';
import { importDesignSystem } from '../figma/importer.js';
import { formatCssVars } from '../formatters/css-vars.js';
import { formatDesignMd } from '../formatters/design-md.js';
import { diffDesigns } from '../diff.js';
import { lintTokens } from '../lint.js';

const EXPORTERS = {
  dtcg: formatDtcgTokens,
  tailwind: formatTailwindV4,
  shadcn: formatShadcnTheme,
  figma: formatFigma,
  css: formatCssVars,
  'design-md': formatDesignMd,
};

// Past this the script gets unwieldy as a single use_figma argument.
const FIGMA_SCRIPT_WARN_BYTES = 50 * 1024;

function rpcError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const jobIdOnly = {
  type: 'object',
  properties: { job_id: { type: 'string', description: 'id returned by extract_design' } },
  required: ['job_id'],
};

const TOOL_DEFS = [
  {
    name: 'extract_design',
    description: 'Extract the design system of a live URL in a real browser. Returns a job_id immediately; poll get_job_status, then pass the job_id to get_tokens, get_colors, get_typography, get_components, get_findings, compute_drift or export.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'page to extract, e.g. stripe.com' },
        width: { type: 'number', description: 'viewport width in px (default 1280)' },
        height: { type: 'number', description: 'viewport height in px (default 800)' },
        dark: { type: 'boolean', description: 'also extract the dark colour scheme' },
        wait: { type: 'number', description: 'extra ms to wait after load, for slow-hydrating sites' },
      },
      required: ['url'],
    },
  },
  { name: 'get_job_status', description: 'Status of an extraction job (running, done, failed, cancelled). A done job includes a short summary: primary colour, font families, counts.', inputSchema: jobIdOnly },
  { name: 'list_jobs', description: 'All extraction jobs in this session.', inputSchema: { type: 'object', properties: {} } },
  { name: 'cancel_job', description: 'Cancel a running extraction job; its result is discarded.', inputSchema: jobIdOnly },
  { name: 'get_tokens', description: 'W3C DTCG design tokens (primitive + semantic tiers) for a finished job.', inputSchema: jobIdOnly },
  { name: 'get_colors', description: 'Colour system for a finished job: primary/secondary/accent, backgrounds, text, full palette with usage.', inputSchema: jobIdOnly },
  { name: 'get_typography', description: 'Typography for a finished job: families, type scale, weights, line heights.', inputSchema: jobIdOnly },
  { name: 'get_components', description: 'Component styles for a finished job: buttons, inputs, cards, links and their variants.', inputSchema: jobIdOnly },
  {
    name: 'compute_drift',
    description: 'Compare two finished jobs (e.g. production vs a preview deploy): colours, typography, spacing, accessibility and components that changed.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'the current extraction' },
        baseline_job_id: { type: 'string', description: 'the extraction to compare against' },
      },
      required: ['job_id', 'baseline_job_id'],
    },
  },
  { name: 'get_findings', description: 'Design-system quality findings for a finished job: token lint (colour sprawl, scale consistency) and WCAG contrast summary.', inputSchema: jobIdOnly },
  {
    name: 'figma_plan',
    description: 'Build a use_figma script that creates the finished job\'s design system in a Figma file: variables with light/dark modes and aliases, text styles, effect styles and optionally a Button component. Does not touch Figma itself; run the returned script with the Figma MCP use_figma tool.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        components: { type: 'boolean', description: 'also build a Button component set (default true)' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'export',
    description: 'Render a finished job in a target format.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        format: { type: 'string', enum: Object.keys(EXPORTERS) },
      },
      required: ['job_id', 'format'],
    },
  },
];

function normalizeUrl(url) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function summarize(design) {
  return {
    title: design.meta?.title,
    primary: design.colors?.primary?.hex ?? null,
    fonts: (design.typography?.families || []).map((f) => f.name).slice(0, 5),
    colorCount: design.colors?.all?.length ?? 0,
    spacingBase: design.spacing?.base ?? null,
    accessibilityScore: design.accessibility?.score ?? null,
  };
}

export function buildExtractTools({ extract, jobs } = {}) {
  const store = jobs || createJobStore({
    extract: extract || (async (url, options) => (await import('../index.js')).extractDesignLanguage(url, options)),
  });

  function finished(jobId) {
    if (typeof jobId !== 'string') throw rpcError(-32602, 'job_id must be a string');
    const job = store.get(jobId);
    if (!job) throw rpcError(-32602, `unknown job_id: ${jobId}`);
    if (job.status === 'running') throw rpcError(-32002, `job ${jobId} is still running; poll get_job_status`);
    if (job.status !== 'done') throw rpcError(-32002, `job ${jobId} ${job.status}${job.error ? `: ${job.error}` : ''}`);
    return job.design;
  }

  function lint(design) {
    const dir = mkdtempSync(join(tmpdir(), 'designlang-findings-'));
    try {
      const file = join(dir, 'tokens.json');
      writeFileSync(file, JSON.stringify(formatDtcgTokens(design)));
      return lintTokens(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const dispatch = {
    extract_design(args) {
      if (typeof args.url !== 'string' || !args.url.trim()) throw rpcError(-32602, 'extract_design: url must be a non-empty string');
      const options = {};
      for (const k of ['width', 'height', 'wait']) if (typeof args[k] === 'number') options[k] = args[k];
      if (args.dark === true) options.dark = true;
      return store.start(normalizeUrl(args.url.trim()), options);
    },
    get_job_status(args) {
      const job = store.get(args.job_id);
      if (!job) throw rpcError(-32602, `unknown job_id: ${args.job_id}`);
      return { ...store.view(job), ...(job.status === 'done' && { summary: summarize(job.design) }) };
    },
    list_jobs() {
      return { jobs: store.list() };
    },
    cancel_job(args) {
      const view = store.cancel(args.job_id);
      if (!view) throw rpcError(-32602, `unknown job_id: ${args.job_id}`);
      return view;
    },
    get_tokens: (args) => formatDtcgTokens(finished(args.job_id)),
    get_colors: (args) => finished(args.job_id).colors,
    get_typography: (args) => finished(args.job_id).typography,
    get_components(args) {
      const design = finished(args.job_id);
      return { components: design.components, clusters: design.componentClusters };
    },
    compute_drift(args) {
      const current = finished(args.job_id);
      const baseline = finished(args.baseline_job_id);
      return diffDesigns(baseline, current);
    },
    get_findings(args) {
      const design = finished(args.job_id);
      return { lint: lint(design), accessibility: design.accessibility };
    },
    figma_plan(args) {
      const design = finished(args.job_id);
      const payload = JSON.parse(formatFigma(design));
      const components = args.components !== false;
      const script = `const payload=${JSON.stringify(payload)};\nreturn await (${importDesignSystem.toString()})(figma, payload, {components:${components}});`;
      const count = (k) => (payload[k] || []).length;
      const out = {
        script,
        summary: {
          collections: payload.collections.map((c) => ({ name: c.name, variables: c.variables.length })),
          textStyles: count('textStyles'),
          effectStyles: count('effectStyles'),
          buttonVariants: components ? payload.components.filter((c) => c.kind === 'button').length : 0,
          bytes: Buffer.byteLength(script),
        },
        instructions: 'Load the figma-use skill, call create_session for the target file, then pass `script` unchanged as the `code` argument of use_figma. Re-running is safe: collections, variables and styles are updated by name. Text styles fall back to Inter when the brand font is not installed; the result lists them in fontFallbacks.',
      };
      if (out.summary.bytes > FIGMA_SCRIPT_WARN_BYTES) {
        out.warning = `script is ${Math.round(out.summary.bytes / 1024)} KB; if use_figma rejects it, export format "figma" and paste the JSON into the designlang Figma plugin instead.`;
      }
      return out;
    },
    export(args) {
      const render = EXPORTERS[args.format];
      if (!render) throw rpcError(-32602, `export: format must be one of ${Object.keys(EXPORTERS).join('|')}`);
      const out = render(finished(args.job_id));
      return { format: args.format, content: typeof out === 'string' ? out : JSON.stringify(out, null, 2) };
    },
  };

  return {
    jobs: store,
    has: (name) => Object.hasOwn(dispatch, name),
    list: () => TOOL_DEFS.slice(),
    async call(name, args) {
      const fn = dispatch[name];
      if (!fn) throw rpcError(-32602, `Unknown tool: ${name}`);
      return await fn(args || {});
    },
  };
}
