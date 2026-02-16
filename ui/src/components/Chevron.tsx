interface ChevronProps {
  direction: 'right' | 'down' | 'left'
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
      style={{
        flexShrink: 0,
        transform: `rotate(${{ right: 0, down: 90, left: 180 }[direction]}deg)`,
        transition: 'transform 150ms ease-in-out',
      }}
    >
      <path d="M6 4 L10 8 L6 12" />
    </svg>
  )
}
