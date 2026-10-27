import type { AddedKind } from "@/lib/builder/model"

/**
 * A small drawing of what a block looks like on the page, for the gallery and the insert menu.
 *
 * A shape, not a figure: bar lengths and cell shades are a fixed pattern, so the drawing
 * says "a ranked list" without suggesting anybody's numbers.
 */

const INK = "currentColor"

function Bars() {
  return (
    <>
      {[34, 27, 20, 14].map((width, row) => (
        <g key={row}>
          <rect x="4" y={4 + row * 8} width="14" height="4" rx="1" fill={INK} opacity="0.25" />
          <rect x="22" y={4 + row * 8} width={width * 1.8} height="4" rx="1" fill={INK} opacity="0.7" />
        </g>
      ))}
    </>
  )
}

export function BlockDrawing({ kind }: Readonly<{ kind: AddedKind }>) {
  return (
    <svg viewBox="0 0 96 40" aria-hidden="true" className="h-10 w-full text-primary">
      {kind === "key_figures" &&
        [0, 1, 2].map((tile) => (
          <g key={tile}>
            <rect x={3 + tile * 31} y="6" width="28" height="28" rx="3" fill={INK} opacity="0.1" />
            <rect x={7 + tile * 31} y="11" width="12" height="3" rx="1" fill={INK} opacity="0.4" />
            <rect x={7 + tile * 31} y="19" width="18" height="7" rx="1" fill={INK} opacity="0.8" />
          </g>
        ))}
      {kind === "avg_vs_peak" &&
        [0, 1, 2, 3].map((row) => (
          <g key={row}>
            <rect x="4" y={5 + row * 8} width="88" height="4" rx="2" fill={INK} opacity="0.1" />
            <rect x="4" y={5 + row * 8} width={30 - row * 4} height="4" rx="2" fill={INK} opacity="0.75" />
            <rect x={62 - row * 9} y={4 + row * 8} width="2" height="6" fill={INK} />
          </g>
        ))}
      {kind === "top_list" && <Bars />}
      {kind === "heatmap" &&
        [0, 1, 2, 3].map((row) =>
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((cell) => (
            <rect
              key={`${row}-${cell}`}
              x={4 + cell * 9}
              y={4 + row * 8}
              width="8"
              height="7"
              rx="1"
              fill={INK}
              opacity={0.12 + (((row * 3 + cell * 7) % 5) * 0.16)}
            />
          ))
        )}
      {kind === "sparklines" &&
        [0, 1, 2].map((row) => (
          <g key={row}>
            <rect x="4" y={6 + row * 11} width="18" height="4" rx="1" fill={INK} opacity="0.25" />
            <polyline
              points={`28,${10 + row * 11} 38,${6 + row * 11} 48,${9 + row * 11} 58,${4 + row * 11} 68,${8 + row * 11} 76,${5 + row * 11}`}
              fill="none"
              stroke={INK}
              strokeWidth="1.5"
              opacity="0.8"
            />
            <rect x="82" y={6 + row * 11} width="10" height="4" rx="1" fill={INK} opacity="0.4" />
          </g>
        ))}
      {kind === "month_vs_month" &&
        [0, 1, 2].map((row) => (
          <g key={row}>
            <rect x="4" y={6 + row * 11} width="20" height="4" rx="1" fill={INK} opacity="0.25" />
            <rect x="30" y={6 + row * 11} width={26 - row * 6} height="4" rx="1" fill={INK} opacity="0.35" />
            <rect x="60" y={6 + row * 11} width={20 + row * 4} height="4" rx="1" fill={INK} opacity="0.8" />
          </g>
        ))}
      {kind === "coverage" && (
        <>
          <rect x="4" y="6" width="88" height="28" rx="3" fill="none" stroke={INK} strokeDasharray="3 2" opacity="0.5" />
          <rect x="10" y="13" width="44" height="4" rx="1" fill={INK} opacity="0.5" />
          <rect x="10" y="22" width="64" height="4" rx="1" fill={INK} opacity="0.25" />
        </>
      )}
      {kind === "callout" && (
        <>
          <rect x="4" y="6" width="88" height="28" rx="3" fill={INK} opacity="0.08" />
          <rect x="4" y="6" width="3" height="28" fill={INK} opacity="0.8" />
          <rect x="13" y="13" width="60" height="4" rx="1" fill={INK} opacity="0.5" />
          <rect x="13" y="22" width="40" height="4" rx="1" fill={INK} opacity="0.3" />
        </>
      )}
      {(kind === "text" || kind === "agent") && (
        <>
          {[86, 80, 84, 52].map((width, row) => (
            <rect key={row} x="4" y={6 + row * 8} width={width} height="4" rx="1" fill={INK} opacity="0.3" />
          ))}
          {kind === "agent" && (
            <path d="M86 4 L88 9 L93 11 L88 13 L86 18 L84 13 L79 11 L84 9 Z" fill={INK} opacity="0.9" />
          )}
        </>
      )}
      {kind === "page_break" && (
        <>
          <rect x="22" y="2" width="52" height="14" rx="1" fill={INK} opacity="0.12" />
          <line x1="4" y1="20" x2="92" y2="20" stroke={INK} strokeDasharray="4 3" opacity="0.6" />
          <rect x="22" y="24" width="52" height="14" rx="1" fill={INK} opacity="0.12" />
        </>
      )}
    </svg>
  )
}
