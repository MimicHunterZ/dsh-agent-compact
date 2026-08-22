// @mimichunterz/agent-compact: ctx-surface 主机服务（Typert Remote）。
// 把会话的实时模型 surface 作为类型化 Remote（`ctxSurface/read`）暴露给
// 浏览器客户端，供「上下文」面板渲染。

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { blockText, blocksText, nodeContent } from './surface-text.js'

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
  // 估算 token 数（chars/4+4 启发式，非真实计费值）。可选：宿主进程不热重载，
  // 客户端 bundle 会，两端存在更新窗口期。
  tokens: z.number().readonly().optional(),
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

// 估算 token 的启发式常数，照抄 @deepseek-ai/dsh-token-meter（chars/4 + 每条
// 消息 +4），与宿主压缩提醒的口径一致。用未截断的 flat.chars 本地算即可。
const TOKEN_CHARS_PER_TOKEN = 4
const TOKEN_MESSAGE_OVERHEAD = 4

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / TOKEN_CHARS_PER_TOKEN) + TOKEN_MESSAGE_OVERHEAD
}

// nodeContent/blockText/blocksText 来自 ./surface-text.ts：与锚点匹配
// （src/index.ts）共用同一套 surface 节点→文本遍历逻辑，避免两处各自维护、
// 悄悄漂移。面板这里用 `{ skipReasoning: true, dropImages: true }` 且带截断
// 预算；锚点匹配那边用同一函数、不截断、且 dropImages 与 skipReasoning 同步。

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
      const part = blockText(b, 0, { skipReasoning: true }, remain)
      if (part.chars === 0 && part.text.length === 0) continue
      const label = blockLabel(b)
      const block: CtxSurfaceBlock = {
        kind: kindOf(b),
        text: part.text,
        chars: part.chars,
        ...(label !== undefined ? { label } : {}),
      }
      blocks.push(block)
      remain = Math.max(0, TEXT_MAX - blocks.reduce((acc, blk) => acc + blk.text.length, 0))
    }
  }
  const flat = blocksText(content, 0, { skipReasoning: true, dropImages: true }, TEXT_MAX)
  const source = sourceKindOf(n)
  return {
    seq,
    type,
    text: flat.text.replace(/\n+$/, ''),
    chars: flat.chars,
    tokens: estimateTokensFromChars(flat.chars),
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
