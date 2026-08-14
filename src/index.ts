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
  const sessionQuery = ctx.get('sessionQuery')
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

  async function readSurfaceNodes(sessionId: string): Promise<SurfaceNode[] | null> {
    if (!sessionQuery) return null
    const snap = await sessionQuery.readSurface(sessionId)
    return snap && Array.isArray(snap.events) ? (snap.events as SurfaceNode[]) : []
  }

  function surfaceOpLabel(n: SurfaceNode): string {
    const op = n.surfaceOp
    if (!op) return '?'
    if (op === 'append') return 'append'
    if (typeof op === 'object' && (op as { op?: string }).op === 'replace') return 'replace(summary-checkpoint)'
    return '?'
  }

  function findBoundaries(nodes: SurfaceNode[], startSeq: number, endSeq: number): { error: string } | { si: number; ei: number } {
    let si = -1
    let ei = -1
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].seq === startSeq) si = i
      if (nodes[i].seq === endSeq) ei = i
    }
    if (si === -1) return { error: 'start seq ' + startSeq + ' not found on the current surface' }
    if (ei === -1) return { error: 'end seq ' + endSeq + ' not found on the current surface' }
    if (si > ei) return { error: 'start seq ' + startSeq + ' sits after end seq ' + endSeq + ' on the surface' }
    return { si: si, ei: ei }
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
    name: 'context_surface',
    description: 'List the current conversation surface: every message node the model currently sees, in order, with its seq, surface position (pos), type, surface op, character length and a short preview. The SEQ values are what you pass as inclusive start/end to context_compact and context_archive. Always re-run this tool after a compaction: the surface changes and a summary checkpoint node (op = replace(summary-checkpoint)) appears.',
    parameters: {
      offset: { type: 'integer', description: 'Skip this many leading nodes. Default 0.' },
      limit: { type: 'integer', description: 'Return at most this many nodes. Default 200.' },
      previewChars: { type: 'integer', description: 'Preview length per node. Default 120.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      const nodes = await readSurfaceNodes(agent.session.id)
      if (nodes === null) throw new Error('sessionQuery service is not available in this runtime')
      const offset = Math.max(0, Number(args.offset) || 0)
      const limit = Math.max(1, Number(args.limit) || 200)
      const pc = Math.max(1, Number(args.previewChars) || 120)
      const rows: { seq: number; pos: number; type: string; op: string; chars: number; preview: string }[] = []
      for (let i = offset; i < nodes.length && rows.length < limit; i++) {
        const n = nodes[i]
        const text = nodeText(n)
        rows.push({ seq: n.seq, pos: i, type: n.type as string, op: surfaceOpLabel(n), chars: text.length, preview: preview(text, pc) })
      }
      return {
        sessionId: agent.session.id,
        total: nodes.length,
        count: rows.length,
        offset: offset,
        note: 'Pass SEQ values (not pos) as inclusive start/end to context_compact / context_archive. The backend locates them on the surface by seq; start must sit at or before end on the surface.',
        nodes: rows,
      }
    },
  })))

  disposers.push(tools.register(defineTool({
    name: 'context_archive',
    description: 'Backup ONLY: save the full raw text of a surface span between boundary seqs [start..end] (inclusive, from context_surface) to a session-scoped spill artifact, without touching the surface. Use it when you want a durable copy of a span you are NOT about to compress yet. When you ARE compacting, context_compact already archives the raw span automatically, so you do not need this tool. Returns a locator plus a retrievalHint that tells how to read the raw text later (e.g. with the read tool) if the summary turns out too thin.',
    parameters: {
      start: { type: 'integer', required: true, description: 'Inclusive start boundary seq (from context_surface) of the span to archive.' },
      end: { type: 'integer', required: true, description: 'Inclusive end boundary seq (from context_surface) of the span to archive.' },
      name: { type: 'string', description: 'Suggested artifact base name, e.g. wrong-direction-analysis.txt (backend sanitizes it to one safe path segment).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      const spillStore = resolveService(agent, 'spillStore') as SpillStoreLike | undefined
      if (!spillStore) throw new Error('spillStore service is not available in this runtime (tried host plane and preset realm)')
      const nodes = await readSurfaceNodes(agent.session.id)
      if (nodes === null) throw new Error('sessionQuery service is not available in this runtime')
      const startSeq = Number(args.start)
      const endSeq = Number(args.end)
      if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq)) {
        throw new Error('invalid boundary seqs: got start=' + args.start + ' end=' + args.end)
      }
      const b = findBoundaries(nodes, startSeq, endSeq)
      if ('error' in b) throw new Error(b.error)
      const ref = await archiveSpan(agent, spillStore, nodes, b.si, b.ei, typeof args.name === 'string' && args.name ? args.name : 'context-archive.txt')
      if (!ref) throw new Error('spillStore failed to save the span')
      return {
        sessionId: agent.session.id,
        boundarySeqs: { start: startSeq, end: endSeq },
        archivedSeqs: ref.archivedSeqs,
        chars: ref.chars,
        locator: ref.locator,
        bytes: ref.bytes,
        retrievalHint: ref.retrievalHint,
      }
    },
  })))

  disposers.push(tools.register(defineTool({
    name: 'context_compact',
    description: 'Agent-controlled context compression, one step: FIRST saves the full raw text of the surface span between boundary seqs [start..end] (inclusive, from context_surface) to a session-scoped spill artifact (auto-archive), THEN replaces the span with ONE summary node. The compaction engine is upgraded by this plugin: the summarization input is the FULL context up to the region end (maximizing KV-cache reuse via a genuine prefix of the last routed request) plus a scoped instruction that compresses only messages #k..#m. Constraints enforced by the backend: both boundary seqs must exist on the current surface, start must sit at or before end, both edges must be balanced (never split an assistant tool-call/result pair, end boundary step must be closed), and only one compaction may run per session at a time. Keep the still-active user instruction out of the range. After success, re-run context_surface to see the new checkpoint node and re-map seqs.',
    parameters: {
      start: { type: 'integer', required: true, description: 'Inclusive start boundary seq (from context_surface) of the span to compress.' },
      end: { type: 'integer', required: true, description: 'Inclusive end boundary seq (from context_surface) of the span to compress.' },
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
      const startSeq = Number(args.start)
      const endSeq = Number(args.end)
      if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq)) {
        throw new Error('invalid boundary seqs: got start=' + args.start + ' end=' + args.end)
      }
      const nodes = await readSurfaceNodes(agent.session.id)
      if (nodes === null) throw new Error('sessionQuery service is not available in this runtime')
      const b = findBoundaries(nodes, startSeq, endSeq)
      if ('error' in b) throw new Error(b.error)

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
        advice: 'Re-run context_surface: the span is now one summary checkpoint node and the surface changed. If the summary turns out too thin, read the archived raw copy using the retrievalHint.',
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
