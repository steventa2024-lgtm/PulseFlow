import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, useReactFlow, type EdgeProps, type NodeProps } from '@xyflow/react';
import { getNodeOutputsWithError } from '@pulseflow/contracts';
import { CircleSlash, Lock, X } from 'lucide-react';
import { memo, useState } from 'react';
import { cx } from '../components/ui';
import { duration, stateStyle } from '../lib/format';
import { CATEGORY_COLORS, NodeIcon } from '../lib/icons';
import { useEditor, type FlowNode as FlowNodeType } from './store';

const ROW = 22;
const HEADER = 52;

function FlowNodeView({ id, data, selected }: NodeProps<FlowNodeType>) {
  const n = data.instance;
  const entry = useEditor((s) => s.catalog.get(n.type));
  const run = useEditor((s) => s.runStates[id]);
  const color = CATEGORY_COLORS[entry?.category ?? 'data'] ?? '#3b82f6';
  const outputs = entry ? getNodeOutputsWithError(entry, n.parameters, n.onError) : [{ name: 'main' }];
  const inputs = entry?.inputs ?? [{ name: 'main' }];
  const isTrigger = !!entry?.trigger;
  const labeled = outputs.length > 1 || outputs.some((o) => o.name !== 'main');
  const st = run ? stateStyle(run.state) : null;

  return (
    <div
      data-testid={`node-${n.name}`}
      data-state={run?.state ?? 'idle'}
      className={cx(
        'group relative w-[228px] border bg-panel shadow-[0_6px_20px_rgb(0_0_0/0.35)] transition-[border-color,box-shadow]',
        isTrigger ? 'rounded-l-[26px] rounded-r-[14px]' : 'rounded-[14px]',
        selected ? 'border-accent shadow-[0_0_0_3px_rgb(59_130_246/0.25)]' : 'border-line-strong hover:border-[#3a4f6e]',
        run?.state === 'running' && 'pf-running border-accent',
        run?.state === 'failed' && 'border-bad',
        run?.state === 'succeeded' && !selected && 'border-ok/60',
        n.disabled && 'opacity-55',
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]" style={{ background: `${color}1f`, color, boxShadow: `inset 0 0 0 1px ${color}40` }}>
          <NodeIcon name={entry?.icon ?? 'Boxes'} size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-tight text-ink">{n.name}</div>
          <div className="truncate text-[11px] text-faint">{entry?.displayName ?? n.type}</div>
        </div>
        {n.disabled ? <CircleSlash size={14} className="text-faint" aria-label="Disabled" /> : null}
        {entry && !entry.enabled ? <Lock size={13} className="text-warn" aria-label="Advanced node disabled" /> : null}
      </div>

      {labeled ? (
        <div className="border-t border-line/70 py-1">
          {outputs.map((o) => (
            <div key={o.name} className={cx('pr-4 text-right text-[11px] leading-[22px]', o.name === 'error' ? 'text-bad' : 'text-muted')}>
              {o.label ?? o.name}
            </div>
          ))}
        </div>
      ) : null}

      {st && run ? (
        <div className={cx('flex items-center justify-between gap-2 rounded-b-[13px] border-t border-line/70 px-3 py-1 text-[11px]', st.text)}>
          <span className="flex items-center gap-1.5">
            <span className={cx('h-1.5 w-1.5 rounded-full', st.dot)} />
            {st.label}
            {run.attempt > 1 ? <span className="text-faint">· try {run.attempt}</span> : null}
          </span>
          <span className="text-faint">
            {run.items !== null ? `${run.items} item${run.items === 1 ? '' : 's'} · ` : ''}
            {duration(run.durationMs)}
          </span>
        </div>
      ) : null}

      {inputs.map((p, i) => (
        <Handle key={p.name} id={p.name} type="target" position={Position.Left} style={{ top: inputs.length === 1 ? 26 : 18 + i * ROW }} />
      ))}
      {outputs.map((p, i) => (
        <Handle
          key={p.name}
          id={p.name}
          type="source"
          position={Position.Right}
          style={labeled ? { top: HEADER + 5 + i * ROW + ROW / 2 } : { top: 26 }}
          className={p.name === 'error' ? '!border-bad' : undefined}
        />
      ))}
    </div>
  );
}

export const FlowNode = memo(FlowNodeView);

export function FlowEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, sourceHandleId } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const [hover, setHover] = useState(false);
  const { deleteElements } = useReactFlow();
  const isError = sourceHandleId === 'error';
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: isError ? '#ef4444' : selected ? '#3b82f6' : '#2fb8d3', strokeWidth: selected ? 2.5 : 2, opacity: 0.9 }} />
      <path d={path} fill="none" stroke="transparent" strokeWidth={18} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} />
      {hover || selected ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Delete connection"
            className="nodrag nopan absolute flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-raised text-muted hover:border-bad hover:text-bad"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onClick={() => void deleteElements({ edges: [{ id }] })}
          >
            <X size={11} />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
