// @mimichunterz/agent-compact: context compression tools (bundle plugin).
//
// Official plugin shape: named `name` / `Config` / `apply(ctx, config)`
// exports (see docs/user/develop/basic/config.md in deepseek-harness).
// Registers one model-visible tool (context_compact) and lazily patches the
// per-session compaction engine on first use so its summarize() honors
// agent-written checkpoints (see ./optimizer.js).

import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createShadowUserMessage } from './shadow-message.js'
import { patchEngine } from './optimizer.js'
import { normText } from './normalize.js'
import type { AgentLike, OptimizedEngineLike, SessionLike, SurfaceNode } from './optimizer.js'

export const name = 'tool-context-compression'

export const inject = ['tools']

export interface Config {
  autoArchive: boolean
}

export const Config: Schema<Config> = Schema.object({
  autoArchive: Schema.boolean().default(true).description('context_compact saves the full raw span to a spill artifact before replacing it.'),
})

export function apply(ctx: Context, config: Config) {
  // NOTE: sessionQuery AND agentPresets are deliberately NOT captured here.
  // Both are resolved per call through resolveService(): the session-query
  // sqlite row and the agent-presets registry mount only after their own
  // dependency chains are up, so capturing `ctx.get('sessionQuery')` or
  // `ctx.get('agentPresets')` at apply time raced the boot order and left the
  // context_compact tool broken ('compaction service is not available in this
  // runtime (tried host plane and preset realm)') on processes where this
  // plugin's apply won the race — the tool row injects only `tools` (provided
  // by the dsh-base bundle), which is up before the web-app bundle's
  // agent-presets row registers.
  const tools = ctx.get('tools')
  if (!tools) throw new Error('@mimichunterz/agent-compact: tools service unavailable')

  interface AgentWithSession extends AgentLike {
    session: SessionLike
  }

  interface SpillSaveArgs {
    owner: { sessionId: string }
    source: { toolName: string; callId: unknown; label: string }
    suggestedName: string
    content: string
  }

  interface SpillStoreLike {
    saveText(args: SpillSaveArgs): Promise<{ locator: JsonValue; bytes: JsonValue; retrievalHint: JsonValue }>
  }

  interface SessionQueryLike {
    readSurface(sessionId: string): Promise<{ events?: unknown } | null>
  }

  // Type alias (not interface) so it carries an implicit index signature and
  // stays assignable to JsonValue when embedded in tool results.
  type SurfaceArchive = {
    locator: JsonValue
    bytes: JsonValue
    retrievalHint: JsonValue
    chars: number
    archivedSeqs: number[]
  }
  interface CompactionResultLike {
    compactionId: JsonValue
    shadowedRange?: { start: number; end: number } | null
    shadowedSeqs?: JsonValue[] | null
    shadowedTokenCount?: JsonValue | null
    summary?: JsonValue
  }

  interface CompactionLike {
    compactRegion(start: number, end: number, agent: AgentWithSession, signal?: AbortSignal): Promise<CompactionResultLike>
  }

  interface SurfaceNodeData {
    message?: { content?: unknown } | null
    content?: unknown
    error?: { code?: unknown } | null
  }

  interface SessionEventLike {
    type?: string
    seq?: number
    data?: unknown
    sourceEventSeqs?: unknown
  }

  // The assistant/message that carries exactly this one tool-call (used to
  // decide whether the call's message node can be shadowed without breaking
  // sibling tool calls in the same message).
  function soleToolCall(n: SurfaceNode, callId: string): boolean {
    if (n.type !== 'assistant/message') return false
    const content = (n.data as { message?: { content?: unknown } } | undefined)?.message?.content
    if (!Array.isArray(content)) return false
    const calls = content.filter((b) => {
      const block = b as { type?: unknown; id?: unknown }
      return block !== null && typeof block === 'object' && block.type === 'tool-call'
    })
    return calls.length === 1 && (calls[0] as { id?: unknown }).id === callId
  }

  interface AnyBlock {
    type?: string
    text?: unknown
    name?: unknown
    arguments?: unknown
    isError?: unknown
    content?: unknown
  }

  function resolveService(agent: AgentLike, serviceName: string): unknown {
    const direct = ctx.get(serviceName)
    if (direct) return direct
    // agentPresets is resolved PER CALL (never captured at apply time): the
    // agent-presets registry mounts only after its own dependency chain is up,
    // and this bundle row injects only `tools`, so a boot-time capture races
    // the registry and permanently kills the preset-realm path. Same reason
    // sessionQuery is resolved per call below.
    const agentPresets = ctx.get('agentPresets')
    const presets = agentPresets as { serviceFor?: (agent: { ctx: unknown }, name: string) => unknown } | undefined
    if (presets && typeof presets.serviceFor === 'function' && agent && agent.ctx) {
      try {
        const viaPreset = presets.serviceFor({ ctx: agent.ctx }, serviceName)
        if (viaPreset) return viaPreset
      } catch (e) {
        /* fall through */
      }
    }
    return undefined
  }

  function agentOf(exec: { agent?: unknown }): AgentWithSession | null {
    const agent = exec.agent as AgentLike | undefined
    if (!agent || !agent.session) return null
    return agent as AgentWithSession
  }

  // ---- surface text extraction ----
  function nodeContent(n: SurfaceNode): unknown {
    const d = (n.data as SurfaceNodeData | undefined) ?? null
    if (!d) return null
    const t = n.type
    if (t === 'assistant/message' || t === 'tool/result') {
      const m = d.message
      if (m && Array.isArray(m.content)) return m.content
      return null
    }
    if (Array.isArray(d.content)) return d.content
    return null
  }

  // `skipReasoning` keeps the ANCHOR-MATCHING text aligned with what the model
  // sees: the DeepSeek adapter moves `reasoning` blocks into the separate
  // `reasoning_content` wire field (tool-call turns) or drops them (text
  // turns), so the model's view of a message starts at its visible text — not
  // at the reasoning the plugin would otherwise concatenate first. The archive
  // keeps the full raw text (skipReasoning = false).
  function blockText(b: unknown, depth: number, skipReasoning: boolean): string {
    if (depth > 5 || !b || typeof b !== 'object') return ''
    const blk = b as AnyBlock
    if (skipReasoning && blk.type === 'reasoning') return ''
    if (typeof blk.text === 'string') return blk.text
    if (blk.type === 'tool-call') {
      return '[tool-call ' + String(blk.name ?? '') + '] ' + (typeof blk.arguments === 'string' ? blk.arguments : '')
    }
    if (blk.type === 'tool-result') {
      return '[tool-result' + (blk.isError ? ' error' : '') + '] ' + blocksText(blk.content, depth + 1, skipReasoning)
    }
    if (blk.type === 'image') return '[image]'
    if (Array.isArray(blk.content)) return blocksText(blk.content, depth + 1, skipReasoning)
    return ''
  }

  function blocksText(blocks: unknown, depth: number, skipReasoning: boolean): string {
    if (!Array.isArray(blocks)) return ''
    let out = ''
    for (const b of blocks) out += blockText(b, depth, skipReasoning) + '\n'
    return out
  }

  function nodeText(n: SurfaceNode, skipReasoning?: boolean): string {
    const blocks = nodeContent(n)
    if (!blocks) return ''
    return blocksText(blocks, 0, skipReasoning ?? false).replace(/\n+$/, '')
  }

  function nodeErrorTag(n: SurfaceNode): string {
    const d = (n.data as SurfaceNodeData | undefined) ?? null
    if (d && d.error && d.error.code) return ' error=' + String(d.error.code)
    return ''
  }

  function preview(text: unknown, max: number): string {
    const t = String(text || '')
    return t.length <= max ? t : t.slice(0, max) + '…'
  }

  async function readSurfaceNodes(agent: AgentWithSession): Promise<SurfaceNode[] | null> {
    const sessionQuery = resolveService(agent, 'sessionQuery') as SessionQueryLike | undefined
    if (!sessionQuery) return null
    const snap = await sessionQuery.readSurface(agent.session.id)
    return snap && Array.isArray(snap.events) ? (snap.events as SurfaceNode[]) : []
  }

  // ---- anchor-based boundary resolution ----
  // The model does not need a surface listing: it passes verbatim text of
  // the first node (startAnchor) and/or last node (endAnchor) of the span, and
  // the tool locates the seqs by normalized text match on the CURRENT surface.
  // Anchors resolve afresh on every call, so repeated compactions never go
  // stale after earlier checkpoints replaced old nodes. Boundary seqs still
  // win when both are given. Matched edges are snapped to balanced
  // tool-call/result boundaries (start back to the pair opener, end forward
  // through the closing results) so the engine's balance check passes.

  // normText comes from ./normalize.ts: whitespace-collapsed, CJK full-width
  // punctuation mapped to half-width, applied to BOTH anchors and node text.

  // Tolerant variant: drop the [tool-call <name>] / [tool-result( error)] markers
  // the renderer adds, so the model may paste content with or without them.
  // Routed through normText so punctuation normalization applies here too.
  function strippedText(s: string): string {
    return normText(
      s
        .replace(/\[tool-call\s+[^\]]*\]\s*/g, '')
        .replace(/\[tool-result(?:\s+error)?\]\s*/g, ''),
    )
  }

  // UNIQUE-PREFIX matching: an anchor must be a normalized prefix of EXACTLY
  // ONE message node (user/message or assistant/message), so a replacement can
  // never silently land on the wrong node. tool/result nodes are NOT matched:
  // their caller lives inside the preceding assistant message, so anchoring a
  // message keeps whole tool pairs together (snap* helpers close the edges).
  // Zero hits -> "not found" with closest-node hints; more than one hit ->
  // "ambiguous" listing every candidate so the caller lengthens the anchor.
  // The current in-flight turn's own tool-call node (its arguments are part of
  // the surface) is excluded: it is an open, unbalanced step, never a boundary.
  function prefixHits(nodes: SurfaceNode[], anchor: string): number[] {
    const a = normText(anchor)
    const hits: number[] = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.type !== 'user/message' && node.type !== 'assistant/message') continue
      if (i === nodes.length - 1 && /\[tool-call/.test(nodeText(node, true))) continue
      const n = normText(nodeText(node, true))
      const s = strippedText(nodeText(node, true))
      if (n.startsWith(a) || s.startsWith(a)) hits.push(i)
    }
    return hits
  }

  function hitPreview(nodes: SurfaceNode[], hits: number[]): string {
    return hits.map((i) => 'pos ' + i + ' | seq ' + nodes[i].seq + ' | ' + nodes[i].type + ': ' + preview(nodeText(nodes[i], true), 80)).join('\n')
  }

  // Resolve one anchor to a unique node index, throwing with actionable hints.
  function resolveUniqueHit(nodes: SurfaceNode[], anchor: string, side: string): number {
    const hits = prefixHits(nodes, anchor)
    if (hits.length === 1) return hits[0]
    if (hits.length === 0) {
      const hint = nearestHint(nodes, normText(anchor))
      throw new Error(side + ' not found on the surface: ' + preview(anchor, 120) + (hint ? '\nclosest nodes:\n' + hint : ''))
    }
    throw new Error(side + ' is AMBIGUOUS: ' + hits.length + ' nodes start with it. Lengthen the anchor to pick one:\n' + hitPreview(nodes, hits))
  }

  function snapStartBalanced(nodes: SurfaceNode[], si: number): number {
    // A tool/result must not open the span without its assistant message:
    // walk back to the nearest assistant/message that issued the calls.
    while (si > 0 && nodes[si].type === 'tool/result') {
      let j = si - 1
      while (j > 0 && nodes[j].type !== 'assistant/message') j--
      if (nodes[j].type !== 'assistant/message') break
      si = j
    }
    return si
  }

  function snapEndBalanced(nodes: SurfaceNode[], ei: number): number {
    // An assistant/message edge stays open while its tool results follow;
    // consecutive tool/result nodes belong to the same pair, so advance
    // through ALL of them until the pair is fully closed.
    while (ei < nodes.length - 1 && nodes[ei + 1].type === 'tool/result') {
      ei++
    }
    return ei
  }

  interface BoundaryResolveResult {
    si: number
    ei: number
    startSeq: number
    endSeq: number
    method: string
    detail: { startPos: number; endPos: number }
  }

  // Rank nodes by word overlap with an anchor, to suggest what to pass when a
  // match fails. Cheap, deterministic, good enough for a hint.
  function anchorOverlap(nodeRaw: string, anchorNorm: string): number {
    const words = anchorNorm.split(' ').filter((w) => w.length > 2)
    if (!words.length) return 0
    const n = normText(nodeRaw)
    let hit = 0
    for (const w of words) {
      if (n.includes(w)) hit++
    }
    return hit / words.length
  }

  function nearestHint(nodes: SurfaceNode[], anchorNorm: string): string {
    const scored = nodes
      .map((n, i) => ({ i: i, score: anchorOverlap(nodeText(n, true), anchorNorm) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .filter((s) => s.score > 0)
    if (!scored.length) return ''
    return scored.map((s) => 'pos ' + s.i + ' | seq ' + nodes[s.i].seq + ' | ' + nodes[s.i].type + ': ' + preview(nodeText(nodes[s.i], true), 80)).join('\n')
  }

  function resolveBoundaries(nodes: SurfaceNode[], args: { startAnchor?: unknown; endAnchor?: unknown }): BoundaryResolveResult {
    if (!nodes.length) throw new Error('surface is empty; nothing to compact')
    const startAnchor = typeof args.startAnchor === 'string' && args.startAnchor.trim() ? args.startAnchor : ''
    const endAnchor = typeof args.endAnchor === 'string' && args.endAnchor.trim() ? args.endAnchor : ''
    // The end side is REQUIRED to bound the span; start defaults to the first node.
    if (!endAnchor) {
      throw new Error('cannot resolve the end boundary: provide endAnchor — verbatim text that is a UNIQUE PREFIX of the LAST node of the span to compress (that node itself is compressed; use its predecessor to keep it)')
    }
    const method: string[] = []
    let si: number
    if (startAnchor) {
      si = resolveUniqueHit(nodes, startAnchor, 'startAnchor')
      method.push('start=anchor')
    } else {
      si = 0
      method.push('start=first')
    }
    let ei = resolveUniqueHit(nodes, endAnchor, 'endAnchor')
    method.push('end=anchor')
    if (si > ei) {
      throw new Error('resolved start sits after resolved end on the surface (start pos ' + si + ', end pos ' + ei + ')')
    }
    const snappedStart = snapStartBalanced(nodes, si)
    const snappedEnd = snapEndBalanced(nodes, ei)
    if (snappedStart !== si) method.push('start-snapped')
    if (snappedEnd !== ei) method.push('end-snapped')
    si = snappedStart
    ei = snappedEnd
    if (si > ei) throw new Error('after balancing, start sits after end on the surface (start pos ' + si + ', end pos ' + ei + ')')
    return {
      si: si,
      ei: ei,
      startSeq: nodes[si].seq,
      endSeq: nodes[ei].seq,
      method: method.join(' + '),
      detail: { startPos: si, endPos: ei },
    }
  }

  function spanText(nodes: SurfaceNode[], si: number, ei: number): string {
    const parts: string[] = []
    for (let i = si; i <= ei; i++) {
      const n = nodes[i]
      parts.push('--- seq ' + n.seq + ' | pos ' + i + ' | ' + n.type + nodeErrorTag(n) + ' ---\n' + nodeText(n))
    }
    return parts.join('\n\n')
  }

  // Sequential per-session archive numbering. The local spill backend scopes
  // files under root/session-<hash>/, so the next number is derived from what
  // is ALREADY in that session dir (max numeric suffix + 1) — clean, gap-free,
  // and restart-safe. The spill service exposes only saveText (no list API),
  // so the root is duck-typed off the live LocalSpillStore instance; other
  // backends without a `root` field degrade to the in-memory counter. No
  // collision retry is needed: the backend prepends a random hex prefix to
  // every filename, so two saves can never collide even with equal suffixes.
  const archiveCounters = new Map<string, number>()

  function spillRootOf(spillStore: SpillStoreLike): string | null {
    const s = spillStore as unknown as { root?: unknown } | null
    return s && typeof s.root === 'string' && s.root ? s.root : null
  }

  function sessionSpillDir(root: string, sessionId: string): string {
    return join(root, 'session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 12))
  }

  // Largest numeric suffix already present in the session's spill dir, or 0.
  async function maxArchiveNumber(root: string, sessionId: string): Promise<number> {
    try {
      const entries = await readdir(sessionSpillDir(root, sessionId))
      let max = 0
      for (const name of entries) {
        const m = /-(\d+)\.txt$/.exec(name)
        if (m) max = Math.max(max, Number(m[1]))
      }
      return max
    } catch (e) {
      return 0 // dir missing or unreadable: fall back to the in-memory counter
    }
  }

  async function archiveSpan(agent: AgentWithSession, spillStore: SpillStoreLike, nodes: SurfaceNode[], si: number, ei: number): Promise<SurfaceArchive | null> {
    if (!spillStore) return null
    const content = spanText(nodes, si, ei)
    const sid = agent.session.id
    const root = spillRootOf(spillStore)
    const scanned = root ? await maxArchiveNumber(root, sid) : 0
    const n = Math.max(scanned, archiveCounters.get(sid) ?? 0) + 1
    archiveCounters.set(sid, n)
    const ref = await spillStore.saveText({
      owner: { sessionId: sid },
      source: { toolName: 'context_compact', callId: null, label: 'auto-archive' },
      suggestedName: String(n).padStart(6, '0') + '.txt',
      content: content,
    })
    return {
      locator: ref.locator,
      bytes: ref.bytes,
      retrievalHint: ref.retrievalHint,
      chars: content.length,
      archivedSeqs: nodes.slice(si, ei + 1).map((n) => n.seq),
    }
  }

  // Read the summarization usage from the durable compaction/summary event.
  function findSummaryUsage(session: SessionLike, compactionId: unknown): JsonValue | null {
    try {
      const events = session.events
      if (!events) return null
      const keys = Object.keys(events)
      for (let i = keys.length - 1; i >= 0; i--) {
        const ev = (events as unknown as Record<string, unknown>)[keys[i]] as { type?: string; data?: { compactionId?: unknown; usage?: JsonValue } } | undefined
        if (ev && ev.type === 'compaction/summary' && ev.data && ev.data.compactionId === compactionId) {
          return ev.data.usage ?? null
        }
      }
    } catch (e) {
      /* ignore */
    }
    return null
  }

  const disposers: (() => void)[] = []

  disposers.push(tools.register(defineTool({
    name: 'context_compact',
    description: 'Compress a past conversation span into one Markdown checkpoint you write; the raw span is archived to a spill artifact, the compaction recorded. Anchor matching: anchors match the opening text of a message body (user/assistant messages only; tool-call blocks, tool results, and other transcript structure excluded). Whitespace, tool-call markers, and full/half-width punctuation differences are ignored; each anchor must match exactly one user or assistant message. When to compact: ① Progress — compact each finished step at its topic boundary, keeping the active instruction and remaining steps live; ② Course correction — compact the failed span into a checkpoint recording what went wrong and the corrected direction, instead of carrying noise forward; ③ Rebaseline — stale opening requirements: compact the start too, restating current intent and what survives. Checkpoint: Markdown, terse bullets, ## sections; keep exact paths/commands/IDs and the user\'s requirements and direction. Per scene — Progress: Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Current Work / Next Step; Correction: what went wrong / root cause / fix / next; Rebaseline: current intent / surviving decisions / plan ahead. Constraints: one compaction per session at a time; checkpoint must be smaller than the compressed span; edges snap to balanced tool-call/result boundaries.',
    parameters: {
      startAnchor: { type: 'string', description: 'Verbatim opening of the span\'s first message. Required for a middle span; omitting starts at the conversation\'s first message, discarding opening requirements and direction — only for compressing all history up to endAnchor or rebaselining.' },
      endAnchor: { type: 'string', description: 'Verbatim opening of the span\'s last message; required. This node is replaced — pass its predecessor\'s opening to keep it.' },
      summary: { type: 'string', description: 'Required. The full Markdown checkpoint replacing the span, written by you from the conversation; never verbatim. Per-scene structure as in the description; must be smaller than the compressed content.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      if (typeof args.summary !== 'string' || !args.summary.trim()) {
        throw new Error('summary is REQUIRED: write the Markdown checkpoint yourself (this tool makes no LLM summarizer call)')
      }
      const engine = resolveService(agent, 'compaction') as CompactionLike | undefined
      if (!engine) throw new Error('compaction service is not available in this runtime (tried host plane and preset realm)')
      patchEngine(engine as unknown as OptimizedEngineLike)
      const nodes = await readSurfaceNodes(agent)
      if (nodes === null) throw new Error('sessionQuery service is not available in this runtime')
      const b = resolveBoundaries(nodes, args)
      const startSeq = b.startSeq
      const endSeq = b.endSeq
      // Hand the agent-written checkpoint to the engine; the patched summarizer
      // consumes it (one-shot) and skips the LLM call entirely.
      {
        const ext = ((engine as unknown as { _externalSummary?: Record<string, string> })._externalSummary ??= {})
        ext[agent.session.id] = args.summary
      }

      const spillStore = resolveService(agent, 'spillStore') as SpillStoreLike | undefined
      let archived: SurfaceArchive | null = null
      let archiveError: JsonValue | null = null
      if (config.autoArchive && spillStore) {
        try {
          archived = await archiveSpan(agent, spillStore, nodes, b.si, b.ei)
        } catch (err) {
          archiveError = err && (err as Error).message ? (err as Error).message : String(err)
        }
      } else if (config.autoArchive) {
        archiveError = 'spillStore unavailable; raw copy not saved (compaction still proceeds)'
      }

      let result: CompactionResultLike
      try {
        result = await engine.compactRegion(startSeq, endSeq, agent, exec.signal)
      } catch (err) {
        const msg = err && (err as Error).message ? (err as Error).message : String(err)
        throw new Error('compaction rejected range [' + startSeq + ',' + endSeq + ']: ' + msg)
      }
      const usage = findSummaryUsage(agent.session, result.compactionId)
      // Paired cleanup of THIS call: the checkpoint is injected separately, so
      // the assistant/message carrying this call's tool-call (with the full
      // summary argument) plus its tool/result would leave the checkpoint text
      // in the surface twice. The surface protocol only knows append/replace
      // (no remove), so both nodes are shadowed individually — each replaced by
      // one tiny placeholder — after the framework has written the result
      // (post-commit feed). NOTE: tool/call events are NOT surface nodes
      // (SurfaceEventType is user/assistant/message + tool/result), so the
      // replace must target the assistant/message node. Only when that message
      // holds exactly this one tool-call is it safe to shadow (a multi-call
      // message must keep its other tool calls paired with their results).
      const callId = (exec as { callId?: unknown }).callId
      if (typeof callId === 'string' && callId) {
        const holder = nodes.filter((n) => soleToolCall(n, callId)).pop()
        const assistantSeq = holder ? holder.seq : undefined
        if (assistantSeq !== undefined && assistantSeq > endSeq) {
          const sid = agent.session.id
          let done = false
          const off = ctx.on('session/event', (s: { id?: string } | undefined, ev: SessionEventLike) => {
            if (done) return
            if (!s || s.id !== sid) return
            if (ev.type !== 'tool/result') return
            const d = ev.data as { message?: { source?: { callId?: unknown } } } | null | undefined
            const src = d && d.message && d.message.source ? d.message.source.callId : undefined
            if (src !== callId) return
            done = true
            try {
              off()
            } catch (e) {
              /* ignore */
            }
            try {
              const session = agent.session as unknown as { append: (type: string, data: unknown, opts: unknown) => unknown }
              if (!session || typeof session.append !== 'function') return
              // The listener runs synchronously INSIDE the framework's own
              // tool/result append publication (`invokeContainedSessionObservers`),
              // where `entry.appending` is still true — calling session.append
              // synchronously trips the reentry guard and throws. Defer to the
              // microtask queue so the current publication fully unwinds first.
              const resultSeq = ev.seq
              const run = () => {
                try {
                  // Surface the archive locator so the model can read the raw
                  // span back: the tool/result that carried it is shadowed below,
                  // so without this the path would be lost.
                  const locText = archived && archived.locator ? String(archived.locator) : ''
                  const doneText = locText
                    ? '`context_compact` done: checkpoint above; raw span archived at ' + locText + '.'
                    : '`context_compact` done: checkpoint above; raw span not archived.'
                  session.append('user/message', createShadowUserMessage(doneText), {
                    surfaceOp: { op: 'replace', start: assistantSeq, end: assistantSeq },
                    sourceEventSeqs: [assistantSeq],
                  })
                  session.append('user/message', createShadowUserMessage('`context_compact` result shadowed.'), {
                    surfaceOp: { op: 'replace', start: resultSeq, end: resultSeq },
                    sourceEventSeqs: [resultSeq],
                  })
                  ctx.logger.info('[context_compact] %s paired cleanup: shadowed assistant/message %d + tool/result %d', sid, assistantSeq, resultSeq)
                } catch (e) {
                  ctx.logger.warn('[context_compact] %s paired cleanup failed: %s', sid, e && (e as Error).message ? (e as Error).message : String(e))
                }
              }
              if (typeof queueMicrotask === 'function') queueMicrotask(run)
              else setTimeout(run, 0)
            } catch (e) {
              ctx.logger.warn('[context_compact] %s paired cleanup setup failed: %s', sid, e && (e as Error).message ? (e as Error).message : String(e))
            }
          })
        }
      }
      // Debug/introspection metrics go to the log, never into the model-visible
      // tool result (DSH tool convention: the execute return IS what the model
      // sees, so it must stay minimal — see bash/read/goal tools).
      ctx.logger.info('[context_compact] %s span %d..%d (%s), shadowed %d nodes / %s tokens, surface %d -> after, usage=%o', agent.session.id, startSeq, endSeq, b.method, Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0, String(result.shadowedTokenCount ?? '?'), nodes.length, usage)
      const out: {
        ok: boolean
        archived: { locator: JsonValue; retrievalHint: JsonValue } | null
        archiveError?: string
      } = {
        ok: true,
        archived: archived ? {
          locator: archived.locator,
          retrievalHint: archived.retrievalHint,
        } : null,
      }
      if (archiveError) out.archiveError = typeof archiveError === 'string' ? archiveError : String(archiveError)
      return out
    },
  })))

  // ---- pre-compaction consultation (fork of the pre-compaction context) ----
  // `ctx.subagents.start('fork')` seeds the child with the parent's CURRENT
  // completed-turn prefix, which after a compaction folds to the post-compaction
  // surface. To ask the PRE-compaction agent we create the child through the
  // agent registry (no new dependency) and seed it with the parent's log up to
  // the last completed turn BEFORE the compaction, so the span that was compacted
  // away is still original. The child is composed with `agentPresets.composeFrom`,
  // so it joins the SAME standing composition as the parent — same preset, system
  // prompt, and tools. (The subagent seam's delegated approval/sandbox policy is
  // not pinned here; the child is a throwaway context query.) The main session is
  // untouched; the answer is returned here.

  interface ChildAgentHandleLike {
    agent: {
      followup(message: unknown): void
      whenIdle(): Promise<void>
      session: {
        events: readonly unknown[]
        append(type: string, data: unknown, opts: unknown): unknown
      }
    }
    dispose(): Promise<void>
  }

  interface AgentsRegistryLike {
    create(options: {
      sessionId: string
      meta?: unknown
      seed?: readonly unknown[]
      agentOptions?: unknown
      signal?: unknown
      setup?: (childCtx: unknown) => void
    }): Promise<ChildAgentHandleLike>
  }

  interface AgentCtxLike {
    agents?: AgentsRegistryLike
    get(name: string): unknown
  }

  // The parent's pre-compaction surface: events up to (and including) the last
  // completed `turn/end` before the most recent `compaction/start`. Because the
  // parent log is contiguous from seq 0, this slice is a valid balanced seed and
  // replays to the pre-compaction surface (the compacted span is not folded).
  interface PreCompactionSeed {
    seed: readonly unknown[]
    boundary: number
  }

  function findPreCompactionSeed(session: SessionLike): PreCompactionSeed {
    const events = session.events
    if (!events || events.length === 0) return { seed: [], boundary: 0 }
    let compactStartIdx = -1
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as { type?: string } | undefined
      if (ev && ev.type === 'compaction/start') {
        compactStartIdx = i
        break
      }
    }
    if (compactStartIdx < 0) return { seed: [], boundary: 0 }
    let endIdx = compactStartIdx
    for (let i = compactStartIdx - 1; i >= 0; i--) {
      const ev = events[i] as { type?: string } | undefined
      if (ev && ev.type === 'turn/end') {
        endIdx = i
        break
      }
    }
    const seed = events.slice(0, endIdx + 1)
    return { seed: seed as readonly unknown[], boundary: seed.length }
  }

  // Frame the child's message: the pre-compaction context is in the seed, so the
  // prompt is just the question (the child answers as the pre-compaction agent).
  function childPrompt(question: string): unknown {
    return createUserMessage({
      content: [{ type: 'text', text: question }],
      source: { kind: 'user' },
    })
  }

  // Read the child's own output and turn outcome from its post-boundary events
  // without importing the subagent seam's helpers: the last non-empty
  // assistant/message is the answer, the last turn/end's reason is the outcome.
  function readChildAnswer(childSession: { events: readonly unknown[] }, boundary: number): { answer: string; outcome: string } {
    const own = childSession.events.slice(boundary)
    let answer = ''
    let outcome = 'completed'
    for (let i = own.length - 1; i >= 0; i--) {
      const ev = own[i] as { type?: string; data?: unknown } | undefined
      if (!ev || typeof ev.type !== 'string') continue
      if (ev.type === 'turn/end') {
        const reasonKind = (ev.data as { reason?: { kind?: string } } | undefined)?.reason?.kind
        if (typeof reasonKind === 'string' && reasonKind !== 'completed') outcome = reasonKind
        break
      }
      if (ev.type === 'assistant/message' && answer === '') {
        const msg = (ev.data as { message?: { content?: unknown } } | undefined)?.message
        const content = msg && Array.isArray(msg.content) ? msg.content : []
        const text = content
          .filter((b): b is { type: 'text'; text: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string')
          .map((b) => b.text)
          .join('')
        if (text) answer = text
      }
    }
    return { answer: answer || '(empty)', outcome }
  }

  disposers.push(tools.register(defineTool({
    name: 'context_ask_precompact',
    description: 'Ask a question against the PRE-compaction context, answered by a fork subagent seeded with the conversation as it stood before the most recent compaction. The child is composed exactly like a fork child (same preset, system prompt, tools) and replays the pre-compaction log, so the span that context_compact compressed away is still present and its context matches the main agent\'s pre-compaction state — eligible for the same warm-prefix KV cache. Use it to consult a detail the compaction is about to (or already did) remove. The main session is untouched; the answer is returned here.',
    parameters: {
      question: { type: 'string', description: 'The question to answer from the pre-compaction context.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      if (typeof args.question !== 'string' || !args.question.trim()) throw new Error('question is REQUIRED')
      const session = agent.session
      const pre = findPreCompactionSeed(session)
      if (pre.boundary === 0) throw new Error('no pre-compaction context to fork: run context_compact first')

      const agentCtx = (agent.ctx as unknown as AgentCtxLike)
      const agents = agentCtx.agents
      if (!agents) throw new Error('agents registry is not available in this runtime; mount the agent capability')
      const sessHeader = (session as unknown as { header?: { cwd?: string; id?: string; delegationDepth?: number } }).header
      const childDepth = (sessHeader?.delegationDepth ?? 0) + 1
      const childId = randomUUID()
      const meta = {
        ...(sessHeader?.cwd !== undefined ? { cwd: sessHeader.cwd } : {}),
        parentSession: sessHeader?.id ?? session.id,
        origin: 'subagent' as const,
        delegationDepth: childDepth,
        seedLength: pre.boundary,
      }
      // Inherit the parent's provider/model so the child's route matches.
      const parentOptions = (agent as unknown as { options?: { provider?: string; model?: string } }).options ?? {}
      const agentOptions = {
        ...(parentOptions.provider !== undefined ? { provider: parentOptions.provider } : {}),
        ...(parentOptions.model !== undefined ? { model: parentOptions.model } : {}),
        subagentDepth: childDepth,
      }
      // Compose the child like a fork: join the parent's standing composition so
      // preset / system prompt / tools match.
      const setup = (childCtx: unknown): void => {
        const cc = childCtx as AgentCtxLike
        const presets = cc.get && (cc.get('agentPresets') as { composeFrom?: (child: unknown, parent: unknown) => unknown } | undefined)
        if (presets && typeof presets.composeFrom === 'function') presets.composeFrom(childCtx, agent.ctx)
      }

      let handle: ChildAgentHandleLike
      try {
        handle = await agents.create({
          sessionId: childId,
          meta: meta as unknown,
          seed: pre.seed,
          agentOptions: agentOptions as unknown,
          signal: exec.signal,
          setup,
        })
      } catch (err) {
        const msg = err && (err as Error).message ? (err as Error).message : String(err)
        throw new Error('pre-compaction fork failed to create a child: ' + msg)
      }

      const child = handle.agent
      try {
        child.followup(childPrompt(args.question))
        await child.whenIdle()
        const res = readChildAnswer(child.session, pre.boundary)
        const data: Record<string, JsonValue> = {
          ok: res.outcome === 'completed',
          answer: res.answer,
        }
        if (res.outcome !== 'completed') data['outcome'] = res.outcome
        return data
      } finally {
        try { await handle.dispose() } catch (e) { /* ignore */ }
      }
    },
  })))

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch (e) {
        /* ignore */
      }
    }
  }
}

