import { z } from 'zod';
import { WorkflowGraphSchema, WorkflowSettingsSchema } from './workflow';

export const BUNDLE_FORMAT = 'pulseflow.bundle';
export const BUNDLE_FORMAT_VERSION = 1;

export const BundleWorkflowSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(''),
  tags: z.array(z.string().max(40)).max(30).default([]),
  graph: WorkflowGraphSchema,
  settings: WorkflowSettingsSchema.partial().default({}),
});

/** Portable export bundle. Never contains secrets or permission grants. */
export const WorkflowBundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  formatVersion: z.literal(BUNDLE_FORMAT_VERSION),
  manifest: z.object({
    exportedAt: z.string(),
    app: z.string(),
    appVersion: z.string(),
    workflowCount: z.number().int().min(0),
    checksum: z.string(),
  }),
  workflows: z.array(BundleWorkflowSchema).min(1).max(1000),
});
export type WorkflowBundle = z.infer<typeof WorkflowBundleSchema>;
