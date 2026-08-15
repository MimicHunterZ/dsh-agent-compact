// @mimichunterz/agent-compact: shared optimizer core (import-free).
//
// Two entry points consume this module:
//   - lib/index.js  (the installed tools plugin) patches the per-session
//     compaction engine lazily on first tool use via patchEngine().
//   - lib/engine.js (the optional preset-level subclass) calls
//     runOptimizedSummarize() from its overridden summarize().
//
// Why full-context input + a scoped instruction: the stock engine feeds the
// summarizer ONLY the region messages, so a mid-conversation compaction misses
// the provider KV cache for the whole region (measured: 88% input cache-hit,
// miss grows with region size). Sending the FULL context from surface[0] to
// the region end makes the summarization request a genuine prefix of the last
// routed request (~99% cache-hit, miss = instruction only). Boundary info goes
// in the trailing instruction as 1-based message indices (#k..#m) — never in
// the message stream, because inserted markers would break prefix matching and
// cost MORE than stock. See docs/verification.md for the A/B data.

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ToolCallBlock {
  type: 'tool-call'
  name: string
  arguments?: unknown
}

/** Any block the LLM stream can carry; the assembler is defensive by design. */
export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | { type: string; text?: string; [key: string]: unknown }

export interface FinishReason {
  kind: string
  failure?: { message?: string; code?: string }
}

export interface StreamChunk {
  type: string
  index?: number
  blockType?: string
  text?: string
  block?: ContentBlock
  usage?: unknown
  reason?: FinishReason
  [key: string]: unknown
}

export interface Assembler {
  push(chunk: StreamChunk): void
  blocks(): ContentBlock[]
  readonly usage: unknown
  readonly finish: FinishReason
}

/**
 * The engine surface the optimizer relies on (structural and defensive; the
 * real engine is a BasicCompactionEngine, which carries all these members).
 */
export interface OptimizedEngineLike {
  /**
   * Region boundaries stashed per session id (never a bare `{start, end}`:
   * the engine is a host-level singleton shared by every session, so a single
   * slot would race across concurrent compactions). `compactRegion` writes it;
   * `runOptimizedSummarize` verifies it against the region messages before
   * trusting it, so a stale entry (e.g. a later `/compact` run that bypasses
   * `compactRegion`) is detected and replaced by surface location.
   */
  _pending?: Record<string, { start: number; end: number }>
  _lastDiag?: {
    surfaceNodes: number
    sentMessages: number
    k: number
    m: number
    regionStart: number | null
    regionEnd: number | null
  }
  __ctxcOptimized?: boolean
  config?: unknown
  ctx?: unknown
  compactRegion?: (start: number, end: number, agent: unknown, signal?: AbortSignal) => Promise<unknown>
  summarize?: (input: unknown, agent: unknown, signal?: AbortSignal) => Promise<unknown>
}

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

/** The summarizer input shape the plugin actually touches. */
export interface SummarizationInputLike {
  system?: unknown
  tools?: unknown
  /** The shadowed region's derived messages, in surface order (stock buildSummarizationInput). */
  messages?: readonly unknown[]
}

export interface SummaryResultLike {
  summary: TextBlock[]
  rawOutput: ContentBlock[]
  llmStreamCall: boolean
  provider: string
  model: string
  maxTokens: number
  usage?: unknown
}

export const CHECKPOINT_SPEC = [
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- This invocation is a BACKGROUND COMPACTION SERVICE call, not a user request: output only the checkpoint, never conversational prose, never questions back to the user (no "want me to...?", "let me know", etc.), and never a verbatim or near-verbatim copy of the compressed messages — even when a message already reads like a summary, re-derive the checkpoint structure from the content instead of reproducing the original wording.',
].join('\n')

export function makeScopedInstruction(k: number, m: number, n: number): string {
  return [
    'You are a BACKGROUND COMPACTION SERVICE invoked automatically to condense an earlier span of this conversation. This is NOT a user request and you are not replying to the user: ignore your coding-assistant persona for this output.',
    'The conversation above contains ' + n + ' messages (1-based, counting only the messages above).',
    'Compress ONLY messages #' + k + ' through #' + m + ' into ONE structured checkpoint.',
    'Messages before #' + k + ' are PRIOR established context: read them for the full picture and KV-cache reuse, but do NOT merge them into the checkpoint.',
    'Messages after #' + m + ' are the RECENT live record that stays verbatim: do NOT merge them into the checkpoint either.',
    'If a <compacted-summary> block appears before #' + k + ', it is prior context — do not copy it forward or merge it.',
    'Output ONLY the checkpoint text — no preamble, no closing remarks, no conversational tone, no questions to the user, and never a verbatim copy of the compressed messages.',
    'Keep the checkpoint CONCISE: terse bullets only, target under 2000 output tokens.',
    '',
    CHECKPOINT_SPEC,
  ].join('\n')
}

