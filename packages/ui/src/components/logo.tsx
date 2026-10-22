import { cn } from "@weaver/ui/lib/utils"

/** The Weaver woven-threads icon; `tile` is the square, `thread` the strokes. Mirrors src/assets/weaver-icon*.svg. */
function LogoIcon({
  tile,
  thread,
  className,
}: {
  tile: string
  thread: string
  className?: string
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={cn("size-6 shrink-0", className)}
    >
      <rect width="64" height="64" rx="16" fill={tile} />
      <path
        d="M20 13V51M32 13V51M44 13V51M13 20H51M13 32H51M13 44H51"
        fill="none"
        stroke={thread}
        strokeWidth="6"
        strokeLinecap="round"
      />
      <path
        d="M20 14.25V25.75M14.25 32H25.75M20 38.25V49.75M26.25 20H37.75M32 26.25V37.75M26.25 44H37.75M44 14.25V25.75M38.25 32H49.75M44 38.25V49.75"
        fill="none"
        stroke={tile}
        strokeWidth="10.5"
      />
      <path
        d="M20 13.25V26.75M13.25 32H26.75M20 37.25V50.75M25.25 20H38.75M32 25.25V38.75M25.25 44H38.75M44 13.25V26.75M37.25 32H50.75M44 37.25V50.75"
        fill="none"
        stroke={thread}
        strokeWidth="6"
      />
    </svg>
  )
}

/**
 * Weaver brand mark. Shows the black tile in light mode and the inverted
 * (white) tile in dark mode. `variant="full"` adds the wordmark next to the icon.
 */
function Logo({
  variant = "icon",
  className,
}: {
  variant?: "icon" | "full"
  className?: string
}) {
  return (
    <span
      data-slot="logo"
      role="img"
      aria-label="Weaver"
      className={cn("inline-flex items-center gap-2", className)}
    >
      <LogoIcon tile="#000000" thread="#ffffff" className="dark:hidden" />
      <LogoIcon tile="#ffffff" thread="#000000" className="hidden dark:block" />
      {variant === "full" && (
        <span aria-hidden="true" className="text-base font-semibold tracking-tight">
          Weaver
        </span>
      )}
    </span>
  )
}

export { Logo }
