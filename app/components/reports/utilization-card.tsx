import { messageText } from "@/lib/messages/catalog"
import { IDLE_CPU_PERCENT, type VmUtilization } from "@/lib/runs/utilization"

/**
 * The three busiest virtual machines, as capacity bars.
 *
 * CPU in indigo, memory in soga brown, each bar drawn to its percentage of 100 and the
 * figure beside it exactly as the snapshot stores it. A machine that averaged under ten
 * percent all period is flagged, because a busiest-three list whose third entry is idle
 * says something about the whole estate.
 */
export function UtilizationCard({
  machines,
}: Readonly<{ machines: readonly VmUtilization[] }>) {
  if (machines.length === 0) return null

  return (
    <section
      aria-labelledby="utilization-title"
      data-slot="utilization-card"
      className="rounded-xl border border-border bg-card"
    >
      <div className="flex flex-col gap-0.5 p-4 pb-3 md:px-5">
        <h2 id="utilization-title" className="text-section">
          {messageText("ui.utilization.heading", "en")}
        </h2>
        <p className="text-meta text-muted-foreground">
          {messageText("ui.utilization.description", "en", { count: machines.length })}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-y border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="h-9 px-4 font-medium md:px-5">
                {messageText("ui.utilization.col_resource", "en")}
              </th>
              <th scope="col" className="h-9 px-3 font-medium">
                {messageText("ui.utilization.col_cpu", "en")}
              </th>
              <th scope="col" className="h-9 px-3 font-medium">
                {messageText("ui.utilization.col_memory", "en")}
              </th>
              <th scope="col" className="h-9 px-4 font-medium md:px-5">
                {messageText("ui.utilization.col_finding", "en")}
              </th>
            </tr>
          </thead>
          <tbody>
            {machines.map((machine) => (
              <tr key={machine.resourceId} className="border-b border-border/60 last:border-b-0">
                <td className="h-14 px-4 font-mono text-[13px] md:px-5" title={machine.resourceId}>
                  {machine.name}
                </td>
                <td className="px-3">
                  <Bar value={machine.cpuAvg} text={`${machine.cpuText}%`} tone="cpu" />
                </td>
                <td className="px-3">
                  {machine.memoryAvg === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Bar value={machine.memoryAvg} text={`${machine.memoryText}%`} tone="memory" />
                  )}
                </td>
                <td className="px-4 text-xs md:px-5">
                  {machine.cpuAvg < IDLE_CPU_PERCENT ? (
                    <span className="text-(--status-attention)">
                      {messageText("ui.utilization.idle", "en", { percent: IDLE_CPU_PERCENT })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Bar({
  value,
  text,
  tone,
}: Readonly<{ value: number; text: string; tone: "cpu" | "memory" }>) {
  const width = Math.max(1, Math.min(100, value))
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-3">
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.max(0, value))}
        aria-valuetext={text}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={tone === "cpu" ? "block h-full rounded-full bg-primary" : "block h-full rounded-full bg-(--soga)"}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="text-right font-mono text-[13px] tabular-nums">{text}</span>
    </div>
  )
}
