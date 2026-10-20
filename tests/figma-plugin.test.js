import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { formatFigma } from '../src/formatters/figma.js';
import { importDesignSystem } from '../src/figma/importer.js';
import { buildPluginCode } from '../scripts/build-figma-plugin.mjs';

const design = JSON.parse(readFileSync(new URL('./fixtures/example-design.json', import.meta.url), 'utf-8'));

// A minimal in-memory Plugin API: just enough surface for the importer.
function makeFigma({ fonts = ['Inter|Regular', 'Inter|Medium', 'Inter|Semi Bold', 'Inter|Bold'] } = {}) {
  const collections = [];
  const variables = [];
  const textStyles = [];
  const effectStyles = [];
  const messages = [];
  const page = { children: [], appendChild(n) { this.children.push(n); } };
  const node = (type) => ({
    type, fills: [], children: [], bound: {},
    appendChild(n) { this.children.push(n); },
    setBoundVariable(k, v) { this.bound[k] = v; },
  });
  const figma = {
    showUI() {},
    notify() {},
    closePlugin() {},
    ui: { postMessage: (m) => messages.push(m) },
    currentPage: page,
    variables: {
      createVariableCollection(name) {
        const col = {
          id: `c${collections.length}`, name, variables: [], modes: [{ modeId: 'm0', name: 'Mode 1' }],
          renameMode(id, n) { this.modes.find((m) => m.modeId === id).name = n; },
          addMode(n) { const modeId = `m${this.modes.length}`; this.modes.push({ modeId, name: n }); return modeId; },
        };
        collections.push(col);
        return col;
      },
      createVariable(name, col, type) {
        const v = {
          id: `v${variables.length}`, name, type, variableCollectionId: col.id, values: {}, scopes: ['ALL_SCOPES'], codeSyntax: {},
          setValueForMode(id, val) { this.values[id] = val; },
          setVariableCodeSyntax(platform, val) { this.codeSyntax[platform] = val; },
        };
        v.valuesByMode = v.values;
        col.variables.push(v);
        variables.push(v);
        return v;
      },
      createVariableAlias: (v) => ({ type: 'VARIABLE_ALIAS', id: v.id }),
      setBoundVariableForPaint: (paint, field, v) => ({ ...paint, boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: v.id } } }),
      getLocalVariableCollectionsAsync: async () => collections.slice(),
      getLocalVariablesAsync: async () => variables.slice(),
    },
    getLocalTextStylesAsync: async () => textStyles.slice(),
    getLocalEffectStylesAsync: async () => effectStyles.slice(),
    createTextStyle() { const s = { type: 'TEXT' }; textStyles.push(s); return s; },
    createEffectStyle() { const s = { type: 'EFFECT' }; effectStyles.push(s); return s; },
    // Only Inter can be loaded, like a file where the brand font isn't installed.
    loadFontAsync: async (f) => { if (f.family !== 'Inter') throw new Error(`font not loadable: ${f.family}`); },
    listAvailableFontsAsync: async () => fonts.map((f) => { const [family, style] = f.split('|'); return { fontName: { family, style } }; }),
    createComponent() { const n = node('COMPONENT'); page.children.push(n); return n; },
    createText() { return node('TEXT'); },
    combineAsVariants(comps, parent) {
      const set = node('COMPONENT_SET');
      set.children = comps;
      parent.children = parent.children.filter((c) => !comps.includes(c));
      parent.children.push(set);
      return set;
    },
  };
  return { figma, collections, variables, textStyles, effectStyles, messages, page };
}

// Runs figma-plugin/code.js against a fake `figma` global and returns what it created.
async function runPlugin(data, extra = {}) {
  const { figma, collections, messages } = makeFigma();
  vm.runInNewContext(readFileSync(new URL('../figma-plugin/code.js', import.meta.url), 'utf-8'), { figma, __html__: '' });
  await figma.ui.onmessage({ type: 'import', data, ...extra });
  return { collections, messages };
}

describe('figma plugin import', () => {
  it('imports the CLI formatFigma output', async () => {
    const payload = JSON.parse(formatFigma(design));
    const { collections, messages } = await runPlugin(payload);
    assert.equal(messages.at(-1).type, 'done');
    assert.equal(collections.length, payload.collections.length);
    const expected = payload.collections.reduce((n, c) => n + c.variables.length, 0);
    assert.equal(messages.at(-1).variableCount, expected);
    assert.ok(expected > 0);
  });

  it('creates one Figma mode per light/dark and sets both values', async () => {
    const payload = JSON.parse(formatFigma({ ...design, darkMode: { colors: { ...design.colors } } }));
    const { collections } = await runPlugin(payload);
    const brand = collections.find((c) => c.name === 'Brand');
    assert.deepEqual(brand.modes.map((m) => m.name), ['light', 'dark']);
    const primary = brand.variables.find((v) => v.name === 'color/primary');
    assert.equal(primary.type, 'COLOR');
    assert.equal(Object.keys(primary.values).length, 2);
  });

  it('still accepts the per-mode payload shape', async () => {
    const { collections, messages } = await runPlugin({
      collections: [{ name: 'X', modes: [{ name: 'a', variables: [{ name: 'n', type: 'FLOAT', value: 4 }] }] }],
    });
    assert.equal(messages.at(-1).variableCount, 1);
    assert.equal(collections[0].variables[0].values.m0, 4);
  });
});

