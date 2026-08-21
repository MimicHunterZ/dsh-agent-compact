// @mimichunterz/agent-compact: ctx-surface host service (Typert Remote).
//
// Exposes the session's LIVE model surface (readSurface, folded, shadowed
// events removed) to the browser client as a typed Remote (`ctxSurface/read`).
// The client panel renders exactly what context_compact sees: same
// readSurface source, same skipReasoning text, same seq coordinate system —
// so a user-picked span in the panel maps 1:1 to startAnchor/endAnchor
// resolution inside the tool.

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'

// ---- wire types (mirrored in lib/typert.host.js + lib/typert.remote-client.js) ----

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
  readonly blocks: readonly CtxSurfaceBlock[]
  // Raw `data.source.kind` off a `user/message` event (undefined for every
  // other row type). The shipped trajectory panel uses this exact field
  // (see its trajectory-message-definitions.js: `event.data.source.kind !==
  // "user"`) to tell a real user turn apart from a same-shaped but
  // synthetically-injected "context" row (plugin/system reminder, session
  // recall, skill invocation, etc: anything in MessageSourceMap other than
  // `{kind:'user'}`). Mirrored so the client can color/group rows the same
  // way trajectory does instead of treating every `user/message` row alike.
  readonly source?: string
}

export interface CtxSurfaceReadRequest {
  readonly sessionId: string
}

// NOTE: the Typert Remote transport already wraps this method's outcome in
// its own `{ok:true,value}` / `{ok:false,error}` envelope on the wire — do
// NOT repeat that shape here. An earlier version returned a second, business
// -level {ok,value}|{ok:false,error} union, which produced a DOUBLE-WRAPPED
// result (`{ok:true,value:{ok:true,value:{rows}}}`); the browser panel only
// unwraps one level, so `result.value.rows` was always undefined and the
// panel showed "暂无 surface 消息" even though the host had real rows. Throw
// on failure instead; the transport turns that into the wire-level error.
export interface CtxSurfaceReadResult {
  readonly rows: readonly CtxSurfaceRow[]
}

// ---- host-only helpers ----

interface SurfaceNodeLike {
  type?: string
  seq?: number
  data?: unknown
}

interface SurfaceNodeData {
  message?: { content?: unknown } | null
  content?: unknown
  source?: { kind?: unknown } | null
}

interface SessionQueryLike {
  readSurface(sessionId: string): Promise<{ events?: unknown } | null>
}

interface AnyBlock {
  type?: string
  text?: unknown
  name?: unknown
  arguments?: unknown
  isError?: unknown
  content?: unknown
}

const TEXT_MAX = 8000
const BLOCKS_MAX = 20

function nodeContent(n: SurfaceNodeLike): unknown {
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

// skipReasoning keeps panel text aligned with the model view and the
// anchor-matching text (DeepSeek moves reasoning to a separate wire field).
// maxLen bounds concatenation so oversized tool results never blow up the
// RPC payload; chars is a pure length count of the FULL block text.
function blockText(b: unknown, depth: number, skipReasoning: boolean, maxLen: number): { text: string; chars: number } {
  if (depth > 5 || !b || typeof b !== 'object') return { text: '', chars: 0 }
  const blk = b as AnyBlock
  if (skipReasoning && blk.type === 'reasoning') return { text: '', chars: 0 }
  if (typeof blk.text === 'string') {
    return { text: truncate(blk.text, maxLen), chars: blk.text.length }
  }
  if (blk.type === 'tool-call') {
    const raw = '[tool-call ' + String(blk.name ?? '') + '] ' + (typeof blk.arguments === 'string' ? blk.arguments : '')
    return { text: truncate(raw, maxLen), chars: raw.length }
  }
  if (blk.type === 'tool-result') {
    const inner = blocksText(blk.content, depth + 1, skipReasoning, maxLen)
    const raw = '[tool-result' + (blk.isError ? ' error' : '') + '] ' + inner.text
    return { text: truncate(raw, maxLen), chars: inner.chars + 1 }
  }
  if (blk.type === 'image') return { text: '[image]', chars: 7 }
  if (Array.isArray(blk.content)) {
    const inner = blocksText(blk.content, depth + 1, skipReasoning, maxLen)
    return { text: inner.text, chars: inner.chars }
  }
  return { text: '', chars: 0 }
}

function blocksText(blocks: unknown, depth: number, skipReasoning: boolean, maxLen: number): { text: string; chars: number } {
  if (!Array.isArray(blocks)) return { text: '', chars: 0 }
  let out = ''
  let chars = 0
  let remain = maxLen
  for (const b of blocks) {
    const part = blockText(b, depth, skipReasoning, remain)
    if (part.chars > 0) {
      chars += part.chars
      if (part.text.length > 0) {
        out += part.text + '\n'
        remain = Math.max(0, maxLen - out.length)
      }
    }
  }
  return { text: out, chars }
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen)
}

