import { afterEach, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { LiveThemePreview } from "./live-theme-preview"
import type { DesignSpec } from "@/lib/templates/definition"
afterEach(cleanup)
const design = {
  preset: "technical",
  accent_color: "#6d4c91",
  density: "normal",
  table_style: "bordered",
} as DesignSpec

test("theme samples are live and update the accent without requesting images", () => {
  const { container, rerender } = render(
    <LiveThemePreview design={design} onSelect={() => {}} />
  )
  expect(screen.getAllByRole("radio")).toHaveLength(4)
  expect(container.querySelector("img")).toBeNull()
  expect(container.innerHTML).toContain("rgb(109, 76, 145)")
  rerender(
    <LiveThemePreview
      design={{ ...design, accent_color: "#a34d24" }}
      onSelect={() => {}}
    />
  )
  expect(container.innerHTML).toContain("rgb(163, 77, 36)")
  expect(container.innerHTML).not.toContain("rgb(109, 76, 145)")
})
test("theme cards can be selected with the keyboard", () => {
  const onSelect = vi.fn()
  render(<LiveThemePreview design={design} onSelect={onSelect} />)
  fireEvent.keyDown(screen.getByRole("radio", { name: /technical:/ }), {
    key: "ArrowRight",
  })
  expect(onSelect).toHaveBeenCalledWith("minimal")
  expect(screen.getByRole("radio", { name: /minimal:/ })).toHaveFocus()
})
