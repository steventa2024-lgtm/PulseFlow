import type { Item } from '@pulseflow/contracts';
import { NodeError } from '@pulseflow/engine';
import { cloneJson, defineNode, requireString, setPath } from './helpers';
import { throwForStatus } from './network';

const TASK_PROMPTS: Record<string, (input: string, extra: string) => string> = {
  summarize: (input, extra) => `Summarize the following text in clear Markdown bullet points.${extra ? ` ${extra}` : ''}\n\n--- TEXT START ---\n${input}\n--- TEXT END ---`,
  classify: (input, labels) =>
    `Classify the text into exactly one of these labels: ${labels}. Reply with only the label.\n\n--- TEXT START ---\n${input}\n--- TEXT END ---`,
  extract: (input, extra) => `Extract the following information as a JSON object: ${extra || 'key facts'}. Reply with JSON only.\n\n--- TEXT START ---\n${input}\n--- TEXT END ---`,
  generate: (input, extra) => `${extra}\n\n${input}`.trim(),
};

export const ollamaNode = defineNode(
  {
    type: 'ai.ollama',
    displayName: 'Local AI (Ollama)',
    description:
      'Summarize, classify, extract or generate text with a model running locally in Ollama. Optional: requires Ollama installed and a model pulled (e.g. llama3.2:3b needs ~2–3 GB RAM/VRAM).',
    category: 'ai',
    icon: 'Sparkles',
    permissions: ['network'],
    status: 'requires-setup',
    parameters: [
      { name: 'baseUrl', label: 'Ollama URL', type: 'string', default: 'http://127.0.0.1:11434' },
      { name: 'model', label: 'Model', type: 'string', default: 'llama3.2:3b', required: true },
      {
        name: 'task',
        label: 'Task',
        type: 'select',
        default: 'summarize',
        noExpression: true,
        options: [
          { label: 'Summarize', value: 'summarize' },
          { label: 'Classify', value: 'classify' },
          { label: 'Extract JSON', value: 'extract' },
          { label: 'Generate', value: 'generate' },
        ],
      },
      { name: 'input', label: 'Input text', type: 'text', default: '{{ $json.content }}' },
      { name: 'labels', label: 'Labels (comma separated)', type: 'string', showIf: { param: 'task', equals: ['classify'] } },
      { name: 'instructions', label: 'Instructions', type: 'text', default: '', showIf: { param: 'task', equals: ['summarize', 'extract', 'generate'] } },
      { name: 'target', label: 'Output field', type: 'string', default: 'ai', noExpression: true },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 180_000, noExpression: true },
      { name: 'maxInputChars', label: 'Max input characters', type: 'number', default: 20_000, noExpression: true },
    ],
  },
  async (ctx) => {
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const task = ctx.param<string>('task');
      const input = String(ctx.param('input', i) ?? '').slice(0, ctx.param<number>('maxInputChars'));
      const labels = String(ctx.param('labels', i) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (task === 'classify' && labels.length < 2) throw new NodeError('PARAM_REQUIRED', 'Provide at least two labels');
      const prompt = TASK_PROMPTS[task]!(input, task === 'classify' ? labels.join(', ') : String(ctx.param('instructions', i) ?? ''));
      const base = requireString(ctx.param('baseUrl', i), 'Ollama URL').replace(/\/+$/, '');
      const res = await ctx.services.http.request({
        method: 'POST',
        url: `${base}/api/generate`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: ctx.param('model', i), prompt, stream: false, ...(task === 'extract' ? { format: 'json' } : {}) }),
        timeoutMs: ctx.param<number>('timeoutMs'),
        signal: ctx.signal,
      }).catch((e: unknown) => {
        if (e instanceof NodeError && (e.code === 'HTTP_NETWORK_ERROR' || e.code === 'HTTP_TIMEOUT')) {
          throw new NodeError('OLLAMA_UNAVAILABLE', `Ollama is not reachable at ${base}. Install it from ollama.com and run "ollama pull <model>".`, { retryable: false });
        }
        throw e;
      });
      throwForStatus(res);
      const body = res.json() as { response?: string; model?: string; eval_count?: number; total_duration?: number };
      const text = String(body.response ?? '').trim();
      // Model output is untrusted data: never executed, and classification is constrained to the label set.
      let value: unknown = text;
      if (task === 'classify') {
        const match = labels.find((l) => l.toLowerCase() === text.toLowerCase()) ?? labels.find((l) => text.toLowerCase().includes(l.toLowerCase()));
        value = match ?? null;
      } else if (task === 'extract') {
        try {
          value = JSON.parse(text, (k, v: unknown) => (k === '__proto__' || k === 'constructor' ? undefined : v));
        } catch {
          throw new NodeError('AI_INVALID_JSON', 'Model did not return valid JSON');
        }
      }
      const json = cloneJson(ctx.items[i]!.json);
      setPath(json, ctx.param<string>('target') || 'ai', { task, result: value, model: body.model ?? ctx.param('model', i), tokens: body.eval_count ?? null });
      out.push({ json });
    }
    return { main: out };
  },
);

export const aiNodes = [ollamaNode];
