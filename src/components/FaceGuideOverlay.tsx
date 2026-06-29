// Visual face-positioning guide drawn over the camera video: a centered target
// oval plus the live detected-face box, color-coded by how well the face is
// positioned. Purely presentational — ChallengeGate computes the positioning
// and feeds it in. Coordinates are percentages of the frame, so the SVG uses a
// 0..100 viewBox with preserveAspectRatio="none" to map them directly onto the
// video rectangle regardless of its rendered size.

export type Positioning = 'none' | 'adjust' | 'good';

export interface BoxPct {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FaceGuideOverlayProps {
  positioning: Positioning;
  boxPct: BoxPct | null;
}

const COLOR: Record<Positioning, string> = {
  none: '#9aa0a6', // gray — no face
  adjust: '#e0a000', // amber — face found but off-center / wrong size
  good: '#2e7d32', // green — well positioned
};

const HINT: Record<Positioning, string> = {
  none: 'Move your face into the frame',
  adjust: 'Center your face in the oval',
  good: '',
};

export function FaceGuideOverlay({ positioning, boxPct }: FaceGuideOverlayProps) {
  const color = COLOR[positioning];
  const hint = HINT[positioning];

  return (
    <div className="face-guide" aria-hidden="true">
      <svg
        className="face-guide__svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Target oval the user should fill */}
        <ellipse
          cx="50"
          cy="47"
          rx="24"
          ry="32"
          fill="none"
          stroke={color}
          strokeWidth="0.8"
          strokeDasharray="3 2"
          opacity="0.9"
        />
        {/* Live detected-face box */}
        {boxPct && (
          <rect
            x={boxPct.left}
            y={boxPct.top}
            width={boxPct.width}
            height={boxPct.height}
            fill="none"
            stroke={color}
            strokeWidth="0.6"
            opacity="0.95"
          />
        )}
      </svg>
      {hint && (
        <div className="face-guide__hint" style={{ borderColor: color }}>
          {hint}
        </div>
      )}
    </div>
  );
}