// A design with a brand font that isn't installed, plus the pieces v2 adds.
const v2Design = {
  ...design,
  colors: { ...design.colors, primary: { hex: '#0066cc' }, backgrounds: ['#ffffff'], text: ['#111111'], neutrals: [{ hex: '#dddddd' }] },
  typography: {
    ...design.typography,
    families: [{ name: 'Playfair Display', count: 5, usage: 'all' }],
    roleScale: [
      { size: 40, weight: '700', lineHeight: '48px', letterSpacing: 'normal', role: 'h1' },
      { size: 16, weight: '400', lineHeight: 'normal', letterSpacing: 'normal', role: 'body' },
    ],
  },
  shadows: { values: [{ label: 'sm', layers: [{ offsetX: 0, offsetY: 1, blur: 2, spread: 0, color: 'rgba(0,0,0,0.2)', inset: false }] }] },
  components: { buttons: { variants: [{ variant: 'primary', backgroundColor: 'rgb(0, 102, 204)', style: { color: 'rgb(255, 255, 255)', paddingTop: '8px', paddingRight: '16px', borderRadius: '4px' } }] } },
};

describe('figma importer v2', () => {
  it('resolves aliases to the Brand variables', async () => {
    const f = makeFigma();
    const res = await importDesignSystem(f.figma, JSON.parse(formatFigma(v2Design)), {});
    const brand = f.collections.find((c) => c.name === 'Brand');
    const color = f.collections.find((c) => c.name === 'Color');
    assert.ok(color);
    const action = color.variables.find((v) => v.name === 'color/action/primary');
    const target = brand.variables.find((v) => v.name === 'color/primary');
    assert.deepEqual(action.values.m0, { type: 'VARIABLE_ALIAS', id: target.id });
    assert.deepEqual(target.scopes, []);
    assert.equal(target.codeSyntax.WEB, 'var(--color-primary)');
    assert.equal(res.collections, f.collections.length);
    assert.equal(res.variables, f.variables.length);
    assert.equal(res.effectStyles, 1);
    assert.equal(f.effectStyles[0].effects[0].type, 'DROP_SHADOW');
  });

  it('falls back to Inter for missing brand fonts and reports it', async () => {
    const f = makeFigma();
    const res = await importDesignSystem(f.figma, JSON.parse(formatFigma(v2Design)), {});
    assert.equal(f.textStyles.length, 2);
    const h1 = f.textStyles.find((s) => s.name === 'Display/h1');
    assert.deepEqual(h1.fontName, { family: 'Inter', style: 'Bold' });
    assert.deepEqual(h1.lineHeight, { value: 48, unit: 'PIXELS' });
    assert.equal(h1.description, 'Brand font: Playfair Display (fallback Inter)');
    assert.deepEqual(f.textStyles.find((s) => s.name === 'Body/md').lineHeight, { unit: 'AUTO' });
    assert.equal(res.fontFallbacks.length, 2);
    assert.equal(res.fontFallbacks[0].wanted, 'Playfair Display');
  });

  it('is idempotent: a second run creates nothing new', async () => {
    const f = makeFigma();
    const payload = JSON.parse(formatFigma(v2Design));
    await importDesignSystem(f.figma, payload, { components: true });
    const counts = () => [f.collections.length, f.variables.length, f.textStyles.length, f.effectStyles.length, f.page.children.length];
    const first = counts();
    await importDesignSystem(f.figma, payload, { components: true });
    assert.deepEqual(counts(), first);
  });

  it('builds a Button component set only when asked', async () => {
    const off = makeFigma();
    const payload = JSON.parse(formatFigma(v2Design));
    assert.equal((await importDesignSystem(off.figma, payload, {})).components, 0);
    assert.equal(off.page.children.length, 0);

    const on = makeFigma();
    const res = await importDesignSystem(on.figma, payload, { components: true });
    assert.equal(res.components, 1);
    const set = on.page.children[0];
    assert.equal(set.type, 'COMPONENT_SET');
    assert.equal(set.name, 'Button');
    const fill = set.children[0].fills[0];
    assert.ok(fill.boundVariables.color.id);
  });

  it('still imports v1 payloads without v2 keys', async () => {
    const f = makeFigma();
    const res = await importDesignSystem(f.figma, { collections: [{ name: 'X', modes: [{ name: 'a', variables: [{ name: 'n', type: 'FLOAT', value: 4 }] }] }] }, {});
    assert.equal(res.variables, 1);
    assert.equal(res.textStyles, 0);
  });

  it('rejects a payload without collections', async () => {
    await assert.rejects(importDesignSystem(makeFigma().figma, {}, {}), /No `collections`/);
  });
});

describe('figma plugin build', () => {
  it('committed code.js is fresh (run npm run build:figma-plugin)', () => {
    assert.equal(readFileSync(new URL('../figma-plugin/code.js', import.meta.url), 'utf-8'), buildPluginCode());
  });
});
