import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ModelPicker } from "@/components/chat/models-picker"

afterEach(cleanup)

describe("ModelPicker", () => {
  test("shows both models and which one is chosen", () => {
    render(<ModelPicker value="kimi-k3" onChange={vi.fn()} />)
    const radios = screen.getAllByRole("radio")
    expect(radios.map((radio) => radio.textContent)).toEqual(["K3·Careful", "K2.5·Fast"])
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true")
    expect(radios[1]!.getAttribute("aria-checked")).toBe("false")
  })

  test("choosing the other model reports it", () => {
    const onChange = vi.fn()
    render(<ModelPicker value="kimi-k3" onChange={onChange} />)
    fireEvent.click(screen.getAllByRole("radio")[1]!)
    expect(onChange).toHaveBeenCalledWith("kimi-k2.5")
  })

  test("is inert while an answer is being written", () => {
    const onChange = vi.fn()
    render(<ModelPicker value="kimi-k3" onChange={onChange} disabled />)
    fireEvent.click(screen.getAllByRole("radio")[1]!)
    expect(onChange).not.toHaveBeenCalled()
  })
})
