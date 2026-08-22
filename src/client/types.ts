// ctx-surface 面板的客户端类型，镜像 ../ctx-surface.ts 的线上类型。

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
  // 镜像 ../ctx-surface.ts：原始 `data.source.kind`，区分真实用户轮次与
  // 合成注入的 "context" 行。
  readonly source?: string
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
