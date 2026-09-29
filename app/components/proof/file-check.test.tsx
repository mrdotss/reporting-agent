import { createHash } from "node:crypto"

import { afterEach, describe, expect, test } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { FileCheck } from "@/components/proof/file-check"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

function choose(name: string, content: string) {
  const file = new File([content], name, { type: "application/pdf" })
  fireEvent.change(screen.getByLabelText(/Drop the report/), { target: { files: [file] } })
}

afterEach(cleanup)

describe("FileCheck", () => {
  test("the designed PDF matches as the verified designed PDF", async () => {
    render(<FileCheck pdfSha256={sha("plain")} docxSha256={sha("word")} styledPdfSha256={sha("designed")} />)
    choose("report-styled.pdf", "designed")
    expect(await screen.findByText(/is the verified designed PDF, unchanged/)).toBeInTheDocument()
  })

  test("the plain PDF still matches, and an edited file does not", async () => {
    render(<FileCheck pdfSha256={sha("plain")} docxSha256={sha("word")} styledPdfSha256={sha("designed")} />)
    choose("report.pdf", "plain")
    expect(await screen.findByText(/is the verified PDF, unchanged/)).toBeInTheDocument()
    choose("report.pdf", "plain, edited")
    expect(await screen.findByText(/does not match any file of this verified report/)).toBeInTheDocument()
  })

  test("a run with no designed copy matches nothing extra", async () => {
    render(<FileCheck pdfSha256={sha("plain")} docxSha256={sha("word")} styledPdfSha256={null} />)
    choose("report-styled.pdf", "designed")
    expect(await screen.findByText(/does not match any file/)).toBeInTheDocument()
  })
})
