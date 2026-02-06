interface ChevronProps {
  direction: 'right' | 'down'
  size?: number
  className?: string
}

export function Chevron({ direction, size = 12, className }: ChevronProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0 }}
    >
      {direction === 'right' ? (
        <path d="M6 4 L10 8 L6 12" />
      ) : (
        <path d="M4 6 L8 10 L12 6" />
      )}
    </svg>
  )
}
