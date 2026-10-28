import type { AddedKind } from "@/lib/builder/model"

/**
 * A small drawing of what a block looks like on the page, for the gallery and the insert menu.
 *
 * A shape, not a figure: bar lengths and cell shades are a fixed pattern, so the drawing
 * says "a ranked list" without suggesting anybody's numbers. It is drawn in the report's own
 * colours (`agent/chart-renderer/svg.mjs`), so the card looks like the chart it adds.
 */

const NAVY = "#2b3a7a"
const MID = "#6f7fc0"
const LIGHT = "#9aa7d8"
const PALE = "#c7cfec"
const TRACK = "#eef0f1"
const TINT = "#f4f6fb"
const EDGE = "#dfe4f5"
const RULE = "#e3e7ea"
const ORANGE = "#c2410c"
const SALMON = "#e8b4a0"
const NONE = "#d6dce0"

/** Shades for a ranked run of bars, busiest first. */
const RANKED = [NAVY, MID, LIGHT, PALE]

function Drawing({ kind }: Readonly<{ kind: AddedKind }>) {
  switch (kind) {
    case "key_figures":
      return (
        <>
          {[0, 1, 2].map((tile) => (
            <g key={tile}>
              <rect x={2 + tile * 39} y="8" width="35" height="40" rx="6" fill={TINT} stroke={EDGE} />
              <rect x={8 + tile * 39} y="15" width="16" height="4" rx="2" fill={LIGHT} />
              <rect x={8 + tile * 39} y="25" width={20 - tile * 3} height="10" rx="2" fill={NAVY} />
            </g>
          ))}
        </>
      )
    case "kpi_tiles":
      return (
        <>
          <rect x="2" y="4" width="54" height="48" rx="6" fill={TINT} stroke={EDGE} />
          <rect x="64" y="4" width="54" height="48" rx="6" fill={TINT} stroke={EDGE} />
          <rect x="8" y="12" width="24" height="9" rx="2" fill={NAVY} />
          <rect x="70" y="12" width="20" height="9" rx="2" fill={NAVY} />
          <rect x="8" y="25" width="16" height="3" rx="1.5" fill={SALMON} />
          <rect x="70" y="25" width="14" height="3" rx="1.5" fill={LIGHT} />
          <path d="M8 44 L18 38 L26 40 L36 32 L50 34" stroke={MID} strokeWidth="2" fill="none" />
          <path d="M70 42 L80 44 L90 37 L100 39 L112 32" stroke={MID} strokeWidth="2" fill="none" />
        </>
      )
    case "avg_vs_peak":
      return (
        <>
          {[0, 1, 2, 3].map((row) => {
            const y = 9 + row * 13
            const from = 14 + row * 4
            const to = 104 - row * 16
            return (
              <g key={row}>
                <line x1="2" y1={y} x2="118" y2={y} stroke={RULE} />
                <line x1={from} y1={y} x2={to} y2={y} stroke={PALE} strokeWidth="3" strokeLinecap="round" />
                <circle cx={from} cy={y} r="3.5" fill={LIGHT} />
                <circle cx={to} cy={y} r="3.5" fill={NAVY} />
              </g>
            )
          })}
        </>
      )
    case "utilization_bullet":
      return (
        <>
          {[0, 1].map((row) => {
            const y = 10 + row * 24
            return (
              <g key={row}>
                <rect x="2" y={y} width="110" height="10" rx="5" fill={TRACK} />
                <rect x="2" y={y} width={62 - row * 24} height="10" rx="5" fill={PALE} />
                <rect x="2" y={y} width={40 - row * 18} height="10" rx="5" fill={NAVY} />
                <rect x={72 - row * 20} y={y - 2} width="2" height="14" fill="#1b2025" />
                <rect x="88" y={y - 4} width="2" height="18" fill={ORANGE} />
              </g>
            )
          })}
        </>
      )
    case "top_list":
      return (
        <>
          <rect x="2" y="4" width="116" height="8" rx="2" fill={RULE} />
          {[0, 1, 2].map((row) => (
            <g key={row}>
              <rect x="2" y={16 + row * 12} width="116" height="8" rx="2" fill={TINT} />
              <rect x="8" y={18.5 + row * 12} width={34 - row * 6} height="3" rx="1.5" fill={LIGHT} />
              <rect x="90" y={17 + row * 12} width={24 - row * 7} height="6" rx="2" fill={RANKED[row]} />
            </g>
          ))}
        </>
      )
    case "bar_list":
      return (
        <>
          {[96, 72, 50, 30].map((width, row) => (
            <g key={row}>
              <rect x="2" y={3 + row * 13.5} width="98" height="10" rx="3" fill={TINT} />
              <rect x="2" y={3 + row * 13.5} width={width} height="10" rx="3" fill={RANKED[row]} />
              <rect x="104" y={6 + row * 13.5} width="14" height="4" rx="2" fill={NAVY} />
            </g>
          ))}
        </>
      )
    case "fleet_mix":
      return (
        <>
          {[
            [2, 50, NAVY],
            [54, 30, MID],
            [86, 18, PALE],
            [106, 12, SALMON],
          ].map(([x, width, fill]) => (
            <rect key={fill} x={x} y="10" width={width} height="14" rx="4" fill={fill as string} />
          ))}
          {[NAVY, MID, PALE, SALMON].map((fill, item) => (
            <g key={fill}>
              <circle cx={6 + (item % 2) * 58} cy={item < 2 ? 36 : 47} r="3" fill={fill} />
              <rect x={12 + (item % 2) * 58} y={item < 2 ? 34 : 45} width={item === 0 ? 34 : 24} height="4" rx="2" fill={LIGHT} />
            </g>
          ))}
        </>
      )
    case "heatmap":
      return (
        <>
          {[0, 1, 2, 3].map((row) =>
            Array.from({ length: 12 }, (_, cell) => (
              <rect
                key={`${row}-${cell}`}
                x={2 + cell * 9.8}
                y={4 + row * 12.5}
                width="8.6"
                height="11"
                rx="1.5"
                fill={NAVY}
                opacity={0.12 + ((row * 3 + cell * 7) % 5) * 0.2}
              />
            ))
          )}
        </>
      )
    case "week_heatmap":
      return (
        <>
          {[0, 1, 2, 3, 4, 5, 6].map((row) =>
            Array.from({ length: 24 }, (_, cell) => (
              <rect
                key={`${row}-${cell}`}
                x={2 + cell * 4.85}
                y={3 + row * 7.2}
                width="4.1"
                height="6.2"
                rx="1"
                fill={NAVY}
                // Busier in weekday working hours, which is the pattern the block exists to show.
                opacity={row < 5 && cell > 7 && cell < 18 ? 0.55 + ((cell + row) % 3) * 0.15 : 0.1}
              />
            ))
          )}
        </>
      )
    case "sparklines":
      return (
        <>
          {[0, 1, 2].map((row) => {
            const y = 8 + row * 17
            return (
              <g key={row}>
                <rect x="2" y={y} width="24" height="4" rx="2" fill={LIGHT} />
                <polyline
                  points={`34,${y + 6} 46,${y} 58,${y + 4} 70,${y - 3} 82,${y + 3} 94,${y - 1}`}
                  fill="none"
                  stroke={NAVY}
                  strokeWidth="1.8"
                />
                <rect x="102" y={y} width="16" height="5" rx="2" fill={NAVY} />
              </g>
            )
          })}
        </>
      )
    case "small_multiples":
      return (
        <>
          {[0, 1].map((row) =>
            [0, 1, 2].map((panel) => {
              const x = 2 + panel * 39.3
              const y = 2 + row * 27
              const line = [0, 1, 2, 3, 4]
                .map((step) => `${x + 4 + step * 7},${y + 19 - ((panel + row * 2 + step * 3) % 4) * 3}`)
                .join(" ")
              return (
                <g key={`${row}-${panel}`}>
                  <rect x={x} y={y} width="36" height="25" rx="4" fill="white" stroke="#eef1f3" />
                  <line x1={x + 3} y1={y + 8} x2={x + 33} y2={y + 8} stroke={SALMON} strokeDasharray="2 2" />
                  <polyline points={line} fill="none" stroke={NAVY} strokeWidth="1.4" />
                </g>
              )
            })
          )}
        </>
      )
    case "annotated_line":
      return (
        <>
          <line x1="2" y1="14" x2="118" y2="14" stroke={ORANGE} strokeDasharray="4 3" />
          <path
            d="M2 42 L16 38 L30 40 L44 30 L52 12 L62 34 L76 33 L90 37 L104 30 L118 33"
            stroke={NAVY}
            strokeWidth="2"
            fill="none"
          />
          <path
            d="M2 42 L16 38 L30 40 L44 30 L52 12 L62 34 L76 33 L90 37 L104 30 L118 33 L118 54 L2 54 Z"
            fill={NAVY}
            opacity="0.08"
          />
          <line x1="52" y1="4" x2="52" y2="54" stroke={ORANGE} strokeDasharray="2 2" opacity="0.7" />
          <circle cx="52" cy="12" r="3" fill={ORANGE} />
          <rect x="57" y="3" width="26" height="4" rx="2" fill={ORANGE} opacity="0.6" />
        </>
      )
    case "backup_tracker":
      return (
        <>
          {[0, 1, 2].map((row) => (
            <g key={row}>
              <rect x="2" y={7 + row * 16} width="20" height="4" rx="2" fill={LIGHT} />
              {Array.from({ length: 14 }, (_, day) => {
                // A missed day or two in a row, the pattern the strip exists to show.
                const missed = (row === 1 && day > 8 && day < 11) || (row === 2 && day === 4)
                return (
                  <rect
                    key={day}
                    x={28 + day * 6.5}
                    y={3 + row * 16}
                    width="5"
                    height="12"
                    rx="2"
                    fill={missed ? NONE : NAVY}
                  />
                )
              })}
            </g>
          ))}
        </>
      )
    case "month_vs_month":
      return (
        <>
          {[0, 1, 2].map((row) => {
            const y = 6 + row * 17
            return (
              <g key={row}>
                <rect x="2" y={y + 2} width="24" height="4" rx="2" fill={LIGHT} />
                <rect x="34" y={y} width={52 - row * 12} height="4" rx="2" fill={PALE} />
                <rect x="34" y={y + 6} width={40 + row * 10} height="4" rx="2" fill={NAVY} />
                <rect x="104" y={y + 2} width="14" height="4" rx="2" fill={row === 1 ? "#1d5c4a" : SALMON} />
              </g>
            )
          })}
        </>
      )
    case "coverage":
      return (
        <>
          <rect x="2" y="8" width="116" height="40" rx="6" fill="none" stroke={LIGHT} strokeDasharray="4 3" />
          <rect x="10" y="18" width="58" height="5" rx="2" fill={NAVY} opacity="0.6" />
          <rect x="10" y="30" width="84" height="5" rx="2" fill={PALE} />
        </>
      )
    case "callout":
      return (
        <>
          <rect x="2" y="8" width="116" height="40" rx="6" fill={TINT} />
          <rect x="2" y="8" width="4" height="40" rx="2" fill={NAVY} />
          <rect x="14" y="18" width="72" height="5" rx="2" fill={NAVY} opacity="0.6" />
          <rect x="14" y="30" width="50" height="5" rx="2" fill={PALE} />
        </>
      )
    case "text":
    case "agent":
      return (
        <>
          {[110, 100, 106, 64].map((width, row) => (
            <rect key={row} x="2" y={8 + row * 11} width={kind === "agent" ? width - 16 : width} height="5" rx="2" fill={PALE} />
          ))}
          {kind === "agent" && (
            <path d="M110 4 L112.5 10.5 L119 13 L112.5 15.5 L110 22 L107.5 15.5 L101 13 L107.5 10.5 Z" fill={NAVY} />
          )}
        </>
      )
    case "page_break":
      return (
        <>
          <rect x="28" y="2" width="64" height="18" rx="2" fill={TINT} stroke={EDGE} />
          <line x1="2" y1="28" x2="118" y2="28" stroke={LIGHT} strokeDasharray="5 4" />
          <rect x="28" y="36" width="64" height="18" rx="2" fill={TINT} stroke={EDGE} />
        </>
      )
  }
}

export function BlockDrawing({ kind, muted = false }: Readonly<{ kind: AddedKind; muted?: boolean }>) {
  return (
    // White in both themes: the drawing is a piece of the printed page.
    <svg
      viewBox="0 0 120 56"
      aria-hidden="true"
      className={muted ? "w-full rounded-md bg-white opacity-45 grayscale" : "w-full rounded-md bg-white"}
    >
      <Drawing kind={kind} />
    </svg>
  )
}
