// @mimichunterz/agent-compact: OptimizedCompactionEngine (optional preset-level wiring).
//
// The official extension point of `@deepseek-ai/dsh-compaction-basic` is the
// `summarize()` hook; the stock engine's own buildSummarizationInput feeds it
// ONLY the region messages, which forfeits KV-cache reuse for mid-conversation
// spans. This subclass overrides two methods:
//
//   - compactRegion() stashes the region boundary so the summarizer can
//     rebuild the input as the full context up to the region end;
//   - summarize() runs the optimized full-context + scoped #k..#m summarizer
//     (see ./optimizer.js), while the whole durable transaction — boundary
//     validation, tool-pair balance, compaction/start-end markers, replace —
//     stays in the stock engine via `super`.
//
// To use instead of the stock engine, mount this subpath inside a preset's
// `compaction` isolate realm (replacing the `compaction-basic` row) once the
// package is installed in the profile:
//
//   - id: compaction-basic
//     name: '@mimichunterz/agent-compact/engine'
//
// The durable policy (threshold, retention) comes from the inherited
// BasicCompactionEngine config.

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { runOptimizedSummarize } from './optimizer.js'
import type { OptimizedEngineLike, SummarizationInputLike } from './optimizer.js'

export default class OptimizedCompactionEngine extends BasicCompactionEngine {
  _pending?: { start: number; end: number }

  _lastDiag?: {
    surfaceNodes: number
    sentMessages: number
    k: number
    m: number
    regionStart: number
    regionEnd: number
  }

  async compactRegion(start: number, end: number, agent: Agent, signal?: AbortSignal) {
    this._pending = { start, end }
    return super.compactRegion(start, end, agent, signal)
  }

  // The base class declares `summarize(input: SummarizationInput, ...)`, but
  // those internal types are not exported from the package; `any` keeps the
  // override signature compatible while the optimized run still returns the
  // same runtime shape (text summary + usage envelope).
  protected summarize(input: SummarizationInputLike, agent: Agent, signal?: AbortSignal): Promise<any> {
    return runOptimizedSummarize(this as unknown as OptimizedEngineLike, input, agent, signal)
  }
}
