import { chain, node, t, X, Y } from './builders';

export const B09 = t({
  id: 'B09',
  slug: 'social-media-automation-demo',
  name: 'Social Media Automation',
  description: 'Demo only: review sample social content and save local preview receipts. No real posts are published.',
  category: 'Content',
  tier: 'B',
  difficulty: 'beginner',
  triggerType: 'Manual',
  setupMinutes: 0,
  permissions: ['Read bundled sample posts', 'Write local preview receipts'],
  services: [],
  tags: ['social', 'content', 'demo'],
  demoOnly: true,
  demoOverrides: {},
  liveRequirements: 'Live social publishing is not implemented. This template is available only as a local demo.',
  variables: [{ name: 'reportFile', label: 'Demo receipt file', kind: 'file', default: '${templateDir}/social-demo-receipts.json', access: 'readwrite' }],
  sample: {
    input: 'Three synthetic content ideas; two marked approved.',
    output: 'social-demo-receipts.json — local previews with demo: true and published: false. No provider contacted.',
  },
  docs: 'The bundled loopback fixture returns synthetic sample posts. Approved entries are sent to a local preview sink, collected, and saved as a JSON report. Every receipt explicitly states published=false. There is no social account, provider credential, or live posting path. The demo does not claim publication.',
  workflow: {
    name: 'Social Media Automation',
    description: 'DEMO ONLY · Sample posts → approval filter → local preview sink → receipt file. No real publication.',
    graph: {
      schemaVersion: 1,
      nodes: [
        node('manual', 'core.manualTrigger', 'Start Demo', X(0), Y(1)),
        node('posts', 'core.httpRequest', 'Load Sample Posts', X(1), Y(1), {
          method: 'GET',
          url: '{{ $app.fixturesUrl }}/social/posts',
          responseFormat: 'json',
          splitPath: 'posts',
        }),
        node('approved', 'core.filter', 'Approved Samples', X(2), Y(1), {
          conditions: [{ left: '{{ $json.approved }}', operator: 'isTrue', right: '' }],
          combine: 'and',
        }),
        node('preview', 'core.httpRequest', 'Record Demo Preview', X(3), Y(1), {
          method: 'POST',
          url: '{{ $app.fixturesUrl }}/social/preview',
          bodyMode: 'json',
          body: '{{ $json }}',
          responseFormat: 'json',
        }),
        node('receipt', 'core.set', 'Demo Receipt', X(4), Y(1), {
          keepExisting: false,
          fields: [
            { name: 'demo', value: '{{ $json.body.demo }}' },
            { name: 'published', value: '{{ $json.body.published }}' },
            { name: 'status', value: '{{ $json.body.status }}' },
            { name: 'receiptId', value: '{{ $json.body.receiptId }}' },
            { name: 'content', value: '{{ $json.body.content }}' },
          ],
        }),
        node('collect', 'core.aggregate', 'Collect Demo Receipts', X(5), Y(1), { mode: 'collect', outputField: 'previews' }),
        node('save', 'core.fileWrite', 'Save Demo Receipts', X(6), Y(1), { path: '{{ $vars.reportFile }}', content: '{{ $json }}', mode: 'overwrite' }),
        node('log', 'core.log', 'Demo Complete', X(7), Y(1), {
          level: 'info',
          message: 'DEMO ONLY: local previews saved. No social media posts were published.',
        }),
      ],
      edges: chain('manual', 'posts', 'approved', 'preview', 'receipt', 'collect', 'save', 'log'),
    },
    settings: {},
  },
});
