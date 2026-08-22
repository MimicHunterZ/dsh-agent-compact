// @mimichunterz/agent-compact: ctx-surface 主机服务（Typert Remote）。
// 把会话的实时模型 surface 作为类型化 Remote（`ctxSurface/read`）暴露给
// 浏览器客户端，供「上下文」面板渲染。

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'

// ---- 线上类型（schema 为唯一源头，host/client 描述符直接复用；类型由 schema
// 推导。下面的 schema 定义区段会被 scripts/build-client.mjs 提取进浏览器 bundle，
// 勿在区段内引用本文件的其他运行时值）----

// ctx-surface wire schemas start
export const request$schema = z.object({
  sessionId: z.intersection(z.string(), z.unknown()).readonly(),
})

export const block$schema = z.object({
  kind: z.union([z.literal('text'), z.literal('reasoning'), z.literal('tool-call'), z.literal('tool-result'), z.literal('image'), z.literal('block')]).readonly(),
  label: z.string().readonly().optional(),
  text: z.string().readonly(),
  chars: z.number().readonly(),
})

export const row$schema = z.object({
  seq: z.number().readonly(),
  type: z.string().readonly(),
  text: z.string().readonly(),
  chars: z.number().readonly(),
  blocks: z.array(block$schema).readonly(),
  // `user/message` 事件上的原始 `data.source.kind`，用于区分真实用户轮次与
  // 合成注入的 "context" 行（与官方 trajectory 面板的判定一致）。
  source: z.string().readonly().optional(),
})

export const result$schema = z.object({
  rows: z.array(row$schema).readonly(),
}).readonly()
// ctx-surface wire schemas end（提取区段终点）

export type CtxSurfaceBlock = z.infer<typeof block$schema>
export type CtxSurfaceRow = z.infer<typeof row$schema>
export type CtxSurfaceReadRequest = z.infer<typeof request$schema>

// 注意：传输层会把本方法结果包进 `{ok,value}` / `{ok:false,error}` 信封，
// 这里不要重复该形状，失败时直接抛错即可。
export type CtxSurfaceReadResult = z.infer<typeof result$schema>

// ---- 仅主机端使用的辅助函数 ----

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

// skipReasoning：面板文本与模型视角及锚点匹配文本对齐（跳过 reasoning）。
// maxLen 限制拼接长度，避免撑爆 RPC 载荷；chars 是完整块文本的纯长度计数。
// dropImages：仅用于构建行内扁平 `text`（锚点来源），去掉图片标记；不影响
// `row.blocks` 中逐块的条目。
function blockText(b: unknown, depth: number, skipReasoning: boolean, maxLen: number, dropImages?: boolean): { text: string; chars: number } {
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
    const inner = blocksText(blk.content, depth + 1, skipReasoning, maxLen, dropImages)
    const raw = '[tool-result' + (blk.isError ? ' error' : '') + '] ' + inner.text
    return { text: truncate(raw, maxLen), chars: inner.chars + 1 }
  }
  if (blk.type === 'image') return dropImages ? { text: '', chars: 0 } : { text: '[image]', chars: 7 }
  if (Array.isArray(blk.content)) {
    const inner = blocksText(blk.content, depth + 1, skipReasoning, maxLen, dropImages)
    return { text: inner.text, chars: inner.chars }
  }
  return { text: '', chars: 0 }
}

function blocksText(blocks: unknown, depth: number, skipReasoning: boolean, maxLen: number, dropImages?: boolean): { text: string; chars: number } {
  if (!Array.isArray(blocks)) return { text: '', chars: 0 }
  let out = ''
  let chars = 0
  let remain = maxLen
  for (const b of blocks) {
    const part = blockText(b, depth, skipReasoning, remain, dropImages)
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

// 只有 `user/message` 事件携带 `data.source`（见 MessageSourceMap：
// user/plugin/model/tool/goal/session-reference）；其他行类型返回 undefined，
// 完全不上线。
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
  const flat = blocksText(content, 0, true, TEXT_MAX, true)
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
 * 面向浏览器面板的实时 surface 读取器。纯消费者：读取折叠后的 surface 快照，
 * 绝不修改会话。
 */
export class CtxSurfaceService extends TypertRemoteService {
  /**
   * @param ctx - 携带 sessionQuery 的主机上下文。
   */
  constructor(ctx: Context) {
    super(ctx, 'ctxSurface')
  }

  /**
   * 读取某个会话当前的折叠 surface 行（已移除 shadowed 事件，按模型历史顺序，
   * 带 seq 标记）。
   * @param request - 要检查的会话。
   * @returns 折叠后的行，或显式失败。
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
