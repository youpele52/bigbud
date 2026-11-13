/**
 * Variable names agents commonly invent instead of bigbud's tokens, usually with a light-only
 * fallback such as var(--text-primary, #1f2937). Defining them keeps those visuals readable in
 * dark mode; any definition in the agent's own CSS comes later in the cascade and still wins.
 */
export const HTML_RENDER_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  "--text": "var(--foreground)",
  "--text-color": "var(--foreground)",
  "--text-primary": "var(--foreground)",
  "--color-text-primary": "var(--foreground)",
  "--text-secondary": "var(--muted-foreground)",
  "--text-muted": "var(--muted-foreground)",
  "--color-text-secondary": "var(--muted-foreground)",
  "--bg": "var(--background)",
  "--background-primary": "var(--background)",
  "--color-background-primary": "var(--background)",
  "--background-secondary": "var(--muted)",
  "--color-background-secondary": "var(--muted)",
  "--border-color": "var(--border)",
  "--color-border": "var(--border)",
  "--color-border-primary": "var(--border)",
  "--color-border-secondary": "var(--border)",
  "--color-border-tertiary": "var(--border)",
  "--link-color": "var(--primary)",
  "--color-link": "var(--primary)",
};

/** Elements painted with a bigbud token; inside them the aliases resolve to bigbud again. */
const OWN_SURFACE = "data-bigbud-own-surface";
const THEME_SURFACE = "data-bigbud-theme-surface";
const SURFACE_TOKENS = [
  "--background",
  "--card",
  "--muted",
  "--popover",
  "--secondary",
  "--accent",
];

export function buildHtmlRenderAliasRule(): string {
  const declarations = Object.entries(HTML_RENDER_TOKEN_ALIASES)
    .map(([name, value]) => `${name}:${value};`)
    .join(" ");
  return `:root, [${THEME_SURFACE}] { ${declarations} }`;
}

/**
 * Inner-document runtime (inside the bigbud IIFE). Aliases only make sense on bigbud's surfaces:
 * where the agent paints its own opaque background (e.g. a white card), unset aliases fall back
 * to the agent's own fallback colours, so its palette stays self-consistent. Names the agent
 * defines itself are never touched. Rescans are frame-throttled and ignore inline style churn.
 */
export function buildHtmlRenderSurfaceScript(): string {
  return `
const aliasNames = ${JSON.stringify(Object.keys(HTML_RENDER_TOKEN_ALIASES))};
const surfaceProbe = document.createElement('i');
surfaceProbe.setAttribute('data-bigbud', '');
surfaceProbe.hidden = true;
const surfaceResets = document.createElement('style');
surfaceResets.setAttribute('data-bigbud', '');
document.head.append(surfaceResets);
function colorAlpha(color) {
  const slash = color.match(/\\/\\s*([\\d.]+%?)\\s*\\)$/);
  if (slash) return slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
  const rgba = color.match(/^rgba\\((?:[^,]+,){3}\\s*([\\d.]+)\\)$/);
  return rgba ? parseFloat(rgba[1]) : 1;
}
function agentDefinedAliases() {
  const names = new Set();
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.style) for (const name of aliasNames) if (rule.style.getPropertyValue(name)) names.add(name);
      if (rule.cssRules) visit(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    if (sheet.ownerNode?.hasAttribute?.('data-bigbud')) continue;
    try { visit(sheet.cssRules); } catch {}
  }
  for (const element of document.querySelectorAll('[style]'))
    for (const name of aliasNames) if (element.style.getPropertyValue(name)) names.add(name);
  return names;
}
function refreshSurfaces() {
  if (!document.body || !surfaceProbe.isConnected) return;
  const defined = agentDefinedAliases();
  const resets = aliasNames.filter((name) => !defined.has(name)).map((name) => name + ':initial').join(';');
  const resetRule = resets ? '[${OWN_SURFACE}]{' + resets + '}' : '';
  if (surfaceResets.textContent !== resetRule) surfaceResets.textContent = resetRule;
  const surfaces = new Set(${JSON.stringify(SURFACE_TOKENS)}.map((token) => {
    surfaceProbe.style.backgroundColor = 'var(' + token + ')';
    return getComputedStyle(surfaceProbe).backgroundColor;
  }));
  for (const element of [document.body, ...document.body.querySelectorAll('*')]) {
    const background = getComputedStyle(element).backgroundColor;
    const opaque = colorAlpha(background) >= 0.5;
    const own = opaque && !surfaces.has(background);
    const theme = opaque && !own && element.parentElement?.closest('[${OWN_SURFACE}]') !== null;
    if (own !== element.hasAttribute('${OWN_SURFACE}')) element.toggleAttribute('${OWN_SURFACE}', own);
    if (theme !== element.hasAttribute('${THEME_SURFACE}')) element.toggleAttribute('${THEME_SURFACE}', theme);
  }
}`;
}
