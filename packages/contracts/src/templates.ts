import { z } from 'zod';
import { WorkflowGraphSchema, WorkflowSettingsSchema, VariableValueSchema } from './workflow';

export const TemplateVariableSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  label: z.string(),
  kind: z.enum(['folder', 'file', 'string', 'url', 'number', 'boolean']),
  /** May contain `${demoDir}`, `${templateDir}` or `${fixturesUrl}` placeholders resolved at instantiation. */
  default: VariableValueSchema,
  description: z.string().default(''),
  /** Folder/file variables that need a filesystem grant. */
  access: z.enum(['read', 'readwrite']).optional(),
});
export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;

export const TemplateManifestSchema = z.object({
  id: z.string().regex(/^[AB][0-9]{2}$/),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  tier: z.enum(['A', 'B']),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  triggerType: z.string(),
  permissions: z.array(z.string()),
  services: z.array(z.string()),
  setupMinutes: z.number().int().min(0),
  tags: z.array(z.string()).default([]),
  variables: z.array(TemplateVariableSchema).default([]),
  /** Files (relative path → UTF-8 content) copied into the template's demo folder. */
  fixtures: z.record(z.string(), z.string()).default({}),
  /** Tier B only: what the user must provide to run live. */
  liveRequirements: z.string().optional(),
  /** Tier B only: variable overrides applied for the clearly separate "Try demo" mode. */
  demoOverrides: z.record(z.string(), VariableValueSchema).optional(),
  requiredCredentials: z.array(z.object({ type: z.string(), label: z.string() })).default([]),
  sample: z.object({ input: z.unknown(), output: z.string() }),
  docs: z.string(),
  workflow: z.object({
    name: z.string(),
    description: z.string(),
    graph: WorkflowGraphSchema,
    settings: WorkflowSettingsSchema.partial().default({}),
  }),
});
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

export type TemplateSummary = Omit<TemplateManifest, 'fixtures' | 'docs'> & { fixtureCount: number };
