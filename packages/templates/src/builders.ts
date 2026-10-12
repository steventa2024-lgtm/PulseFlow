import type { Edge, NodeInstance, RetryPolicy, TemplateManifest, TemplateVariable } from '@pulseflow/contracts';

type Defaulted = 'version' | 'tags' | 'requiredCredentials' | 'fixtures' | 'variables';
export type TemplateDraft = Omit<TemplateManifest, Defaulted> &
  Partial<Pick<TemplateManifest, Exclude<Defaulted, 'variables'>>> & {
    variables?: Array<Omit<TemplateVariable, 'description'> & { description?: string }>;
  };

export const t = (x: TemplateDraft): TemplateManifest =>
  ({
    version: '1.0.0',
    tags: [],
    requiredCredentials: [],
    fixtures: {},
    ...x,
    variables: (x.variables ?? []).map((v) => ({ description: '', ...v })),
  }) as TemplateManifest;

export function node(
  id: string,
  type: string,
  name: string,
  x: number,
  y: number,
  parameters: Record<string, unknown> = {},
  extra: { retry?: Partial<RetryPolicy>; onError?: 'stop' | 'continue' | 'route'; timeoutMs?: number; notes?: string } = {},
): NodeInstance {
  return { id, type, typeVersion: 1, name, position: { x, y }, parameters, ...extra };
}

export function edge(source: string, target: string, sourcePort = 'main', targetPort = 'main'): Edge {
  return { id: `e_${source}_${sourcePort}_${target}_${targetPort}`.slice(0, 64), source, sourcePort, target, targetPort };
}

export function chain(...ids: string[]): Edge[] {
  return ids.slice(1).map((id, i) => edge(ids[i]!, id));
}

/** Column positions used by templates so graphs read left → right. */
export const X = (col: number) => 80 + col * 260;
export const Y = (row: number) => 120 + row * 150;
