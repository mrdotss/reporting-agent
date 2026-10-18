"use client"

import { useHotkeys } from "react-hotkeys-hook"

import { Canvas } from "@/components/builder/canvas/canvas"
import {
  BuilderProvider,
  useBuilder,
  useBuilderStore,
  type BuilderEnvironment,
} from "@/components/builder/context"
import { Inspector } from "@/components/builder/inspector/inspector"
import { Segmented } from "@/components/builder/left/theme-panel"
import { AddPanel } from "@/components/builder/left/add-panel"
import { DocumentPanel } from "@/components/builder/left/document-panel"
import { Outline } from "@/components/builder/left/outline"
import { ThemePanel } from "@/components/builder/left/theme-panel"
import { TopBar } from "@/components/builder/top-bar"
import { useAutosave } from "@/components/builder/use-autosave"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import type { DefinitionV4 } from "@/lib/builder/model"
import type { LeftTab } from "@/lib/builder/store"

/**
 * The preset builder: an outline and its panels on the left, the live page in the middle,
 * the selected block's settings on the right.
 *
 * The one client boundary on the screen. Every panel reads the same store through
 * `BuilderProvider`, so a block selected on the page is the one the outline highlights and
 * the inspector edits.
 */

export function Builder({
  initial,
  environment,
  draftRevision,
  storedName,
}: Readonly<{
  initial: DefinitionV4
  environment: BuilderEnvironment
  draftRevision: number
  storedName: string
}>) {
  return (
    <BuilderProvider initial={initial} environment={environment}>
      <BuilderScreen environment={environment} draftRevision={draftRevision} storedName={storedName} />
    </BuilderProvider>
  )
}

function BuilderScreen({
  environment,
  draftRevision,
  storedName,
}: Readonly<{ environment: BuilderEnvironment; draftRevision: number; storedName: string }>) {
  const store = useBuilderStore()
  const leftTab = useBuilder((state) => state.leftTab)
  const setLeftTab = useBuilder((state) => state.setLeftTab)
  const mode = useBuilder((state) => state.mode)
  const autosave = useAutosave({
    templateId: environment.templateId,
    initialRevision: draftRevision,
    initialName: storedName,
  })

  useHotkeys("mod+z", (event) => {
    event.preventDefault()
    store.temporal.getState().undo()
  })
  useHotkeys(["mod+shift+z", "mod+y"], (event) => {
    event.preventDefault()
    store.temporal.getState().redo()
  })
  useHotkeys("escape", () => store.getState().select(null))
  useHotkeys(["alt+up", "alt+down"], (event, handler) => {
    const { selection, moveBlock, moveSection } = store.getState()
    const offset = handler.keys?.includes("up") ? -1 : 1
    event.preventDefault()
    if (selection?.kind === "block") moveBlock(selection.sectionId, selection.ref, offset)
    if (selection?.kind === "section") moveSection(selection.sectionId, offset)
  })
  useHotkeys(["delete", "backspace"], () => {
    const { selection, removeAdded, toggleHidden } = store.getState()
    if (selection?.kind !== "block") return
    if (selection.ref.kind === "added") removeAdded(selection.sectionId, selection.ref.id)
    else if (!(selection.ref.kind === "slot" && selection.ref.slot === "title")) toggleHidden(selection.sectionId, selection.ref)
  })

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <TopBar
        templateId={environment.templateId}
        latestVersion={environment.latestVersion}
        save={autosave.save}
        saveState={autosave.state}
        revisionRef={autosave.revisionRef}
      />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        {mode === "edit" && (
          <>
            <ResizablePanel defaultSize={276} minSize={232} maxSize={400} className="flex min-h-0 flex-col bg-muted/30">
              <div className="p-2.5 pb-1.5">
                <Segmented<LeftTab>
                  label="Left panel"
                  value={leftTab}
                  options={[
                    { value: "outline", label: "Outline" },
                    { value: "add", label: "Add" },
                    { value: "theme", label: "Theme" },
                    { value: "document", label: "Document" },
                  ]}
                  onChange={setLeftTab}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-2.5">
                {leftTab === "outline" && <Outline />}
                {leftTab === "add" && <AddPanel />}
                {leftTab === "theme" && <ThemePanel />}
                {leftTab === "document" && <DocumentPanel />}
              </div>
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}
        <ResizablePanel minSize={360} className="min-h-0">
          <Canvas />
        </ResizablePanel>
        {mode === "edit" && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize={320} minSize={280} maxSize={460} className="min-h-0">
              <aside aria-label="Inspector" className="h-full overflow-auto p-3.5">
                <Inspector />
              </aside>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}
