// @mimichunterz/agent-compact: context compression tools (bundle plugin).
//
// Official plugin shape: named `name` / `Config` / `apply(ctx, config)`
// exports (see docs/user/develop/basic/config.md in deepseek-harness).
// Registers three model-visible tools and lazily upgrades the per-session
// compaction engine on first use (see ./optimizer.js).

import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { patchEngine } from './optimizer.js'
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
  // NOTE: sessionQuery is deliberately NOT captured here. It is resolved per
  // call through resolveService() (like spillStore/compaction): the
  // session-query-sqlite row mounts only after its own `sessions` dependency
  // chain is up, so capturing `ctx.get('sessionQuery')` at apply time raced
  // the boot order and intermittently left the three context_* tools broken
  // ('sessionQuery service is not available in this runtime') on processes
  // where this plugin's apply won the race.
  const agentPresets = ctx.get('agentPresets')
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
    if (agentPresets && agentPresets.serviceFor && agent && agent.ctx) {
      try {
        const viaPreset = agentPresets.serviceFor({ ctx: agent.ctx }, serviceName)
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

  function blockText(b: unknown, depth: number): string {
    if (depth > 5 || !b || typeof b !== 'object') return ''
    const blk = b as AnyBlock
    if (typeof blk.text === 'string') return blk.text
    if (blk.type === 'tool-call') {
      return '[tool-call ' + String(blk.name ?? '') + '] ' + (typeof blk.arguments === 'string' ? blk.arguments : '')
    }
    if (blk.type === 'tool-result') {
      return '[tool-result' + (blk.isError ? ' error' : '') + '] ' + blocksText(blk.content, depth + 1)
    }
    if (blk.type === 'image') return '[image]'
    if (Array.isArray(blk.content)) return blocksText(blk.content, depth + 1)
    return ''
  }

  function blocksText(blocks: unknown, depth: number): string {
    if (!Array.isArray(blocks)) return ''
    let out = ''
    for (const b of blocks) out += blockText(b, depth) + '\n'
    return out
  }

  function nodeText(n: SurfaceNode): string {
    const blocks = nodeContent(n)
    if (!blocks) return ''
    return blocksText(blocks, 0).replace(/\n+$/, '')
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
  // The model can skip context_surface entirely: it passes verbatim text of
  // the first node (startAnchor) and/or last node (endAnchor) of the span, and
  // the tool locates the seqs by normalized text match on the CURRENT surface.
  // Anchors resolve afresh on every call, so repeated compactions never go
  // stale after earlier checkpoints replaced old nodes. Boundary seqs still
  // win when both are given. Matched edges are snapped to balanced
  // tool-call/result boundaries (start back to the pair opener, end forward
  // through the closing results) so the engine's balance check passes.

  function normText(s: string): string {
    return s.replace(/\s+/g, ' ').trim()
  }

  // Tolerant variant: drop the [tool-call <name>] / [tool-result( error)] markers
  // the renderer adds, so the model may paste content with or without them.
  function strippedText(s: string): string {
    return s
      .replace(/\[tool-call\s+[^\]]*\]\s*/g, '')
      .replace(/\[tool-result(?:\s+error)?\]\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
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
      if (i === nodes.length - 1 && /\[tool-call/.test(nodeText(node))) continue
      const n = normText(nodeText(node))
      const s = strippedText(nodeText(node))
      if (n.startsWith(a) || s.startsWith(a)) hits.push(i)
    }
    return hits
  }

  function hitPreview(nodes: SurfaceNode[], hits: number[]): string {
    return hits.map((i) => 'pos ' + i + ' | seq ' + nodes[i].seq + ' | ' + nodes[i].type + ': ' + preview(nodeText(nodes[i]), 80)).join('\n')
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
      .map((n, i) => ({ i: i, score: anchorOverlap(nodeText(n), anchorNorm) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .filter((s) => s.score > 0)
    if (!scored.length) return ''
    return scored.map((s) => 'pos ' + s.i + ' | seq ' + nodes[s.i].seq + ' | ' + nodes[s.i].type + ': ' + preview(nodeText(nodes[s.i]), 80)).join('\n')
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

  async function archiveSpan(agent: AgentWithSession, spillStore: SpillStoreLike, nodes: SurfaceNode[], si: number, ei: number, suggestedName: string): Promise<SurfaceArchive | null> {
    if (!spillStore) return null
    const content = spanText(nodes, si, ei)
    const ref = await spillStore.saveText({
      owner: { sessionId: agent.session.id },
      source: { toolName: 'context_compact', callId: null, label: 'auto-archive' },
      suggestedName: suggestedName || 'context-compacted.txt',
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
    description: 'Compress a span of past conversation into a single Markdown checkpoint that YOU write. The raw span is archived to a spill artifact, replaced by your checkpoint, and the compaction is recorded. Locate the span by anchors: endAnchor (REQUIRED — verbatim opening of the LAST message of the span; that node itself is replaced, so pass its predecessor\'s opening to keep it) and startAnchor (verbatim opening of the FIRST message; REQUIRED to compress a MIDDLE span — omitting it starts at the very first node, which discards the opening requirements and direction unless you intend a rebaseline). When to compact: Progress (most common) — the opening defined the task order and you executed in sequence; compact each finished step at its topic boundary, keeping the active instruction and remaining steps live. Course correction — the conversation drifted and accumulated noise; compact the failed span into a checkpoint recording what went wrong and the corrected direction, instead of carrying the junk forward. Rebaseline — the opening requirements are stale (the user\'s needs evolved); the start itself may be compacted, and the checkpoint then restates the CURRENT intent and what survives, superseding the old opening. Checkpoint conventions (adapt to the scene): Markdown, terse bullets, ## sections; preserve exact paths/commands/ids and the user\'s requirements and direction. Progress: Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Current Work / Next Step. Correction: what went wrong, root cause, the fix, what to keep doing next. Rebaseline: current intent, surviving decisions, plan ahead. Constraints: each anchor must be a unique prefix of exactly one message (whitespace-insensitive, [tool-*] markers ignored); edges snap to balanced tool-call/result boundaries; the engine rejects a checkpoint not smaller than the compressed span; one compaction per session at a time.',
    parameters: {
      startAnchor: { type: 'string', description: 'Verbatim OPENING of the FIRST node of the span; must be a unique prefix of exactly one user/assistant message (whitespace-insensitive, [tool-*] markers ignored). REQUIRED to compress a MIDDLE span. WARNING: omitting it starts the span at the very FIRST node of the conversation, discarding the opening requirements and direction — only omit it when you deliberately want to compress ALL history up to endAnchor, or when the opening requirements are stale and you intend a rebaseline.' },
      endAnchor: { type: 'string', description: 'REQUIRED. Verbatim OPENING of the LAST node of the span (unique prefix of exactly one message). That node itself is replaced — pass its predecessor\'s opening to keep it.' },
      summary: { type: 'string', description: 'REQUIRED. The full Markdown checkpoint that replaces the span, written by YOU from the conversation content. Adapt the structure to the scene: Progress → ## sections Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Current Work / Next Step; Correction → what went wrong, root cause, the fix, what to keep doing next; Rebaseline → current intent, surviving decisions, plan ahead. Always: terse bullets; preserve exact paths/commands/identifiers and the user\'s requirements and direction; never a verbatim copy of the span (the engine rejects a summary not smaller than the compressed content).' },
      note: { type: 'string', description: 'Optional. What this checkpoint must preserve for later steps (extra emphasis, not a replacement for anchors).' },
      name: { type: 'string', description: 'Optional. Archive file base name for the raw copy (backend sanitizes it). Default: context-compacted-<start>-<end>.txt.' },
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
      const defaultName = 'context-compacted-' + startSeq + '-' + endSeq + '.txt'
      let archived: SurfaceArchive | null = null
      let archiveError: JsonValue | null = null
      if (config.autoArchive && spillStore) {
        try {
          archived = await archiveSpan(agent, spillStore, nodes, b.si, b.ei, typeof args.name === 'string' && args.name ? args.name : defaultName)
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

