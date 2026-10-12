import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import { ActionList } from "@/components/actions/action-list"
import type { ActionItemView } from "@/lib/action-register/store"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function item(id: string, title: string, customer: string, over: Partial<ActionItemView> = {}): ActionItemView {
  return {
    id,
    kind: "backup",
    title,
    owner: null,
    status: "open",
    note: null,
    connector: "prod-account",
    customer,
    firstSeenPeriod: "2026-08-01",
    lastSeenRunId: "run-1",
    resolvedRunId: null,
    resolvedSnapshotId: null,
    ...over,
  }
}

describe("ActionList", () => {
  test("shows the items it is given now, not the ones it first rendered", () => {
    const { rerender } = render(<ActionList items={[item("a1", "Back up vm-a", "Acme")]} canEdit={false} />)
    expect(screen.getByText("Back up vm-a")).toBeInTheDocument()

    // Switching to a customer with no actions must not keep the previous customer's list.
    rerender(<ActionList items={[]} canEdit={false} />)
    expect(screen.queryByText("Back up vm-a")).toBeNull()
    expect(screen.getByText(/No actions yet/)).toBeInTheDocument()

    rerender(<ActionList items={[item("b1", "Back up vm-b", "Globex")]} canEdit={false} />)
    expect(screen.getByText("Back up vm-b")).toBeInTheDocument()
  })

  test("names each item's customer when listing every customer", () => {
    render(
      <ActionList
        items={[item("a1", "Back up vm-a", "Acme"), item("b1", "Back up vm-b", "Globex")]}
        canEdit={false}
        showCustomer
      />
    )
    expect(screen.getByText("Back up vm-a").nextElementSibling).toHaveTextContent("Acme")
    expect(screen.getByText("Back up vm-b").nextElementSibling).toHaveTextContent("Globex")
  })

  test("leaves the customer out for a single customer", () => {
    render(<ActionList items={[item("a1", "Back up vm-a", "Acme")]} canEdit={false} />)
    expect(screen.getByText("Back up vm-a").nextElementSibling).not.toHaveTextContent("Acme")
  })

  test("a saved change moves the item and survives a re-render with the same items", async () => {
    const saved = item("a1", "Back up vm-a", "Acme", { status: "wont_do", note: "Dev box" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ item: saved }), { status: 200 }))
    )
    const items = [item("a1", "Back up vm-a", "Acme")]
    const { rerender } = render(<ActionList items={items} canEdit />)

    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Dev box" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    const wont = await screen.findByRole("region", { name: "Won't do" })
    await waitFor(() => expect(within(wont).getByText("Back up vm-a")).toBeInTheDocument())

    rerender(<ActionList items={items} canEdit />)
    expect(within(screen.getByRole("region", { name: "Won't do" })).getByText("Back up vm-a")).toBeInTheDocument()
  })
})
