import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { Composer } from "@/components/chat/composer"

afterEach(cleanup)

function write(text: string) {
  fireEvent.change(screen.getByLabelText("Ask about the attached usage"), { target: { value: text } })
}

describe("Composer", () => {
  test("sends the question with the chosen model when something is attached", async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    render(<Composer attachedCount={1} busy={false} onSend={onSend} onAttach={vi.fn()} />)
    write("Which VMs could move down a size?")
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Which VMs could move down a size?", "kimi-k3"))
  })

  test("refuses to send with nothing attached, and says why", () => {
    const onSend = vi.fn()
    render(<Composer attachedCount={0} busy={false} onSend={onSend} onAttach={vi.fn()} />)
    write("Anything?")
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole("status").textContent).toMatch(/Choose a verified report/)
  })

  test("keeps the question when the send fails", async () => {
    const onSend = vi.fn().mockResolvedValue(false)
    render(<Composer attachedCount={1} busy={false} onSend={onSend} onAttach={vi.fn()} />)
    write("Try again")
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByLabelText("Ask about the attached usage") as HTMLTextAreaElement).value).toBe("Try again"))
  })

  test("carries the key to the three kinds of figure", () => {
    render(<Composer attachedCount={1} busy={false} onSend={vi.fn()} onAttach={vi.fn()} />)
    const key = screen.getByRole("list", { name: "How figures are marked" })
    expect(key.textContent).toContain("traced to a verified report or price")
    expect(key.textContent).toContain("live, not verified")
    expect(key.textContent).toContain("estimate")
  })

  test("opens the attach dialog", () => {
    const onAttach = vi.fn()
    render(<Composer attachedCount={0} busy={false} onSend={vi.fn()} onAttach={onAttach} />)
    fireEvent.click(screen.getByRole("button", { name: "Attach" }))
    expect(onAttach).toHaveBeenCalled()
  })
})
