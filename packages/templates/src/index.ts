import { TemplateManifestSchema, type TemplateManifest, type TemplateSummary, type VariableValue } from '@pulseflow/contracts';
import { TIER_A } from './tier-a';
import { TIER_B, PLANNED_TEMPLATES, type PlannedTemplate } from './tier-b';

export { TIER_A, TIER_B, PLANNED_TEMPLATES, type PlannedTemplate };
export * from './builders';

export const TEMPLATES: TemplateManifest[] = [...TIER_A, ...TIER_B].map((tpl) => {
  const parsed = TemplateManifestSchema.safeParse(tpl);
  if (!parsed.success) throw new Error(`Template ${tpl.id} is invalid: ${parsed.error.message}`);
  return parsed.data;
});

const byKey = new Map<string, TemplateManifest>();
for (const tpl of TEMPLATES) {
  if (byKey.has(tpl.id) || byKey.has(tpl.slug)) throw new Error(`Duplicate template ${tpl.id}/${tpl.slug}`);
  byKey.set(tpl.id, tpl);
  byKey.set(tpl.slug, tpl);
}

export function getTemplate(idOrSlug: string): TemplateManifest | undefined {
  return byKey.get(idOrSlug);
}

export function summarize(tpl: TemplateManifest): TemplateSummary {
  const { fixtures, docs: _docs, ...rest } = tpl;
  return { ...rest, fixtureCount: Object.keys(fixtures).length };
}

export interface PlaceholderContext {
  demoDir: string;
  templateDir: string;
  fixturesUrl: string;
}

export function resolvePlaceholders(value: VariableValue, ctx: PlaceholderContext): VariableValue {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(demoDir|templateDir|fixturesUrl)\}/g, (_, k: keyof PlaceholderContext) => ctx[k]);
}

/** Resolves the variable values a template will be instantiated with, optionally in demo mode. */
export function resolveTemplateVariables(
  tpl: TemplateManifest,
  ctx: PlaceholderContext,
  opts: { demo?: boolean; overrides?: Record<string, VariableValue> } = {},
): Record<string, VariableValue> {
  const vars: Record<string, VariableValue> = {};
  for (const v of tpl.variables) vars[v.name] = resolvePlaceholders(v.default, ctx);
  if (opts.demo && tpl.demoOverrides) for (const [k, v] of Object.entries(tpl.demoOverrides)) vars[k] = resolvePlaceholders(v, ctx);
  for (const [k, v] of Object.entries(opts.overrides ?? {})) if (k in vars) vars[k] = v;
  return vars;
}