function kindOf(b: unknown): CtxSurfaceBlock['kind'] {
  const blk = b as AnyBlock
  switch (blk.type) {
    case 'text': return 'text'
    case 'reasoning': return 'reasoning'
    case 'tool-call': return 'tool-call'
    case 'tool-result': return 'tool-result'
    case 'image': return 'image'
    default: return 'block'
  }
}

// Only `user/message` events carry a `data.source` (see MessageSourceMap:
// user/plugin/model/tool/goal/session-reference); every other row type
// returns undefined and is left off the wire row entirely.
function sourceKindOf(n: SurfaceNodeLike): string | undefined {
  if (n.type !== 'user/message') return undefined
  const d = (n.data as SurfaceNodeData | undefined) ?? null
  const kind = d && d.source && typeof d.source === 'object' ? (d.source as { kind?: unknown }).kind : undefined
  return typeof kind === 'string' ? kind : undefined
}

function blockLabel(b: unknown): string | undefined {
  const blk = b as AnyBlock
  if (blk.type === 'tool-call' || blk.type === 'tool-result') {
    const name = typeof blk.name === 'string' && blk.name ? blk.name : undefined
    return name
  }
  return undefined
}

function rowOf(n: SurfaceNodeLike): CtxSurfaceRow | null {
  const seq = n.seq
  const type = n.type
  if (typeof seq !== 'number' || !type) return null
  const blocks: CtxSurfaceBlock[] = []
  const content = nodeContent(n)
  if (Array.isArray(content)) {
    let remain = TEXT_MAX
    for (const b of content) {
      if (blocks.length >= BLOCKS_MAX) break
      const part = blockText(b, 0, true, remain)
      if (part.chars === 0 && part.text.length === 0) continue
      const block: CtxSurfaceBlock = {
        kind: kindOf(b),
        text: part.text,
        chars: part.chars,
        ...(blockLabel(b) !== undefined ? { label: blockLabel(b) as string } : {}),
      }
      blocks.push(block)
      remain = Math.max(0, TEXT_MAX - blocks.reduce((acc, blk) => acc + blk.text.length, 0))
    }
  }
  const flat = blocksText(content, 0, true, TEXT_MAX)
  const source = sourceKindOf(n)
  return {
    seq,
    type,
    text: flat.text.replace(/\n+$/, ''),
    chars: flat.chars,
    blocks,
    ...(source !== undefined ? { source } : {}),
  }
}

/**
 * Live-surface reader for the browser panel. Pure consumer: reads the folded
 * surface snapshot and never mutates the session.
 */
export class CtxSurfaceService extends TypertRemoteService {
  /**
   * @param ctx - Host context carrying sessionQuery.
   */
  constructor(ctx: Context) {
    super(ctx, 'ctxSurface')
  }

  /**
   * Read the current folded surface rows of one session (shadowed events
   * removed, model history order, seq-stamped).
   * @param request - session to inspect.
   * @returns folded rows or an explicit failure.
   */
  @Remote('read')
  async read(request: CtxSurfaceReadRequest): Promise<CtxSurfaceReadResult> {
    const sessionQuery = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (!sessionQuery) {
      throw new Error('session-query-unavailable')
    }
    let snap: { events?: unknown } | null
    try {
      snap = await sessionQuery.readSurface(request.sessionId)
    } catch (err) {
      const message = err && (err as Error).message ? (err as Error).message : String(err)
      this.ctx.logger.warn('[agent-compact] ctxSurface/read failed for %s: %s', request.sessionId, message)
      throw new Error(message)
    }
    const events = snap && Array.isArray(snap.events) ? (snap.events as unknown[]) : []
    const rows: CtxSurfaceRow[] = []
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue
      const row = rowOf(ev as SurfaceNodeLike)
      if (row) rows.push(row)
    }
    return { rows }
  }
}
