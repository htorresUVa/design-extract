// Figma Variables JSON format (compatible with Figma Variables import)
//
// Payload v2 adds scopes + codeSyntax on every variable, a `Color` collection
// of semantic aliases onto Brand, and top-level textStyles / effectStyles /
// components. v1 consumers read `collections` and ignore the rest.
import { parseColor, rgbToHsl } from '../utils.js';

const SPACING_SCOPES = ['GAP', 'WIDTH_HEIGHT'];

export function formatFigma(design) {
  const collections = [];

  // --- Brand collection (colors with light/dark modes) ---
  const brandVars = [];
  const hasDarkMode = !!design.darkMode;
  const brandModes = hasDarkMode ? ['light', 'dark'] : ['light'];
  // Brand holds primitives: hidden from pickers (scopes []), consumed through Color aliases.
  const brand = (name, values, css) => ({ name, type: 'COLOR', values, scopes: [], codeSyntax: { WEB: `var(--${css})` } });

  // Brand colors
  for (const role of ['primary', 'secondary', 'accent']) {
    const c = design.colors[role];
    if (!c) continue;
    const values = { light: colorVal(c.hex) };
    const dark = hasDarkMode && design.darkMode.colors?.[role];
    if (dark) values.dark = colorVal(dark.hex);
    else if (hasDarkMode) values.dark = values.light;
    brandVars.push(brand(`color/${role}`, values, `color-${role}`));
  }

  // Neutrals — labelled lightest-first (50 → 900) so the ladder reads like a ramp;
  // codeSyntax keeps pointing at the CSS var of the neutral's original usage index.
  const neutrals = design.colors.neutrals.slice(0, 10).map((n, i) => ({ n, i, l: rgbToHsl(hexToRgb(n.hex)).l }));
  neutrals.sort((a, b) => b.l - a.l);
  neutrals.forEach(({ n, i }, rank) => {
    const values = { light: colorVal(n.hex) };
    const dark = hasDarkMode && design.darkMode.colors?.neutrals?.[i];
    if (dark) values.dark = colorVal(dark.hex);
    else if (hasDarkMode) values.dark = values.light;
    brandVars.push(brand(`color/neutral/${rank * 100 || 50}`, values, `color-neutral-${i * 100 || 50}`));
  });

  // Semantic colors (backgrounds, text)
  const semantic = (key, list, cssKey, max) => {
    for (let i = 0; i < list.length && i < max; i++) {
      const label = i === 0 ? 'default' : `${i}`;
      const values = { light: colorVal(list[i]) };
      const dark = hasDarkMode && design.darkMode.colors?.[key]?.[i];
      if (dark) values.dark = colorVal(dark);
      else if (hasDarkMode) values.dark = values.light;
      brandVars.push(brand(`color/${key === 'backgrounds' ? 'background' : key}/${label}`, values, `color-${cssKey}${i > 0 ? `-${i}` : ''}`));
    }
  };
  semantic('backgrounds', design.colors.backgrounds, 'bg', Infinity);
  semantic('text', design.colors.text, 'text', 5);

  collections.push({ name: 'Brand', modes: brandModes, variables: brandVars });

  const colorVars = semanticAliases(brandVars, brandModes);
  if (colorVars.length > 0) collections.push({ name: 'Color', modes: brandModes, variables: colorVars });

  // --- Typography collection ---
  const typoVars = [];
  const roleScale = (design.typography.roleScale || []).slice(0, 14);
  const sizeCss = (size) => {
    const step = roleScale.find((r) => r.size === size);
    return `var(--font-size-${roleScale.length > 0 ? (step?.role ?? size) : size})`;
  };
  // Figma rejects "." in variable names, and a 0px size is an extraction artefact.
  const sizeKey = (size) => String(Math.round(size * 100) / 100).replace('.', '_');
  for (const s of design.typography.scale.filter((x) => x.size >= 1).slice(0, 12)) {
    typoVars.push({ name: `font/size/${sizeKey(s.size)}`, type: 'FLOAT', values: { default: s.size }, scopes: ['FONT_SIZE'], codeSyntax: { WEB: sizeCss(s.size) } });
    if (s.weight) {
      typoVars.push({ name: `font/weight/${sizeKey(s.size)}`, type: 'FLOAT', values: { default: parseInt(s.weight) || 400 }, scopes: ['FONT_WEIGHT'] });
    }
    if (s.lineHeight && s.lineHeight !== 'normal') {
      const lh = parseFloat(s.lineHeight);
      if (!isNaN(lh)) {
        typoVars.push({ name: `font/lineHeight/${sizeKey(s.size)}`, type: 'FLOAT', values: { default: lh }, scopes: ['LINE_HEIGHT'] });
      }
    }
  }
  if (typoVars.length > 0) {
    collections.push({ name: 'Typography', modes: ['default'], variables: typoVars });
  }

  // --- Spacing collection ---
  const spacingVars = [];
  for (const v of design.spacing.scale.slice(0, 20)) {
    spacingVars.push({ name: `spacing/${v}`, type: 'FLOAT', values: { default: v }, scopes: SPACING_SCOPES, codeSyntax: { WEB: `var(--spacing-${v})` } });
  }
  // Border radius
  // Extraction can yield one label for several values; Figma needs unique names, so later ones get the value appended.
  const radiusNames = new Set();
  for (const r of design.borders.radii) {
    const name = radiusNames.has(`radius/${r.label}`) ? `radius/${r.label}-${r.value}` : `radius/${r.label}`;
    radiusNames.add(name);
    spacingVars.push({ name, type: 'FLOAT', values: { default: r.value }, scopes: ['CORNER_RADIUS'], codeSyntax: { WEB: `var(--radius-${r.label})` } });
  }
  if (spacingVars.length > 0) {
    collections.push({ name: 'Spacing', modes: ['default'], variables: spacingVars });
  }

  return JSON.stringify({
    version: 2,
    meta: { url: design.meta?.url ?? null, fontFamilies: (design.typography.families || []).map((f) => f.name) },
    collections,
    textStyles: buildTextStyles(design),
    effectStyles: buildEffectStyles(design),
    components: buildComponents(design, brandVars, colorVars),
  }, null, 2);
}

