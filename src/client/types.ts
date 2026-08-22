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
  // 估算 token 数（启发式，非真实计费值）。可选：宿主进程不热重载、客户端会，
  // 两端有更新窗口期，必需字段会让校验整体失败。
  readonly tokens?: number
  readonly blocks: readonly CtxSurfaceBlock[]
  // 镜像 ../ctx-surface.ts：原始 `data.source.kind`，区分真实用户轮次与
  // 合成注入的 "context" 行。
  readonly source?: string
}

export interface InputActions {
  setDraft?(text: string): void
}

// 会话快照的最小切片：只声明本面板真正读取的字段，往小了声明以降低随宿主
// 升级漂移的风险。
export interface CtxSurfaceSessionSnapshot {
  readonly chat?: { readonly order?: readonly unknown[] }
}

// `conversation.view` Slot 的 `scope: "session"` 会让宿主为每个占位组件统一
// 注入这个 hook（inject 回调无需返回它）。用它订阅会话快照，让面板随消息
// 增长自动刷新，而不必自己起定时器轮询。
export type UseSessionHook = <T>(
  selector: (snapshot: CtxSurfaceSessionSnapshot) => T,
  equalityFn?: (a: T, b: T) => boolean,
) => T

export interface CtxSurfaceViewProps {
  readonly sessionId: string
  readonly readSurface: (request: { sessionId: string }) => Promise<
    | { ok: true; value: { rows: readonly CtxSurfaceRow[] } }
    | { ok: false; error: { code: string; message?: string } }
  >
  readonly inputActions?: InputActions
  readonly useSession: UseSessionHook
}
