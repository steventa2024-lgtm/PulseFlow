import { X } from 'lucide-react';
import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { create } from 'zustand';
import { stateStyle } from '../lib/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong border-transparent shadow-[0_0_0_1px_rgb(59_130_246/0.4)]',
  secondary: 'bg-raised text-ink hover:bg-hover border-line',
  ghost: 'bg-transparent text-muted hover:text-ink hover:bg-hover border-transparent',
  danger: 'bg-bad/10 text-bad hover:bg-bad/20 border-bad/30',
};

export function Button({ variant = 'secondary', size = 'md', className, icon, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 select-none whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={cx('inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-40', className)} {...rest}>
      {children}
    </button>
  );
}

const field = 'w-full rounded-lg border border-line bg-bg px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(field, 'h-8', className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(field, 'min-h-20 py-2 font-mono text-xs leading-relaxed', className)} spellCheck={false} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(field, 'h-8 pr-6', className)} {...rest}>
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50', checked ? 'border-accent bg-accent' : 'border-line-strong bg-raised')}
    >
      <span className={cx('inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  );
}

export function Label({ children, hint, htmlFor }: { children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
        {children}
      </label>
      {hint ? <span className="text-[11px] text-faint">{hint}</span> : null}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'violet' | 'cyan'; className?: string }) {
  const tones = {
    neutral: 'bg-raised text-muted border-line',
    accent: 'bg-accent/10 text-accent border-accent/30',
    ok: 'bg-ok/10 text-ok border-ok/30',
    warn: 'bg-warn/10 text-warn border-warn/30',
    bad: 'bg-bad/10 text-bad border-bad/30',
    violet: 'bg-violet/10 text-violet border-violet/30',
    cyan: 'bg-cyan/10 text-cyan border-cyan/30',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium leading-4', tones[tone], className)}>{children}</span>;
}

export function StateBadge({ state }: { state: string }) {
  const s = stateStyle(state);
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-md px-1.5 py-px text-[11px] font-medium', s.bg, s.text)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot, state === 'running' && 'animate-pulse')} />
      {s.label}
    </span>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('rounded-[14px] border border-line bg-panel', className)} {...rest}>
      {children}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 560, testId }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" data-testid={testId} className="flex max-h-[88vh] w-full flex-col rounded-2xl border border-line bg-panel shadow-2xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cx('flex items-center gap-0.5', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx('relative h-8 shrink-0 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors', value === t.id ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}
        >
          {t.label}
          {t.count ? <span className={cx('ml-1.5 rounded px-1 text-[10px]', value === t.id ? 'bg-accent/20 text-accent' : 'bg-raised text-faint')}>{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon ? <div className="mb-1 rounded-xl border border-line bg-raised p-3 text-muted">{icon}</div> : null}
      <div className="text-sm font-medium">{title}</div>
      {children ? <div className="max-w-md text-xs leading-relaxed text-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function JsonView({ value, maxHeight }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="overflow-auto rounded-lg border border-line bg-bg p-2.5 font-mono text-[11.5px] leading-relaxed text-muted" style={maxHeight ? { maxHeight } : undefined}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

interface Toast {
  id: number;
  tone: 'info' | 'ok' | 'bad';
  title: string;
  body?: string;
}
export const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; dismiss: (id: number) => void }>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.tone === 'bad' ? 8000 : 4000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
export const toast = {
  ok: (title: string, body?: string) => useToasts.getState().push({ tone: 'ok', title, ...(body ? { body } : {}) }),
  info: (title: string, body?: string) => useToasts.getState().push({ tone: 'info', title, ...(body ? { body } : {}) }),
  error: (title: string, err?: unknown) => useToasts.getState().push({ tone: 'bad', title, ...(err ? { body: err instanceof Error ? err.message : String(err) } : {}) }),
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('pointer-events-auto rounded-xl border bg-raised px-3.5 py-2.5 shadow-xl', t.tone === 'bad' ? 'border-bad/40' : t.tone === 'ok' ? 'border-ok/40' : 'border-line-strong')}>
          <div className="flex items-start justify-between gap-2">
            <div className={cx('text-[13px] font-medium', t.tone === 'bad' ? 'text-bad' : t.tone === 'ok' ? 'text-ok' : 'text-ink')}>{t.title}</div>
            <button type="button" aria-label="Dismiss" className="text-faint hover:text-ink" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
          {t.body ? <div className="mt-0.5 text-xs break-words text-muted">{t.body}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="inline-block animate-spin rounded-full border-2 border-line-strong border-t-accent" style={{ width: size, height: size }} />;
}
