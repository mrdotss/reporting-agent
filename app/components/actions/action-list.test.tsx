import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import { ActionList, actionsCsv } from "@/components/actions/action-list"
import type { ActionItemView } from "@/lib/action-register/store"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SEP = "2026-09"

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

const rows = () => screen.queryAllByRole("row").filter((row) => row.hasAttribute("data-status"))
const titles = () => rows().map((row) => within(row).getAllByRole("button")[0]!.textContent)
const tab = (name: RegExp) => screen.getByRole("tab", { name })

describe("ActionList", () => {
  test("shows the items it is given now, not the ones it first rendered", () => {
    const { rerender } = render(<ActionList items={[item("a1", "Back up vm-a", "Acme")]} canEdit={false} newMonth={SEP} />)
    expect(titles()).toEqual(["Back up vm-a"])

    // Switching to a customer with no actions must not keep the previous customer's list.
    rerender(<ActionList items={[]} canEdit={false} newMonth={SEP} />)
    expect(rows()).toHaveLength(0)
    expect(screen.getByText(/No actions yet/)).toBeInTheDocument()

    rerender(<ActionList items={[item("b1", "Back up vm-b", "Globex")]} canEdit={false} newMonth={SEP} />)
    expect(titles()).toEqual(["Back up vm-b"])
  })

  test("tabs split the items by status and count them, and New is the month being closed", () => {
    render(
      <ActionList
        items={[
          item("a1", "Back up vm-a", "Acme"),
          item("a2", "vm-b: Stopped", "Acme", { kind: "housekeeping", firstSeenPeriod: "2026-09-01" }),
          item("a3", "Back up vm-c", "Acme", { status: "wont_do", note: "Dev box" }),
          item("a4", "Back up vm-d", "Acme", { status: "resolved", resolvedRunId: "run-2" }),
        ]}
        canEdit={false}
        newMonth={SEP}
      />
    )
    expect(tab(/To act on/)).toHaveTextContent("2")
    expect(tab(/To act on/)).toHaveTextContent("2 without an owner")
    expect(titles()).toEqual(["Back up vm-a", "vm-b: Stopped"])

    fireEvent.click(tab(/New this month/))
    expect(tab(/New this month/)).toHaveTextContent("First found in September 2026")
    expect(titles()).toEqual(["vm-b: Stopped"])

    fireEvent.click(tab(/Won.t do/))
    expect(titles()).toEqual(["Back up vm-c"])

    fireEvent.click(tab(/Resolved/))
    expect(titles()).toEqual(["Back up vm-d"])
  })

  test("All customers names each item's customer and filters by one from the band", () => {
    render(
      <ActionList
        items={[item("a1", "Back up vm-a", "Acme"), item("b1", "Back up vm-b", "Globex")]}
        canEdit={false}
        showCustomer
        newMonth={SEP}
      />
    )
    expect(screen.getByRole("columnheader", { name: "Customer" })).toBeInTheDocument()
    expect(screen.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Acme", "Globex"])

    const band = screen.getByRole("region", { name: "By customer" })
    fireEvent.click(within(band).getByRole("button", { name: /Globex/ }))
    expect(titles()).toEqual(["Back up vm-b"])
  })

  test("a single customer has no customer column or band", () => {
    render(<ActionList items={[item("a1", "Back up vm-a", "Acme")]} canEdit={false} newMonth={SEP} />)
    expect(screen.queryByRole("columnheader", { name: "Customer" })).toBeNull()
    expect(screen.queryByRole("region", { name: "By customer" })).toBeNull()
  })

  test("search and kind narrow the list", () => {
    render(
      <ActionList
        items={[
          item("a1", "Back up vm-a", "Acme"),
          item("a2", "vm-b: Stopped", "Acme", { kind: "housekeeping" }),
        ]}
        canEdit={false}
        newMonth={SEP}
      />
    )
    fireEvent.click(within(screen.getByRole("group", { name: "Kind" })).getByRole("button", { name: "Housekeeping" }))
    expect(titles()).toEqual(["vm-b: Stopped"])

    fireEvent.click(within(screen.getByRole("group", { name: "Kind" })).getByRole("button", { name: "All kinds" }))
    fireEvent.change(screen.getByLabelText("Search actions"), { target: { value: "vm-a" } })
    expect(titles()).toEqual(["Back up vm-a"])
  })

  test("a saved change moves the item and survives a re-render with the same items", async () => {
    const saved = item("a1", "Back up vm-a", "Acme", { status: "wont_do", note: "Dev box" })
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ item: saved }), { status: 200 })
    )
    vi.stubGlobal("fetch", fetchMock)
    const items = [item("a1", "Back up vm-a", "Acme")]
    const { rerender } = render(<ActionList items={items} canEdit newMonth={SEP} />)

    fireEvent.click(screen.getByRole("button", { name: "Back up vm-a" }))
    const status = await screen.findByRole("group", { name: "Status" })
    fireEvent.click(within(status).getByRole("button", { name: "Won't do" }))
    // Won't do needs its reason first.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText("What was agreed, and by whom"), { target: { value: "Dev box" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ owner: null, status: "wont_do", note: "Dev box" })

    expect(await screen.findByText("Saved")).toBeInTheDocument()
    // On a narrow screen the editor is a sheet over the list; close it to see the list again.
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    fireEvent.click(tab(/Won.t do/))
    expect(titles()).toEqual(["Back up vm-a"])

    rerender(<ActionList items={items} canEdit newMonth={SEP} />)
    expect(titles()).toEqual(["Back up vm-a"])
  })

  test("selected rows take an owner together", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const id = url.split("/").pop()!
      const body = JSON.parse(String(init!.body)) as { owner: "msp" }
      return new Response(JSON.stringify({ item: item(id, `Item ${id}`, "Acme", { owner: body.owner }) }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    render(
      <ActionList
        items={[item("a1", "Item a1", "Acme"), item("a2", "Item a2", "Acme"), item("a3", "Item a3", "Acme")]}
        canEdit
        newMonth={SEP}
      />
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Item a1" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Item a3" }))
    const bar = screen.getByRole("toolbar", { name: "Selected actions" })
    expect(bar).toHaveTextContent("2 selected")
    fireEvent.click(within(bar).getByRole("button", { name: "MSP" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/actions/a1", "/api/actions/a3"])
    await waitFor(() => expect(screen.getByLabelText("Owner filter")).toBeInTheDocument())
    expect(rows().map((row) => within(row).getByText(/Unassigned|MSP/).textContent)).toEqual(["MSP", "Unassigned", "MSP"])
  })

  test("the CSV quotes what needs quoting", () => {
    expect(actionsCsv([item("a1", 'Resize "big", now', "Acme", { note: "line one\nline two", owner: "msp" })])).toBe(
      'Customer,Connector,Kind,Finding,Owner,Status,First seen,Note\nAcme,prod-account,Backup,"Resize ""big"", now",MSP,Open,2026-08,"line one\nline two"\n'
    )
  })
})
