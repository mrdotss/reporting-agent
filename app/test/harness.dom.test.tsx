import { afterEach, expect, test } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

// The jsdom half of the harness self-test: a document exists, the React plugin
// compiles JSX, and the jest-dom matchers are registered on Vitest's `expect`.

afterEach(cleanup)

test("jsdom project provides a document", () => {
  expect(typeof document).toBe("object")
  expect(document.body).toBeTruthy()
})

test("JSX renders and the jest-dom matchers are registered", () => {
  render(<p data-testid="harness-probe">verified</p>)
  expect(screen.getByTestId("harness-probe")).toBeInTheDocument()
})
