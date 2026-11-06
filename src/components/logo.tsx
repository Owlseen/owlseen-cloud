import { BRAND_SLUG } from "@/domain/brand";

/** The mark: a brow, whose ends are the ear tufts, over two eyes cut by the same angle. The brow takes the text colour and the eyes the iris, so it reads by day and at night. */
export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={`shrink-0 ${className}`}>
      <path fill="currentColor" d="M1.5 4 16 11.4 30.5 4V8.2L16 15.6 1.5 8.2Z" />
      <path fill="var(--eye)" d="M4.6 12 14.9 17.3A7.3 7.3 0 1 1 4.6 12Z" />
      <path fill="var(--eye)" d="M27.4 12 17.1 17.3A7.3 7.3 0 1 0 27.4 12Z" />
    </svg>
  );
}

/** Mark and wordmark: lowercase, sharp and tight. In a sentence the name stays as it's written. */
export function Logo() {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <LogoMark />
      <span className="truncate font-heading text-[1.3rem] font-semibold tracking-[-0.045em] [font-variation-settings:'SHRP'_100]">{BRAND_SLUG}</span>
    </span>
  );
}
