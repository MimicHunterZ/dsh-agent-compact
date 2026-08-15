// @mimichunterz/agent-compact: shared optimizer core (import-free).
//
// The tools plugin (lib/index.js) lazily patches the host compaction engine on
// first tool use via patchEngine(). The ONLY thing the patch does is make the
// engine's summarize() honor agent-provided checkpoints:
//
//   - context_compact hands the agent-written Markdown checkpoint to the
//     engine through _externalSummary (one-shot, keyed per session id);
//   - the patched summarize() returns that text directly — no LLM call, no
//     re-summarization — while the whole durable transaction (boundary
//     validation, tool-pair balance, compaction/start-end markers, surface
//     replace, spill archive) stays in the stock engine;
//   - every other path (automatic pressure/overflow, /compact) is untouched:
//     with no injected checkpoint the patched summarize() forwards straight to
//     the stock implementation, so automatic compaction keeps the official
//     behavior exactly.

export interface SurfaceNode {
  seq: number
  [key: string]: unknown
}

export interface SessionLike {
  id: string
  surface?: { nodes?: readonly number[] }
  events?: readonly unknown[]
  // `SessionEvent` is not exported by the packages; `any` keeps the structural
  // shape assignable to the real `(event: SessionEvent) => Message | null`.
  deriveEventMessage?: (event: any) => unknown
  requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
}

export interface AgentLike {
  session?: SessionLike
  options?: { provider?: string; model?: string }
  ctx?: unknown
}

/** The engine surface the patch relies on (structural and defensive; the real
 * engine is a BasicCompactionEngine, which carries these members). */
export interface OptimizedEngineLike {
  /**
   * Agent-provided checkpoint text, keyed per session id (one-shot: consumed
   * by the next summarize for that session). When present, the patched
   * summarize() returns this text as the summary — the executing agent writes
   * the replacement checkpoint itself, so no LLM summarizer call is made.
   */
  _externalSummary?: Record<string, string>
  summarize?: (input: unknown, agent: unknown, signal?: AbortSignal) => Promise<unknown>
  /** Patch version; bump when patch behavior changes (see below). */
  __ctxcOptimized?: number
}

// The compaction engine is a host-level singleton that survives plugin HMR.
// A plain boolean guard would freeze the summarize closure on the FIRST patch,
// so later optimizer edits (e.g. the checkpoint injection) would never take
// effect until a process restart. The versioned guard re-binds summarize on
// every patch so code edits hot-apply.
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
      // Same runtime shape the stock summarizer returns (text summary +
      // usage envelope); the engine's frameSummary + size check still apply.
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