// Minimal stream assembler (the stock engine uses BlockAssembler from
// @deepseek-ai/dsh-llm; keeping a local replica avoids depending on its
// internal chunk protocol from this module).
export function makeAssembler(): Assembler {
  const partials = new Map<number, { blockType: string; text: string; block?: ContentBlock }>()
  const order: number[] = []
  let usage: unknown
  let finish: FinishReason | undefined
  return {
    push(chunk: StreamChunk) {
      switch (chunk.type) {
        case 'block-start': {
          if (!partials.has(chunk.index!)) {
            order.push(chunk.index!)
            partials.set(chunk.index!, { blockType: chunk.blockType ?? '', text: '' })
          }
          return
        }
        case 'text-delta':
        case 'reasoning-delta': {
          if (!partials.has(chunk.index!)) {
            order.push(chunk.index!)
            partials.set(chunk.index!, {
              blockType: chunk.type === 'text-delta' ? 'text' : 'reasoning',
              text: '',
            })
          }
          const p = partials.get(chunk.index!)
          if (p?.block) return
          p!.text += chunk.text ?? ''
          return
        }
        case 'block-end': {
          if (!partials.has(chunk.index!)) {
            order.push(chunk.index!)
            partials.set(chunk.index!, { blockType: chunk.block?.type ?? '', text: '', block: chunk.block })
            return
          }
          const p = partials.get(chunk.index!)
          if (p?.block) return
          p!.block = chunk.block
          return
        }
        case 'usage': {
          usage = chunk.usage
          return
        }
        case 'finish': {
          finish = chunk.reason
          return
        }
        default:
          return
      }
    },
    blocks(): ContentBlock[] {
      const out: ContentBlock[] = []
      for (const idx of order) {
        const p = partials.get(idx)
        if (!p) continue
        if (p.block) out.push(p.block)
        else if (p.blockType === 'text') out.push({ type: 'text', text: p.text })
        else if (p.blockType === 'reasoning') out.push({ type: 'reasoning', text: p.text })
        else out.push({ type: p.blockType, text: p.text })
      }
      if (finish && finish.kind === 'max-tokens') return out.filter((b) => b.type !== 'tool-call')
      return out
    },
    get usage() {
      return usage
    },
    get finish(): FinishReason {
      return finish || { kind: 'stop' }
    },
  }
}

export function textOfBlocks(blocks: ContentBlock[]): string {
  let out = ''
  for (const b of blocks) {
    const t = (b as { text?: unknown }).text
    if (typeof t === 'string') out += t
  }
  return out
}

export function preview(text: unknown, max: number): string {
  const t = String(text || '')
  return t.length <= max ? t : t.slice(0, max) + '…'
}

interface SummarizationConfig {
  summarizationProvider?: string
  summarizationModel?: string
  maxTokens?: number
}

