// Shared client-side types for the ctx-surface panel. Mirrors the wire
// shapes in ../ctx-surface.ts (kept as plain duplicated types here because
// this file compiles under a separate esbuild pass with `react`/jsx that the
// main tsc project does not need to see — see scripts/build-client.mjs).

export interface CtxSurfaceBlock {
  readonly kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'image' | 'block'
  readonly label?: string
  readonly text: string
  readonly chars: number
}

export interface CtxSurfaceRow {
  readonly seq: number
  readonly type: string
  readonly text: string
  readonly chars: number
  readonly blocks: readonly CtxSurfaceBlock[]
}

export interface InputActions {
  setDraft?(text: string): void
}

export interface CtxSurfaceViewProps {
  readonly sessionId: string
  readonly readSurface: (request: { sessionId: string }) => Promise<
    | { ok: true; value: { rows: readonly CtxSurfaceRow[] } }
    | { ok: false; error: { code: string; message?: string } }
  >
  readonly inputActions?: InputActions
}
