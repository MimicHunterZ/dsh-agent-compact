// @mimichunterz/agent-compact: 共享的优化器核心（零依赖）。
// patchEngine() 修补主机压缩引擎的 summarize()，使其尊重 agent 提供的检查点
// （_externalSummary，一次性、按会话 id 为键）：存在时直接返回该文本（不发
// LLM 请求）；不存在时转发原版实现，自动压缩行为保持不变。

export interface SurfaceNode {
  seq: number
  [key: string]: unknown
}

export interface SessionLike {
  id: string
  surface?: { nodes?: readonly number[] }
  events?: readonly unknown[]
  // `SessionEvent` 没有被这些包导出；`any` 让结构形状可以赋值给真实的
  // `(event: SessionEvent) => Message | null`。
  deriveEventMessage?: (event: any) => unknown
  requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
}

export interface AgentLike {
  session?: SessionLike
  options?: { provider?: string; model?: string }
  ctx?: unknown
}

/** 修补所依赖的引擎表面（结构化且防御性；真实引擎是 BasicCompactionEngine，
 * 携带这些成员）。 */
export interface OptimizedEngineLike {
  /**
   * agent 提供的检查点文本，按会话 id 为键（一次性：被该会话的下一次
   * summarize 消费）。存在时，被修补的 summarize() 直接把它作为摘要返回——
   * 执行中的 agent 自行编写替换检查点，因此不会发起 LLM 摘要调用。
   */
  _externalSummary?: Record<string, string>
  summarize?: (input: unknown, agent: unknown, signal?: AbortSignal) => Promise<unknown>
  /** 补丁版本；修补行为变化时递增（见下文）。 */
  __ctxcOptimized?: number
}

// 压缩引擎是主机级单例（HMR 后存活），用带版本的守卫在每次修补时重新绑定
// summarize，使代码修改可以热生效。
export const PATCH_VERSION = 3

export function patchEngine(engine: OptimizedEngineLike): boolean {
  if (!engine || typeof engine.summarize !== 'function') return false
  if (engine.__ctxcOptimized === PATCH_VERSION) return true
  const origSummarize = engine.summarize.bind(engine)
  engine.summarize = async function (this: OptimizedEngineLike, input: unknown, agent: unknown, signal?: AbortSignal) {
    const a = agent as AgentLike | undefined
    const sid = a && a.session && a.session.id ? a.session.id : undefined
    const ext = this._externalSummary
    if (sid && ext && typeof ext[sid] === 'string') {
      const text = ext[sid]
      delete ext[sid]
      // 与原版 summarizer 返回的运行时形状相同（文本摘要 + usage 信封）；
      // 引擎的 frameSummary 与大小检查仍然生效。
      return {
        summary: [{ type: 'text', text }],
        rawOutput: [],
        llmStreamCall: false,
        provider: 'agent',
        model: 'agent',
        maxTokens: 0,
      }
    }
    return origSummarize(input, agent, signal)
  }
  engine.__ctxcOptimized = PATCH_VERSION
  return true
}
