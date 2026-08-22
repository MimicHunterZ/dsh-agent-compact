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

// 会话快照的最小切片：只声明本面板真正读取的字段。这不是
// dsh-client-ui-conversation 对外发布的公开类型（没有 @deepseek-ai/dsh-client-ui-conversation
// 的类型依赖），形状是照着官方 trajectory 面板（TrajectoryView 用
// `s.chat.order`/`s.chat.nodes` 等字段）反推出来的，往小了声明以降低随宿主
// 升级漂移的风险。
export interface CtxSurfaceSessionSnapshot {
  readonly chat?: { readonly order?: readonly unknown[] }
}

// `conversation.view` Slot 声明的是 `scope: "session"`；宿主的 Slot 框架
// （dsh-client-ui-renderer 的 standardProps/standardKit）对这个 scope 下的
// 每一个占位组件都统一注入这个 hook，不需要本插件自己的 `inject` 回调显式
// 返回它——官方 trajectory 面板的 TrajectoryView 组件同样只是在函数签名里
// 解构 `useSession`，自己的 inject 回调里也没有返回过它，对照确认过。
// 用它订阅会话快照，让面板随消息增长自动刷新，而不必自己起定时器轮询。
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
