import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  children,
  tone = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "quiet" | "danger" }) {
  const tones = {
    default: "border-line bg-panel text-ink hover:border-accent",
    primary: "border-transparent bg-accent text-white hover:brightness-110",
    quiet: "border-transparent bg-transparent text-muted hover:text-ink",
    danger: "border-transparent bg-[#3A2430] text-[#FFB4B4] hover:bg-[#4A2C38]",
  }[tone];
  return (
    <button
      {...props}
      className={`inline-flex h-8 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${tones} ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "info" }) {
  const tones = {
    neutral: "bg-[#1C2838] text-muted",
    ok: "bg-[#143328] text-[#7DFFC3]",
    warn: "bg-[#3A3118] text-[#F5D48A]",
    bad: "bg-[#3A2430] text-[#FFB4B4]",
    info: "bg-[#17304F] text-[#9CC4FF]",
  }[tone];
  return <span className={`inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium ${tones}`}>{children}</span>;
}
