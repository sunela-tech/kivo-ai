import { Loader2, X } from "lucide-react";
import { useEffect, useId, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-violet-600 text-white hover:bg-violet-500 active:bg-violet-700 shadow-[0_8px_24px_-12px_rgb(109_93_246/0.9)] disabled:bg-panel-3 disabled:text-ink-4 disabled:shadow-none",
  secondary: "bg-panel-2 text-ink border border-line hover:border-line-2 hover:bg-panel-3 disabled:text-ink-4",
  ghost: "text-ink-2 hover:bg-panel-2 hover:text-ink disabled:text-ink-4",
  danger: "bg-bad/10 text-bad border border-bad/30 hover:bg-bad/20 disabled:opacity-50",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-12 px-6 text-[15px] gap-2.5 rounded-xl",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx("inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors duration-150 select-none", variants[variant], sizes[size], className)}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, active, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
        active ? "bg-violet-600/20 text-violet-300" : "text-ink-3 hover:bg-panel-3 hover:text-ink",
        "disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("animate-spin text-violet-400", className ?? "size-5")} />;
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "violet" | "good" | "warn" | "bad"; children: ReactNode }) {
  const tones = {
    neutral: "bg-panel-3 text-ink-2",
    violet: "bg-violet-600/15 text-violet-300",
    good: "bg-good/10 text-good",
    warn: "bg-warn/10 text-warn",
    bad: "bg-bad/10 text-bad",
  };
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", tones[tone])}>{children}</span>;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  size?: "sm" | "md";
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl border border-line bg-night-850 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-lg font-medium transition-colors",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-4 py-1.5 text-sm",
            value === o.value ? "bg-violet-600 text-white shadow" : "text-ink-3 hover:text-ink",
            o.disabled && "cursor-not-allowed opacity-40 hover:text-ink-3",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, children, wide, labelledBy }: { open: boolean; onClose?: () => void; children: ReactNode; wide?: boolean; labelledBy?: string }) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <div className="absolute inset-0 animate-fade-in bg-night-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className={cx("panel relative max-h-[92dvh] w-full animate-rise overflow-y-auto shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")}>
        {onClose && (
          <button onClick={onClose} aria-label="Close" className="absolute top-4 right-4 rounded-lg p-1.5 text-ink-3 hover:bg-panel-3 hover:text-ink">
            <X className="size-4" />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "bad" | "good"; title?: string; children?: ReactNode; action?: ReactNode }) {
  const tones = {
    info: "border-violet-500/30 bg-violet-600/10 text-violet-300",
    warn: "border-warn/30 bg-warn/10 text-warn",
    bad: "border-bad/30 bg-bad/10 text-bad",
    good: "border-good/30 bg-good/10 text-good",
  };
  return (
    <div className={cx("flex items-start gap-3 rounded-xl border px-4 py-3 text-sm", tones[tone])} role={tone === "bad" ? "alert" : "status"}>
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx("text-ink-2", title && "mt-0.5")}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-violet-600/15 text-violet-300">{icon}</div>}
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <p className="mt-1.5 max-w-sm text-sm text-ink-3">{children}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-24 text-sm text-ink-3">
      <Spinner /> {label}
    </div>
  );
}

export function Logo({ size = 28, wordmark = true }: { size?: number; wordmark?: boolean }) {
  // Each instance gets its own gradient id: a shared id breaks when the first copy on the page is hidden.
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2.5 select-none">
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#6d5df6" />
          </linearGradient>
        </defs>
        <rect x="4" y="4" width="56" height="56" rx="16" fill={`url(#${id})`} />
        <path d="M26 20.5v23a2 2 0 0 0 3 1.7l19-11.5a2 2 0 0 0 0-3.4L29 18.8a2 2 0 0 0-3 1.7z" fill="#fff" />
      </svg>
      {wordmark && <span className="text-[19px] font-semibold tracking-tight">Kivo</span>}
    </span>
  );
}