// The optimized summarization itself. `engine` supplies _pending (region
// boundary), config, and ctx.llm; `input` is the stock engine's built input
// (system/tools reused; its region-only messages are ignored).
export async function runOptimizedSummarize(
  engine: OptimizedEngineLike,
  input: SummarizationInputLike,
  agent: AgentLike,
  signal?: AbortSignal,
  maxTokensOverride?: number,
): Promise<SummaryResultLike> {
  const session = agent.session
  const surface = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : null
  const events = session && session.events
  if (!surface || !events || !session || typeof session.deriveEventMessage !== 'function') {
    throw new Error('optimized summarize: session API unavailable')
  }
  const inputMsgs = Array.isArray(input.messages) ? (input.messages as unknown[]) : null

  // Resolve where the shadowed region sits on the current surface:
  //   1. the per-session boundary stashed by compactRegion, verified against
  //      the region messages the engine itself derived (identity match detects
  //      staleness — e.g. a later `/compact` run bypasses compactRegion);
  //   2. otherwise locate the region by identity-matching its derived messages
  //      in the current surface (covers compactNow and any path that never
  //      stashes a boundary);
  //   3. otherwise fall back to the stock region-only input (correct, but
  //      without the KV-cache reuse for that call).
  let region: { posStart: number; posEnd: number } | null = null
  const pending = engine._pending && session.id ? engine._pending[session.id] : undefined
  if (pending && inputMsgs) {
    const posStart = surface.indexOf(pending.start)
    const posEnd = surface.indexOf(pending.end)
    if (posStart !== -1 && posEnd !== -1 && posStart <= posEnd && regionMessagesMatch(session, events, surface, posStart, posEnd, inputMsgs)) {
      region = { posStart, posEnd }
    }
  }
  if (!region && inputMsgs && inputMsgs.length > 0) {
    region = locateRegionMessages(session, events, surface, inputMsgs)
  }

  let msgs: unknown[]
  let k: number
  let m: number
  let regionStart: number | null
  let regionEnd: number | null
  const stockFallback = (): { msgs: unknown[]; k: number; m: number } => {
    // Stock fallback: only the region messages are sent, and the scoped
    // instruction compresses all of them (#1..#N).
    if (!inputMsgs || inputMsgs.length === 0) throw new Error('optimized summarize: no region messages derived')
    return { msgs: [...inputMsgs], k: 1, m: inputMsgs.length }
  }
  if (region) {
    const built = buildPrefixMessages(session, events, surface, region.posStart, region.posEnd)
    if (built.k !== -1 && built.m !== -1) {
      msgs = built.msgs
      k = built.k
      m = built.m
      regionStart = surface[region.posStart] ?? null
      regionEnd = surface[region.posEnd] ?? null
    } else {
      const fb = stockFallback()
      msgs = fb.msgs
      k = fb.k
      m = fb.m
      regionStart = null
      regionEnd = null
    }
  } else {
    const fb = stockFallback()
    msgs = fb.msgs
    k = fb.k
    m = fb.m
    regionStart = null
    regionEnd = null
  }
  engine._lastDiag = {
    surfaceNodes: surface.length,
    sentMessages: msgs.length,
    k: k,
    m: m,
    regionStart: regionStart,
    regionEnd: regionEnd,
  }
  const instrMsg = {
    id: 'ctxc-instr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user' as const,
    content: [{ type: 'text' as const, text: makeScopedInstruction(k, m, msgs.length) }],
    source: { kind: 'plugin', plugin: '@mimichunterz/agent-compact' },
  }
  const latest = session.requestHeader ? session.requestHeader()?.config : undefined
  const cfg = (engine.config || {}) as SummarizationConfig
  const configured = cfg.summarizationProvider && cfg.summarizationProvider.length
    ? { provider: cfg.summarizationProvider, model: cfg.summarizationModel }
    : undefined
  const agentTarget = agent.options && agent.options.provider && agent.options.provider.length && agent.options.model && agent.options.model.length
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = (configured || latest || agentTarget) as { provider: string; model: string } | undefined
  if (!target) throw new Error('no provider/model available for summarization')
  const options = {
    provider: target.provider,
    model: target.model,
    messages: [...msgs, instrMsg],
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    maxTokens: Math.max(maxTokensOverride || cfg.maxTokens || 8192, 16384),
    sessionId: session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  const llm = ((engine.ctx as { llm?: { stream(options: unknown): AsyncIterable<StreamChunk> } } | undefined) || {}).llm
  if (!llm) throw new Error('optimized summarize: llm service unavailable')
  const assembler = makeAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const fin = assembler.finish
  if (fin.kind === 'error' || fin.kind === 'aborted') {
    const err = new Error(fin.failure && fin.failure.message ? fin.failure.message : 'summarization stream failed')
    if (fin.failure && fin.failure.code) (err as Error & { code?: string }).code = fin.failure.code
    throw err
  }
  const rawOutput = assembler.blocks()
  if (fin.kind === 'max-tokens') {
    const partialText = textOfBlocks(rawOutput)
    const err = new Error('summarization truncated at the token cap (incomplete checkpoint); partial ' + partialText.length + ' chars: ' + preview(partialText, 200))
    ;(err as Error & { code?: string }).code = 'MAX_TOKENS'
    throw err
  }
  const summary = rawOutput.filter((b): b is TextBlock => b.type === 'text')
  if (!summary.some((b) => b.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

// Derive the non-null messages of surface positions [posStart..posEnd] and the
// 1-based message indices (#k..#m) of the region within the full prefix.
function buildPrefixMessages(session: SessionLike, events: readonly unknown[], surface: readonly number[], posStart: number, posEnd: number): { msgs: unknown[]; k: number; m: number } {
  const derive = session.deriveEventMessage
  if (typeof derive !== 'function') throw new Error('optimized summarize: session API unavailable')
  const msgs: unknown[] = []
  let k = -1
  let m = -1
  for (let i = 0; i <= posEnd; i++) {
    // session.surface.nodes holds seq numbers, and session.events is an array
    // the runtime keeps indexable by seq, so the lookup is a plain index.
    const ev = events[surface[i]]
    if (!ev) continue
    let msg: unknown = null
    try {
      msg = derive(ev)
    } catch (e) {
      msg = null
    }
    if (msg === null || msg === undefined) continue
    msgs.push(msg)
    if (i >= posStart) {
      if (k === -1) k = msgs.length
      m = msgs.length
    }
  }
  return { msgs, k, m }
}

// Derive the messages of one span without computing indices.
function deriveRegionMessages(session: SessionLike, events: readonly unknown[], surface: readonly number[], posStart: number, posEnd: number): unknown[] {
  const derive = session.deriveEventMessage
  if (typeof derive !== 'function') throw new Error('optimized summarize: session API unavailable')
  const out: unknown[] = []
  for (let i = posStart; i <= posEnd; i++) {
    const ev = events[surface[i]]
    if (!ev) continue
    let msg: unknown = null
    try {
      msg = derive(ev)
    } catch (e) {
      msg = null
    }
    if (msg === null || msg === undefined) continue
    out.push(msg)
  }
  return out
}

// Whether the span's derived messages equal the engine-derived region messages.
// Identity comparison is safe: deriveEventMessage returns the very object the
// session event stores, so both sides reference the same instances.
function regionMessagesMatch(session: SessionLike, events: readonly unknown[], surface: readonly number[], posStart: number, posEnd: number, inputMsgs: unknown[]): boolean {
  const derived = deriveRegionMessages(session, events, surface, posStart, posEnd)
  if (derived.length !== inputMsgs.length) return false
  for (let i = 0; i < derived.length; i++) {
    if (derived[i] !== inputMsgs[i]) return false
  }
  return true
}

// Locate the span whose derived messages equal inputMsgs by identity. Each
// message object derives from exactly one surface node, so a match is unique;
// the scan keeps the last occurrence defensively.
function locateRegionMessages(session: SessionLike, events: readonly unknown[], surface: readonly number[], inputMsgs: unknown[]): { posStart: number; posEnd: number } | null {
  const derive = session.deriveEventMessage
  if (typeof derive !== 'function') throw new Error('optimized summarize: session API unavailable')
  const n = surface.length
  const L = inputMsgs.length
  if (L === 0) return null
  const derived: (unknown | null)[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const ev = events[surface[i]]
    let msg: unknown = null
    if (ev) {
      try {
        msg = derive(ev)
      } catch (e) {
        msg = null
      }
    }
    derived[i] = msg === undefined ? null : msg
  }
  let found: { posStart: number; posEnd: number } | null = null
  for (let i = 0; i < n; i++) {
    if (derived[i] !== inputMsgs[0]) continue
    let j = i
    let p = 0
    let lastNonNull = i
    while (p < L) {
      if (j >= n) break
      const d = derived[j]
      if (d === null) {
        j++
        continue
      }
      if (d !== inputMsgs[p]) break
      lastNonNull = j
      j++
      p++
    }
    if (p === L) found = { posStart: i, posEnd: lastNonNull }
  }
  return found
}

/** Extract a session id from an agent-shaped value, or null when absent. */
export function sessionIdOf(agent: unknown): string | null {
  const a = agent as { session?: { id?: unknown } } | undefined
  const id = a && a.session ? a.session.id : undefined
  return typeof id === 'string' && id.length > 0 ? id : null
}

// Upgrade one engine instance in place (idempotent per instance). Used by the
// tools plugin on first use so every compaction of that session — including
// the automatic pressure/overflow path and the `compact` command — runs the
// optimized summarizer.
export function patchEngine(engine: OptimizedEngineLike, opts: { maxTokens?: number } = {}): boolean {
  if (!engine || typeof engine.compactRegion !== 'function' || typeof engine.summarize !== 'function') return false
  if (engine.__ctxcOptimized) return true
  const origCompact = engine.compactRegion.bind(engine)
  engine.compactRegion = async function (this: OptimizedEngineLike, start: number, end: number, agent: unknown, signal?: AbortSignal) {
    const sid = sessionIdOf(agent)
    if (sid) {
      const pending = (this._pending ??= {})
      pending[sid] = { start, end }
    }
    return origCompact(start, end, agent, signal)
  }
  engine.summarize = function (this: OptimizedEngineLike, input: unknown, agent: unknown, signal?: AbortSignal) {
    return runOptimizedSummarize(this, input as SummarizationInputLike, agent as AgentLike, signal, opts.maxTokens)
  }
  engine.__ctxcOptimized = true
  return true
}