const alias = (collection, name) => ({ type: 'VARIABLE_ALIAS', collection, name });

// Semantic `Color` collection: every value is an alias onto a Brand primitive.
// Roles whose target doesn't exist in this extraction are skipped.
function semanticAliases(brandVars, modes) {
  const byName = new Map(brandVars.map((v) => [v.name, v]));
  const has = (n) => byName.has(n);
  const light = (n) => byName.get(n).values.light;
  const lightness = (n) => rgbToHsl({ r: light(n).r * 255, g: light(n).g * 255, b: light(n).b * 255 }).l;

  let border = null;
  for (const v of brandVars) {
    if (!v.name.startsWith('color/neutral/')) continue;
    if (!border || Math.abs(lightness(v.name) - 85) < Math.abs(lightness(border) - 85)) border = v.name;
  }

  const map = [
    ['surface/page', 'color/background/default', ['FRAME_FILL', 'SHAPE_FILL']],
    ['surface/raised', 'color/background/1', ['FRAME_FILL', 'SHAPE_FILL']],
    ['text/primary', 'color/text/default', ['TEXT_FILL']],
    ['text/muted', 'color/text/1', ['TEXT_FILL']],
    ['action/primary', 'color/primary', ['FRAME_FILL', 'SHAPE_FILL']],
    ['action/secondary', 'color/secondary', ['FRAME_FILL', 'SHAPE_FILL']],
    ['border/default', border, ['STROKE_COLOR']],
    ['text/on-action', has('color/primary') ? bestContrast(brandVars, 'color/primary') : null, ['TEXT_FILL']],
  ];
  return map
    .filter(([, target]) => target && has(target))
    .map(([name, target, scopes]) => ({
      name: `color/${name}`,
      type: 'COLOR',
      values: Object.fromEntries(modes.map((m) => [m, alias('Brand', target)])),
      scopes,
    }));
}

// Brand colour with the highest WCAG contrast against `against` (light mode).
function bestContrast(brandVars, against) {
  const bg = luminance(brandVars.find((v) => v.name === against).values.light);
  let best = null;
  let bestRatio = 0;
  for (const v of brandVars) {
    if (v.name === against) continue;
    const l = luminance(v.values.light);
    const ratio = (Math.max(bg, l) + 0.05) / (Math.min(bg, l) + 0.05);
    if (ratio > bestRatio) { best = v.name; bestRatio = ratio; }
  }
  return best;
}

