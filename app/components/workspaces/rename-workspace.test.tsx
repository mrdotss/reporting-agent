import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { refresh, workspaceMutation } = vi.hoisted(() => ({
  refresh: vi.fn(),
  workspaceMutation: vi.fn(),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))
vi.mock("@/components/workspaces/workspace-context", () => ({ workspaceMutation }))

import { RenameWorkspace } from "@/components/workspaces/rename-workspace"

/** Renaming a workspace from Workspace settings (roles-and-ask-access Req 10). */

beforeEach(() => {
  refresh.mockReset()
  workspaceMutation.mockReset()
})

afterEach(() => {
  cleanup()
})

async function openAndType(name: string) {
  render(<RenameWorkspace workspaceId="ws_1" name="My workspace" />)
  fireEvent.click(screen.getByRole("button", { name: "Rename" }))
  fireEvent.change(await screen.findByLabelText("Workspace name"), {
    target: { value: name },
  })
}

describe("RenameWorkspace", () => {
  test("saves the trimmed name and refreshes the shell", async () => {
    workspaceMutation.mockResolvedValue({ ok: true })
    await openAndType("  FATechID  ")

    fireEvent.click(screen.getByRole("button", { name: "Save name" }))

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(workspaceMutation).toHaveBeenCalledWith({
      action: "rename_workspace",
      workspaceId: "ws_1",
      name: "FATechID",
    })
  })

  test("an unchanged or blank name cannot be saved", async () => {
    await openAndType("My workspace")
    expect(
      (screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement).disabled
    ).toBe(true)

    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "   " } })
    expect(
      (screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(workspaceMutation).not.toHaveBeenCalled()
  })

  test("a refused rename says why and does not refresh", async () => {
    workspaceMutation.mockRejectedValue(new Error("The change could not be saved."))
    await openAndType("FATechID")

    fireEvent.click(screen.getByRole("button", { name: "Save name" }))

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The change could not be saved."
    )
    expect(refresh).not.toHaveBeenCalled()
  })
})
