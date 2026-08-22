// ctx-surface 面板的纯辅助函数：行分类、时间线几何、锚点压缩提示构造。
import type { CtxSurfaceRow } from './types.js'

export function isToolRow(row: CtxSurfaceRow): boolean {
  return row.type === 'tool/result'
}

export function isToolCallOnly(row: CtxSurfaceRow): boolean {
  return row.type === 'assistant/message' && row.blocks.length > 0 && row.blocks.every((b) => b.kind === 'tool-call')
}

// source.kind 非 'user' 的 user/message 行是合成的 "context" 行，而非真实用户轮次。
export function rowKind(row: CtxSurfaceRow): 'user' | 'context' | 'message' | 'tool' {
  if (row.type === 'tool/result') return 'tool'
  if (row.type === 'user/message') return row.source !== undefined && row.source !== 'user' ? 'context' : 'user'
  return 'message'
}

// 时间线泳道：tool/result -> 2，assistant/message -> 1，其余 -> 0。
export function laneOf(row: CtxSurfaceRow): number {
  if (row.type === 'tool/result') return 2
  if (row.type === 'assistant/message') return 1
  return 0
}

// 每个输入行（user 或 context）开启一个新的 "turn"。
export function isTurnStart(row: CtxSurfaceRow): boolean {
  const k = rowKind(row)
  return k === 'user' || k === 'context'
}

// 类型标签的短徽标（USER/ASSISTANT/TOOL/CONTEXT）；完整线上类型保留在 title。
const KIND_LABEL: Record<ReturnType<typeof rowKind>, string> = {
  user: 'USER',
  context: 'CONTEXT',
  message: 'ASSISTANT',
  tool: 'TOOL',
}

export function rowLabel(row: CtxSurfaceRow): string {
  return KIND_LABEL[rowKind(row)]
}

export function rowPreview(row: CtxSurfaceRow): string {
  if (isToolRow(row)) {
    const call = row.blocks.find((b) => b.kind === 'tool-result')
    if (call && call.label) return call.label
  }
  for (const b of row.blocks) if (b.kind === 'tool-call') return b.text.slice(0, 40)
  if (row.text.slice(0, 120)) return row.text.slice(0, 120)
  // row.text 已去掉图片标记，图片行回退到 row.blocks 判断。
  if (row.blocks.some((b) => b.kind === 'image')) return '[图片]'
  return '(空)'
}

const MIN_ANCHOR_LEN = 10
const MAX_ANCHOR_LEN = 300

function normAnchor(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/[\p{P}\p{S}]+/gu, '')
}

/**
 * 构建一行扁平文本的最短归一化前缀，且该前缀在所有行中唯一——这正是
 * context_compact 的 startAnchor/endAnchor 解析要匹配的锚点文本，因此必须与
 * 该工具自身的前缀增长算法保持同步（参见工具自身的文档）。
 */
export function uniqueAnchorPrefix(rows: readonly CtxSurfaceRow[], idx: number): string {
  const target = rows[idx]
  const flat = target.text
  const normed = rows.map((r) => normAnchor(r.text))
  const targetNorm = normed[idx]
  let len = Math.min(MIN_ANCHOR_LEN, targetNorm.length)
  while (len < Math.min(MAX_ANCHOR_LEN, targetNorm.length)) {
    const prefix = targetNorm.slice(0, len)
    const collides = normed.some((n, i) => i !== idx && n.slice(0, len) === prefix)
    if (!collides) break
    len += 1
  }
  // 把归一化长度映射回原始（未归一化）文本：normAnchor 只删除空白/标点，从不
  // 重排，因此在原始字符串上走到产生 `len` 个归一化字符是安全的。
  let rawEnd = 0
  let produced = 0
  while (rawEnd < flat.length && produced < len) {
    const ch = flat[rawEnd]
    rawEnd += 1
    if (!/\s/.test(ch) && !/[\p{P}\p{S}]/u.test(ch)) produced += 1
  }
  return flat.slice(0, Math.max(rawEnd, Math.min(len, flat.length))) || flat
}

export function compressPrompt(rows: readonly CtxSurfaceRow[], startIdx: number, endIdx: number): string {
  const start = uniqueAnchorPrefix(rows, startIdx)
  const end = uniqueAnchorPrefix(rows, endIdx)
  return '区间起点该消息的开头文本是:「' + start + '」\n区间终点该消息的开头文本是:「' + end + '」\n\n请调用 context_compact 压缩这一段区间:startAnchor 填上面的起点文本,endAnchor 填上面的终点文本;检查点(summary)由你自己编写,必须是 Markdown 且比原区间小,保留关键路径/命令/ID 与原始需求、方向。'
}
