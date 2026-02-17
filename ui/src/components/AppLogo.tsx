import { memo } from "react";
import "./AppLogo.css";

interface AppLogoProps {
  /** When true, task rows draw in sequentially and sparkles twinkle. */
  animated?: boolean;
  /** Pixel width. Height scales proportionally (1:1 viewBox). Defaults to 90. */
  size?: number;
  className?: string;
}

/**
 * Inline SVG of the Plan My Today clipboard logo.
 *
 * Geometry is identical to `public/logo.svg`. Rendering inline (not via
 * `<img>`) lets CSS animate individual elements during loading states.
 *
 * When `animated` is true, the logo plays a looping choreography:
 * checkboxes appear → task lines draw in → checkmarks draw → sparkles
 * twinkle → hold → fade out → repeat.
 */
export const AppLogo = memo(function AppLogo({
  animated = false,
  size = 90,
  className = "",
}: AppLogoProps) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={[
        "app-logo",
        animated ? "app-logo--animated" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label="Plan My Today"
    >
      <defs>
        <filter
          id="sparkle-shadow"
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
        >
          <feDropShadow
            dx="0"
            dy="3"
            stdDeviation="4"
            floodColor="#000000"
            floodOpacity="0.4"
          />
        </filter>
      </defs>

      {/* ── Clipboard board (dark brown) ── */}
      <rect
        x="64"
        y="40"
        width="352"
        height="432"
        rx="24"
        ry="24"
        fill="#3D2E1F"
      />

      {/* ── Paper inset (cream) ── */}
      <rect
        x="88"
        y="72"
        width="304"
        height="380"
        rx="12"
        ry="12"
        fill="#FAF8F5"
      />

      {/* ── Clip hat (silver) ── */}
      <rect
        x="162"
        y="14"
        width="156"
        height="62"
        rx="16"
        ry="16"
        fill="#8C8C8C"
      />
      <rect
        x="186"
        y="28"
        width="108"
        height="34"
        rx="10"
        ry="10"
        fill="#B8B8B8"
      />

      {/* ── Task row 1 (checked) ── */}
      <g className="app-logo__row app-logo__row--1">
        <rect
          className="app-logo__checkbox"
          x="120"
          y="112"
          width="36"
          height="36"
          rx="8"
          ry="8"
          fill="#F5F0EB"
          stroke="#8B7355"
          strokeWidth="3"
        />
        <polyline
          className="app-logo__check app-logo__check--1"
          points="127,132 136,143 153,121"
          fill="none"
          stroke="#4A8B4A"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect
          className="app-logo__line"
          x="176"
          y="122"
          width="184"
          height="16"
          rx="8"
          ry="8"
          fill="#D4C9BC"
        />
      </g>

      {/* ── Task row 2 (checked) ── */}
      <g className="app-logo__row app-logo__row--2">
        <rect
          className="app-logo__checkbox"
          x="120"
          y="180"
          width="36"
          height="36"
          rx="8"
          ry="8"
          fill="#F5F0EB"
          stroke="#8B7355"
          strokeWidth="3"
        />
        <polyline
          className="app-logo__check app-logo__check--2"
          points="127,200 136,211 153,189"
          fill="none"
          stroke="#4A8B4A"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect
          className="app-logo__line"
          x="176"
          y="190"
          width="148"
          height="16"
          rx="8"
          ry="8"
          fill="#D4C9BC"
        />
      </g>

      {/* ── Task row 3 (unchecked) ── */}
      <g className="app-logo__row app-logo__row--3">
        <rect
          className="app-logo__checkbox"
          x="120"
          y="248"
          width="36"
          height="36"
          rx="8"
          ry="8"
          fill="#F5F0EB"
          stroke="#8B7355"
          strokeWidth="3"
        />
        <rect
          className="app-logo__line"
          x="176"
          y="258"
          width="168"
          height="16"
          rx="8"
          ry="8"
          fill="#D4C9BC"
        />
      </g>

      {/* ── Task row 4 (unchecked) ── */}
      <g className="app-logo__row app-logo__row--4">
        <rect
          className="app-logo__checkbox"
          x="120"
          y="316"
          width="36"
          height="36"
          rx="8"
          ry="8"
          fill="#F5F0EB"
          stroke="#8B7355"
          strokeWidth="3"
        />
        <rect
          className="app-logo__line"
          x="176"
          y="326"
          width="128"
          height="16"
          rx="8"
          ry="8"
          fill="#D4C9BC"
        />
      </g>

      {/* ── Task row 5 (unchecked) ── */}
      <g className="app-logo__row app-logo__row--5">
        <rect
          className="app-logo__checkbox"
          x="120"
          y="384"
          width="36"
          height="36"
          rx="8"
          ry="8"
          fill="#F5F0EB"
          stroke="#8B7355"
          strokeWidth="3"
        />
        <rect
          className="app-logo__line"
          x="176"
          y="394"
          width="156"
          height="16"
          rx="8"
          ry="8"
          fill="#D4C9BC"
        />
      </g>

      {/* ── AI badge (dark rounded square) ── */}
      <g filter="url(#sparkle-shadow)">
        <rect
          x="310"
          y="280"
          width="150"
          height="150"
          rx="42"
          ry="42"
          fill="#3D2E1F"
        />
      </g>

      {/* ── Sparkles on badge ── */}
      <g transform="translate(20,15)">
        <path
          className="app-logo__sparkle app-logo__sparkle--1"
          d="M353,360 L360,387 L367,360 L394,353 L367,346 L360,319 L353,346 L326,353 Z"
          fill="#FFBF2E"
        />
        <path
          className="app-logo__sparkle app-logo__sparkle--2"
          d="M401,330 L407,348 L413,330 L431,324 L413,318 L407,300 L401,318 L383,324 Z"
          fill="#FFBF2E"
        />
        <path
          className="app-logo__sparkle app-logo__sparkle--3"
          d="M320,325 L325,337 L330,325 L342,321 L330,317 L325,305 L320,317 L308,321 Z"
          fill="#FFBF2E"
        />
      </g>
    </svg>
  );
});
