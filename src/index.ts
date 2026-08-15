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

export const Config = Schema.object({
  autoArchive: Schema.boolean().default(true).description('context_compact saves the full raw span to a spill artifact before replacing it.'),
  maxTokens: Schema.number().default(16384).description('Output budget for the summarization call. Floored at 16384 because deepseek-v4-flash thinking mode otherwise truncates the checkpoint at the stock 8192 cap.'),
})

interface PluginConfig {
  autoArchive: boolean
  maxTokens: number
}

export function apply(ctx: Context, config: PluginConfig) {
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
    _lastDiag?: unknown
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

  function findSeqIndex(nodes: SurfaceNode[], seq: number): number {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].seq === seq) return i
    }
    return -1
  }

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

  // exact (3) > prefix (2) > contains (1); -1 = no match
  // contains is only allowed for anchors long enough to be distinctive, so a
  // short anchor (e.g. a user message like "继续") cannot spray-match nodes.
  function matchScore(nodeRaw: string, anchorNorm: string): number {
    if (!anchorNorm) return -1
    const n = normText(nodeRaw)
    const s = strippedText(nodeRaw)
    if (n === anchorNorm || s === anchorNorm) return 3
    if (n.startsWith(anchorNorm) || s.startsWith(anchorNorm)) return 2
    if (anchorNorm.length >= 24 && (n.includes(anchorNorm) || s.includes(anchorNorm))) return 1
    return -1
  }

  function findAnchorIndex(nodes: SurfaceNode[], anchor: string, prefer: 'first' | 'last'): number {
    const a = normText(anchor)
    let best = -1
    let bestScore = -1
    for (let i = 0; i < nodes.length; i++) {
      const score = matchScore(nodeText(nodes[i]), a)
      if (score < 0) continue
      if (prefer === 'last') {
        if (score >= bestScore) {
          bestScore = score
          best = i
        }
      } else if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    return best
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

  // An anchor can accidentally match the CURRENT in-flight turn's tool-call
  // node (the call's own arguments become part of the surface). That node is
  // not a usable boundary: its results have not landed yet and it is an open,
  // unbalanced step. Skip it and keep looking at earlier nodes.
  function findAnchorIndexSkippingOpen(nodes: SurfaceNode[], anchor: string, prefer: 'first' | 'last'): number {
    const idx = findAnchorIndex(nodes, anchor, prefer)
    if (idx === nodes.length - 1 && /\[tool-call/.test(nodeText(nodes[idx]))) {
      return findAnchorIndex(nodes.slice(0, -1), anchor, prefer)
    }
    return idx
  }

  function resolveBoundaries(nodes: SurfaceNode[], args: { start?: unknown; end?: unknown; startAnchor?: unknown; endAnchor?: unknown }): BoundaryResolveResult {
    if (!nodes.length) throw new Error('surface is empty; nothing to compact')
    const startNum = args.start === undefined || args.start === null ? NaN : Number(args.start)
    const endNum = args.end === undefined || args.end === null ? NaN : Number(args.end)
    const startOk = Number.isInteger(startNum)
    const endOk = Number.isInteger(endNum)
    const startAnchor = typeof args.startAnchor === 'string' && args.startAnchor.trim() ? args.startAnchor : ''
    const endAnchor = typeof args.endAnchor === 'string' && args.endAnchor.trim() ? args.endAnchor : ''
    // The end side is REQUIRED to bound the span; start defaults to the first node.
    if (!endOk && !endAnchor) {
      throw new Error('cannot resolve the end boundary: provide end (seq) or endAnchor (verbatim text of the LAST node of the span to compress; that node itself is compressed — use its predecessor to keep it)')
    }
    let si = -1
    let ei = -1
    const method: string[] = []
    if (startOk) {
      si = findSeqIndex(nodes, startNum)
      if (si === -1) throw new Error('start seq ' + startNum + ' not found on the current surface')
      method.push('start=seq')
    } else if (startAnchor) {
      si = findAnchorIndexSkippingOpen(nodes, startAnchor, 'first')
      if (si === -1) {
        const hint = nearestHint(nodes, normText(startAnchor))
        throw new Error('startAnchor not found on the surface: ' + preview(startAnchor, 120) + (hint ? '\nclosest nodes:\n' + hint : ''))
      }
      method.push('start=anchor')
    } else {
      si = 0
      method.push('start=first')
    }
    if (endOk) {
      ei = findSeqIndex(nodes, endNum)
      if (ei === -1) throw new Error('end seq ' + endNum + ' not found on the current surface')
      method.push('end=seq')
    } else {
      ei = findAnchorIndexSkippingOpen(nodes, endAnchor, 'last')
      if (ei === -1) {
        const hint = nearestHint(nodes, normText(endAnchor))
        throw new Error('endAnchor not found on the surface: ' + preview(endAnchor, 120) + (hint ? '\nclosest nodes:\n' + hint : ''))
      }
      method.push('end=anchor')
    }
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
    description: 'Agent-controlled context compression, one step: FIRST saves the full raw text of the surface span to a session-scoped spill artifact (auto-archive), THEN replaces the span with ONE summary checkpoint node. Locate the span by ANCHOR TEXT — no context_surface call needed: copy the verbatim content of the LAST node of the span as endAnchor (e.g. the leading lines of your own last tool result); the tool resolves it on the CURRENT surface by normalized text match (exact > prefix > contains, whitespace-insensitive, [tool-*] markers ignored; LAST occurrence wins) and compresses [firstNode..endAnchor] inclusively — the endAnchor node itself IS compressed, so pass its predecessor to keep it. For a mid-conversation span also pass startAnchor (verbatim content of the FIRST node of the span; FIRST occurrence wins). start/end seqs are optional alternatives. Matched edges are snapped to balanced tool-call/result boundaries. A failed match throws with the closest node previews to help you pick the right text. The compaction engine is upgraded by this plugin: the summarization input is the FULL context up to the region end (maximizing KV-cache reuse via a genuine prefix of the last routed request) plus a scoped instruction that compresses only messages #k..#m. Constraints: both boundary seqs must exist on the current surface, start must sit at or before end, both edges must be balanced (never split an assistant tool-call/result pair, end boundary must be closed), and only one compaction may run per session at a time. Keep the still-active user instruction out of the range. The raw span is archived: read it back later via the returned locator/retrievalHint.',
    parameters: {
      start: { type: 'integer', description: 'Inclusive start boundary seq. Optional — defaults to the very first surface node.' },
      end: { type: 'integer', description: 'Inclusive end boundary seq (the last node to compress). Alternative to endAnchor.' },
      startAnchor: { type: 'string', description: 'Verbatim text of the FIRST node of the span (its beginning). Exact/prefix/contains match, whitespace-insensitive, [tool-*] markers ignored; first occurrence wins. Optional — defaults to the first node.' },
      endAnchor: { type: 'string', description: 'REQUIRED unless end is given. Verbatim text of the LAST node of the span (what the span ends with — that node itself is compressed; pass its predecessor to keep it). Matched like startAnchor but last occurrence wins.' },
      note: { type: 'string', description: 'Optional short note: why this range is finished and what the summary must preserve for later steps. Echoed in the result only.' },
      name: { type: 'string', description: 'Optional suggested archive file name for the auto-archived raw copy (backend sanitizes it). Default: context-compacted-<start>-<end>.txt.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      const engine = resolveService(agent, 'compaction') as CompactionLike | undefined
      if (!engine) throw new Error('compaction service is not available in this runtime (tried host plane and preset realm)')
      patchEngine(engine as unknown as OptimizedEngineLike, { maxTokens: config.maxTokens })
      const nodes = await readSurfaceNodes(agent)
      if (nodes === null) throw new Error('sessionQuery service is not available in this runtime')
      const b = resolveBoundaries(nodes, args)
      const startSeq = b.startSeq
      const endSeq = b.endSeq

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
      const out: {
        ok: boolean
        sessionId: string
        compactionId: JsonValue
        boundarySeqs: { start: number; end: number }
        boundaryMethod: string
        surfaceTotal: number
        shadowedRange: { start: number; end: number } | null
        shadowedSeqs: JsonValue[]
        shadowedTokenCount: JsonValue | null
        summary: string
        usage: JsonValue | null
        engineDiag: JsonValue | null
        archived: SurfaceArchive | null
        archiveError: JsonValue | null
        advice: string
        note?: string
      } = {
        ok: true,
        sessionId: agent.session.id,
        compactionId: result.compactionId,
        boundarySeqs: { start: startSeq, end: endSeq },
        boundaryMethod: b.method,
        surfaceTotal: nodes.length,
        shadowedRange: result.shadowedRange ? { start: result.shadowedRange.start, end: result.shadowedRange.end } : null,
        shadowedSeqs: Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs : [],
        shadowedTokenCount: result.shadowedTokenCount ?? null,
        summary: blocksText(Array.isArray(result.summary) ? result.summary : null, 0).replace(/\n+$/, ''),
        usage: usage,
        engineDiag: engine._lastDiag ? (engine._lastDiag as JsonValue) : null,
        archived: archived ? {
          locator: archived.locator,
          bytes: archived.bytes,
          retrievalHint: archived.retrievalHint,
          chars: archived.chars,
          archivedSeqs: archived.archivedSeqs,
        } : null,
        archiveError: archiveError,
        advice: 'The span is now one summary checkpoint node and the surface shrank (see surfaceTotal). If the summary turns out too thin, read the archived raw copy using the retrievalHint.',
      }
      if (typeof args.note === 'string') out.note = args.note
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