function luminance({ r, g, b }) {
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function roleToStyleName(role) {
  if (role === 'h1') return 'Display/h1';
  if (role === 'display') return 'Display/lg';
  if (/^h[2-6]$/.test(role)) return `Heading/${role}`;
  if (/^title-/.test(role)) return `Heading/${role}`;
  if (role === 'body') return 'Body/md';
  if (role === 'body-sm') return 'Body/sm';
  return `Caption/${role}`;
}

function buildTextStyles(design) {
  const families = design.typography.families || [];
  if (families.length === 0) return [];
  const headingFamily = (families.find((f) => f.usage === 'headings') || families[0]).name;
  const bodyFamily = (families.find((f) => f.usage === 'body' || f.usage === 'all') || families[0]).name;
  const styles = [];
  const seen = new Set();
  for (const step of (design.typography.roleScale || []).slice(0, 14)) {
    if (!step.role || !(step.size >= 1)) continue;
    const name = roleToStyleName(step.role);
    if (seen.has(name)) continue;
    seen.add(name);
    const isHeading = /^(h[1-6]|display|title-\d+)$/.test(step.role);
    const lh = step.lineHeight == null || step.lineHeight === 'normal' ? NaN : parseFloat(step.lineHeight);
    const ls = step.letterSpacing == null || step.letterSpacing === 'normal' ? NaN : parseFloat(step.letterSpacing);
    styles.push({
      name,
      fontFamily: isHeading ? headingFamily : bodyFamily,
      fontWeight: parseInt(step.weight) || 400,
      fontSize: step.size,
      // Unitless line heights are multipliers of the font size.
      lineHeight: isNaN(lh) ? null : (/px$/.test(String(step.lineHeight)) || lh > 8 ? lh : Math.round(lh * step.size * 100) / 100),
      letterSpacing: isNaN(ls) ? 0 : (/em$/.test(String(step.letterSpacing)) ? Math.round(ls * step.size * 100) / 100 : ls),
    });
  }
  return styles;
}

function buildEffectStyles(design) {
  const styles = [];
  const seen = new Set();
  for (const s of design.shadows?.values || []) {
    const name = `shadow/${s.label}`;
    if (!s.label || seen.has(name)) continue;
    const layers = s.layers?.length ? s.layers : [{ offsetX: s.offsetX, offsetY: s.offsetY, blur: s.blur, spread: s.spread, color: s.color, inset: s.inset }];
    const effects = [];
    for (const l of layers) {
      const c = parseColor(l.color);
      if (!c) continue;
      effects.push({
        type: l.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: { r: c.r / 255, g: c.g / 255, b: c.b / 255, a: c.a },
        offset: { x: l.offsetX || 0, y: l.offsetY || 0 },
        radius: l.blur || 0,
        spread: l.spread || 0,
      });
    }
    if (effects.length === 0) continue;
    seen.add(name);
    styles.push({ name, effects });
  }
  return styles;
}

// Component hints for the importer's optional Button. Fills resolve to a
// Brand / Color variable when the hex matches one, else stay a hex string.
function buildComponents(design, brandVars, colorVars) {
  const variants = design.components?.buttons?.variants || [];
  const hexOf = (v) => {
    const { r, g, b } = v.values.light;
    return '#' + [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  };
  const resolve = (css) => {
    const c = parseColor(css);
    if (!c || c.a === 0) return null;
    const hex = '#' + [c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
    const semanticHit = colorVars.find((v) => {
      const target = brandVars.find((b) => b.name === v.values.light.name);
      return target && hexOf(target) === hex;
    });
    if (semanticHit) return alias('Color', semanticHit.name);
    const hit = brandVars.find((v) => hexOf(v) === hex);
    return hit ? alias('Brand', hit.name) : hex;
  };
  const px = (v) => parseFloat(v) || 0;
  const out = [];
  for (const v of variants) {
    const fill = resolve(v.backgroundColor);
    const text = resolve(v.style?.color);
    if (!text) continue;
    out.push({
      kind: 'button',
      variant: v.variant,
      fill,
      text,
      paddingY: px(v.style.paddingTop),
      paddingX: px(v.style.paddingRight),
      radius: px(v.style.borderRadius),
    });
  }
  return out;
}

function colorVal(hex) {
  const rgb = hexToRgb(hex);
  return { r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255, a: 1 };
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
