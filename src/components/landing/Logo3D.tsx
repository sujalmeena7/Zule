// ============================================
// Zule AI — Logo3D
// ============================================
//
// A pure-CSS 3D treatment for the Zule favicon used in the floating
// navbar. Hovering the logo maps the cursor's offset within the logo's
// bounding rect to `rotateX` / `rotateY` rotations capped at ±15°, and
// the logo eases back to a flat pose when the pointer leaves.
//
// No `three` / `@react-three/fiber` imports here — this is pure
// framer-motion + CSS `transform-style: preserve-3d`. Keeping the only
// R3F surface to `Hero3DCanvas` is part of the bundling contract in the
// design doc (the lazy `vendor-three` chunk must stay opt-in).
//
// Requirements: 5.1, 5.2, 5.3, 9.3

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { motion } from 'framer-motion';

import { useLandingMotion } from './LandingMotionContext';

// --------------------------------------------------------------------------
// Pure helper — bounded, gated rotation math
// --------------------------------------------------------------------------

/**
 * Maximum rotation per axis, in degrees. Tied to Requirement 5.1.
 */
const MAX_ROTATION_DEG = 15;

/**
 * Inputs to {@link computeLogoRotation}.
 *
 * `offsetX` / `offsetY` are the pointer position relative to the
 * element's top-left corner (i.e. `event.clientX - rect.left`).
 * `width` / `height` are the element's bounding rect dimensions.
 */
export interface LogoRotationInput {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  reducedMotion: boolean;
}

/**
 * Output of {@link computeLogoRotation}. Both values are in degrees and
 * are clamped to the closed interval [-15, +15].
 */
export interface LogoRotation {
  rotX: number;
  rotY: number;
}

/**
 * Maps a pointer offset within the logo's bounding rect to a pair of
 * `(rotX, rotY)` rotations in degrees.
 *
 * The function is total and pure: it never throws, never reads from the
 * DOM, and is a function of its inputs only. This is what lets Property
 * 3 (logo 3D rotation is bounded and gated) exercise it directly under
 * fast-check.
 *
 * Behavior:
 *   - Returns `(0, 0)` whenever `reducedMotion` is `true` (Requirement 5.3).
 *   - Returns `(0, 0)` for degenerate or non-finite inputs (zero / negative
 *     dimensions, NaN, Infinity) so the property holds for arbitrary
 *     generated inputs.
 *   - Otherwise normalizes the pointer offset against the element's
 *     center, scales by {@link MAX_ROTATION_DEG}, and clamps the result
 *     to [-15, +15] (Requirement 5.1).
 *   - `rotX` follows the vertical pointer offset (with sign flipped so a
 *     cursor above center tilts the logo backwards) and `rotY` follows
 *     the horizontal offset.
 */
export function computeLogoRotation({
  offsetX,
  offsetY,
  width,
  height,
  reducedMotion,
}: LogoRotationInput): LogoRotation {
  if (reducedMotion) return { rotX: 0, rotY: 0 };

  if (
    !Number.isFinite(offsetX) ||
    !Number.isFinite(offsetY) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { rotX: 0, rotY: 0 };
  }

  const halfWidth = width / 2;
  const halfHeight = height / 2;

  // Normalize so the element's center is (0, 0). For a pointer inside
  // the element these land in [-1, +1]; outside the element they can
  // exceed that range, which is why the clamp below is essential.
  const nx = (offsetX - halfWidth) / halfWidth;
  const ny = (offsetY - halfHeight) / halfHeight;

  // Pointer above center → cursor.y < halfHeight → ny < 0 → rotX > 0,
  // which tilts the top of the logo away from the viewer. Sign chosen
  // so the logo appears to lean toward the cursor.
  const rawRotX = -ny * MAX_ROTATION_DEG;
  const rawRotY = nx * MAX_ROTATION_DEG;

  return {
    rotX: clamp(rawRotX, -MAX_ROTATION_DEG, MAX_ROTATION_DEG),
    rotY: clamp(rawRotY, -MAX_ROTATION_DEG, MAX_ROTATION_DEG),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export interface Logo3DProps {
  /**
   * Image source. Defaults to the relative favicon path used elsewhere
   * on the landing page so the asset resolves under Electron's
   * `file://` protocol (Requirement 9.3).
   */
  src?: string;
  /** Accessible alternate text. */
  alt?: string;
  /** Additional class names appended to `.logo-3d`. */
  className?: string;
  /** Optional rendered width in pixels (forwarded to `<img>`). */
  width?: number;
  /** Optional rendered height in pixels (forwarded to `<img>`). */
  height?: number;
  /** Click handler — wired to e.g. the home anchor in the navbar. */
  onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

const WRAPPER_STYLE: CSSProperties = {
  transformStyle: 'preserve-3d',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const IMG_STYLE: CSSProperties = {
  display: 'block',
  pointerEvents: 'none',
  userSelect: 'none',
};

/**
 * Renders the Zule favicon as a CSS 3D surface that tilts toward the
 * cursor on hover and eases back to flat on leave.
 *
 * The component reads `reducedMotion` from {@link useLandingMotion} so
 * it stays in lockstep with every other animated surface on the landing
 * page. When reduced motion is active the pointer handlers fall through
 * to no-ops, and a flush effect snaps the rotation back to zero so a
 * toggle mid-hover can't strand the logo at an angle.
 *
 * Requirements: 5.1, 5.2, 5.3, 9.3
 */
export function Logo3D({
  src = './favicon.svg',
  alt = 'Zule logo',
  className,
  width = 24,
  height = 24,
  onClick,
}: Logo3DProps): ReactElement {
  const { reducedMotion } = useLandingMotion();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [rotation, setRotation] = useState<LogoRotation>({ rotX: 0, rotY: 0 });

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (reducedMotion) return;
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = computeLogoRotation({
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        reducedMotion,
      });
      setRotation(next);
    },
    [reducedMotion],
  );

  const handlePointerLeave = useCallback(() => {
    setRotation({ rotX: 0, rotY: 0 });
  }, []);

  // If the user toggles `prefers-reduced-motion: reduce` while the
  // logo is mid-tilt, force a snap back to neutral so the displayed
  // pose matches the new preference.
  useEffect(() => {
    if (reducedMotion) {
      setRotation({ rotX: 0, rotY: 0 });
    }
  }, [reducedMotion]);

  const composedClassName = className ? `logo-3d ${className}` : 'logo-3d';

  return (
    <motion.div
      ref={wrapperRef}
      className={composedClassName}
      style={WRAPPER_STYLE}
      animate={{ rotateX: rotation.rotX, rotateY: rotation.rotY }}
      transition={{ duration: 0.25 }}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onClick={onClick}
    >
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        style={IMG_STYLE}
        draggable={false}
      />
    </motion.div>
  );
}

export default Logo3D;
