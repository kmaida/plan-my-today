import { memo } from "react";
import "./TodogentMascot.css";

type MascotState = "idle" | "thinking" | "static";

interface TodogentMascotProps {
  state?: MascotState;
  /** Pixel size for width. Height scales proportionally. Defaults to 32. */
  size?: number;
  className?: string;
}

/* ── Compact vs full geometry ─────────────────────────────────────────────── */

/** Full clipboard: clip + face + indicator belly + sparkles */
const FULL_VIEWBOX = "0 0 100 116";
const FULL_RATIO = 116 / 100;

/**
 * Compact "head shot": clip + face, board ends just below face screen with
 * proper rounded corners (not a hard crop). No indicators, no sparkles.
 */
const COMPACT_VIEWBOX = "0 0 100 76";
const COMPACT_RATIO = 76 / 100;

/**
 * Todaygent mascot SVG with animated states.
 *
 * The robot IS a clipboard — dark brown board body, cream paper area with a
 * distinct face screen, silver clip "hat," status-light indicator bars on its
 * belly, and gold sparkles.
 * Rendered inline (not via <img>) so CSS classes can control animation states.
 *
 * At compact sizes (≤ 32px) the viewBox crops to just the head: clip hat +
 * face screen, with a shortened board that still has rounded bottom corners.
 * This makes expressions (blink, shifty eyes, smirk) visible at small sizes.
 *
 * States:
 * - "idle": sparkle twinkle + occasional blink + indicator pulse (visible mascot)
 * - "thinking": subtle mouth drift + rare side-eye squint (used during LLM response)
 * - "static": no animations (fallback / reduced-motion)
 */
export const TodogentMascot = memo(function TodogentMascot({
  state = "static",
  size = 32,
  className = "",
}: TodogentMascotProps) {
  const isCompact = size <= 48;
  const stateClass = state !== "static" ? `todaygent--${state}` : "";
  const compactClass = isCompact ? "todaygent--compact" : "";
  const viewBox = isCompact ? COMPACT_VIEWBOX : FULL_VIEWBOX;
  const ratio = isCompact ? COMPACT_RATIO : FULL_RATIO;

  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size * ratio}
      className={`todaygent-mascot ${stateClass} ${compactClass} ${className}`.trim()}
      role="img"
      aria-label="Todaygent"
    >
      {/* ── Clipboard body (dark brown board) ── */}
      {/* Compact: shortened board ends just below face with rounded corners */}
      <g className="todaygent-body">
        <rect
          x="16" y="22"
          width="68" height={isCompact ? 52 : 88}
          rx="10" ry="10" fill="#3D2E1F"
        />
      </g>

      {/* ── Paper inset (cream) ── */}
      {/* Compact: shortened to just frame the face screen */}
      <rect
        x="22" y="30"
        width="56" height={isCompact ? 38 : 74}
        rx="6" ry="6" fill="#FAF8F5"
      />

      {/* ── Face screen (warm beige, distinct from cream paper) ── */}
      <rect x="28" y="34" width="44" height="32" rx="8" ry="8" fill="#E5DDD3" />

      {/* ── Clip "hat" (silver metal, proportionally smaller) ── */}
      <g className="todaygent-clip">
        <rect x="35" y="16" width="30" height="10" rx="5" ry="5" fill="#8C8C8C" />
        <rect x="41" y="19" width="18" height="5" rx="2.5" ry="2.5" fill="#B8B8B8" />
      </g>

      {/* ── Face (on the screen area) ── */}
      <g className="todaygent-face">
        {/* Eyes */}
        <circle className="eye-left" cx="41" cy="46" r="3.5" fill="#3D2E1F" />
        <circle className="eye-right" cx="59" cy="46" r="3.5" fill="#3D2E1F" />

        {/* Neutral mouth (smile — default visible) */}
        <path
          className="mouth-neutral"
          d="M44,55 Q50,60 56,55"
          fill="none"
          stroke="#3D2E1F"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Thinking mouth (straight "hmm" line — hidden by default) */}
        <path
          className="mouth-thinking"
          d="M43,56 L57,56"
          fill="none"
          stroke="#3D2E1F"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Pursed mouth (short tight curve — hidden by default) */}
        <path
          className="mouth-pursed"
          d="M45,56 Q50,57.5 55,56"
          fill="none"
          stroke="#3D2E1F"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>

      {/* ── Eyelids (two halves per eye meet in the middle for robotic blink) ── */}
      <g className="todaygent-eyelids">
        {/* Left eye: top lid drops down, bottom lid rises up */}
        <rect className="eyelid-top eyelid-top--left" x="35.5" y="40.5" width="11" height="5.5" rx="2" fill="#E5DDD3" />
        <rect className="eyelid-bottom eyelid-bottom--left" x="35.5" y="46" width="11" height="5.5" rx="2" fill="#E5DDD3" />
        {/* Right eye: same */}
        <rect className="eyelid-top eyelid-top--right" x="53.5" y="40.5" width="11" height="5.5" rx="2" fill="#E5DDD3" />
        <rect className="eyelid-bottom eyelid-bottom--right" x="53.5" y="46" width="11" height="5.5" rx="2" fill="#E5DDD3" />
      </g>

      {/* ── Status-light indicators (hidden in compact mode via CSS) ── */}
      <g className="todaygent-indicators">
        <circle className="indicator-dot indicator-dot--1" cx="31" cy="76" r="2.5" fill="#4A8B4A" />
        <rect x="37" y="74" width="28" height="4" rx="2" fill="#D4C9BC" />

        <circle className="indicator-dot indicator-dot--2" cx="31" cy="85" r="2.5" fill="#FFBF2E" />
        <rect x="37" y="83" width="22" height="4" rx="2" fill="#D4C9BC" />

        <circle className="indicator-dot indicator-dot--3" cx="31" cy="94" r="2.5" fill="#7A9C9F" />
        <rect x="37" y="92" width="25" height="4" rx="2" fill="#D4C9BC" />
      </g>

      {/* ── Ambient sparkles (hidden in compact mode via CSS) ── */}
      <g className="todaygent-sparkles">
        <path
          className="sparkle-1"
          d="M87,37 L90,44 L93,37 L100,34 L93,31 L90,24 L87,31 L80,34 Z"
          fill="#FFBF2E"
        />
        <path
          className="sparkle-2"
          d="M8,28 L10,33 L12,28 L17,26 L12,24 L10,19 L8,24 L3,26 Z"
          fill="#FFB800"
        />
        <path
          className="sparkle-3"
          d="M85,80 L86.5,84 L88,80 L92,78.5 L88,77 L86.5,73 L85,77 L81,78.5 Z"
          fill="#FFBF2E"
        />
      </g>
    </svg>
  );
});
