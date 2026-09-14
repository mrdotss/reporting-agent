"use client"

import { useEffect, useState } from "react"
import { ArrowCounterClockwiseIcon, StopIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { messageText } from "@/lib/messages/catalog"

/** Dispatched by the header button; `RunReplay` listens. */
export const REPLAY_TOGGLE_EVENT = "run-replay:toggle"
/** Dispatched by `RunReplay` whenever it starts or stops; the button listens. */
export const REPLAY_STATE_EVENT = "run-replay:state"

/**
 * "Watch this run", beside Download in the report header.
 *
 * The replay itself lives in the Run card further down; the two talk through a window
 * event rather than shared state because one is in the page header and the other is a
 * separate client island, and neither owns the other.
 */
export function WatchRunButton() {
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const onState = (event: Event) =>
      setPlaying(Boolean((event as CustomEvent<{ playing: boolean }>).detail?.playing))
    window.addEventListener(REPLAY_STATE_EVENT, onState)
    return () => window.removeEventListener(REPLAY_STATE_EVENT, onState)
  }, [])

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(REPLAY_TOGGLE_EVENT))
        document.getElementById("run-replay-title")?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        })
      }}
    >
      {playing ? (
        <StopIcon aria-hidden="true" />
      ) : (
        <ArrowCounterClockwiseIcon aria-hidden="true" />
      )}
      {playing
        ? messageText("ui.run_replay.stop", "en")
        : messageText("ui.run_replay.watch", "en")}
    </Button>
  )
}
