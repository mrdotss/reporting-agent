import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { registerAction } = vi.hoisted(() => ({ registerAction: vi.fn() }))
vi.mock("@/lib/actions/auth", () => ({ registerAction }))

import { RegisterForm } from "@/components/auth/register-form"

/**
 * The sign-up form (roles-and-ask-access Req 8): hints that say what to do, and a
 * rejection shown on the field it is about.
 */

beforeEach(() => {
  registerAction.mockReset()
})

afterEach(() => {
  cleanup()
})

function submit(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } })
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } })
  fireEvent.click(screen.getByRole("button", { name: "Create account" }))
}

describe("RegisterForm", () => {
  test("the hints state what to meet and advertise no maximum", () => {
    const { container } = render(<RegisterForm />)
    expect(screen.getByText("At least 12 characters.")).toBeTruthy()
    expect(container.textContent).not.toMatch(/254|256|at most/)
  })

  test("a password rejection shows under the password and keeps the email typed", async () => {
    registerAction.mockResolvedValue({
      status: "error",
      message: "Use at least 12 characters.",
      field: "password",
    })
    render(<RegisterForm />)
    submit("ada@example.com", "short")

    const password = screen.getByLabelText("Password")
    await waitFor(() => expect(password.getAttribute("aria-invalid")).toBe("true"))
    const describedBy = password.getAttribute("aria-describedby") ?? ""
    const error = document.getElementById(describedBy.split(" ")[0] ?? "")
    expect(error?.textContent).toBe("Use at least 12 characters.")
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBeNull()
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.com")
  })

  test("an unavailable email is one message above the form, on no field", async () => {
    registerAction.mockResolvedValue({
      status: "error",
      message: "That email address is not available.",
    })
    render(<RegisterForm />)
    submit("ada@example.com", "a long enough password")

    await screen.findByText("That email address is not available.")
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBeNull()
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBeNull()
  })
})
