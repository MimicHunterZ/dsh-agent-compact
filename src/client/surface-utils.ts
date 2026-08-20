// Pure helpers for the ctx-surface panel: row classification, timeline
// geometry, and the anchor-based compress-prompt builder that keeps a
// user-picked span in this panel mapped 1:1 to context_compact's
// startAnchor/endAnchor resolution (see ../ctx-surface.ts's module doc).
import type { CtxSurfaceRow } from './types.js'

export function isToolRow(row: CtxSurfaceRow): boolean {
  return row.type === 'tool/result'
}

export function isToolCallOnly(row: CtxSurfaceRow): boolean {
  return row.type === 'assistant/message' && row.blocks.length > 0 && row.blocks.every((b) => b.kind === 'tool-call')
}

export function rowKind(type: string): 'user' | 'message' | 'tool' {
  if (type === 'user/message') return 'user'
  if (type === 'tool/result') return 'tool'
  return 'message'
}

// timeline lane: tool/result -> 2, assistant/message -> 1, everything else -> 0.
export function laneOf(row: CtxSurfaceRow): number {
  if (row.type === 'tool/result') return 2
  if (row.type === 'assistant/message') return 1
  return 0
}

export function rowPreview(row: CtxSurfaceRow): string {
  if (isToolRow(row)) {
    const call = row.blocks.find((b) => b.kind === 'tool-result')
    if (call && call.label) return call.label
  }
  for (const b of row.blocks) if (b.kind === 'tool-call') return b.text.slice(0, 40)
  return row.text.slice(0, 120) || '(空)'
}

const MIN_ANCHOR_LEN = 10
const MAX_ANCHOR_LEN = 300

function normAnchor(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/[\p{P}\p{S}]+/gu, '')
}

/**
 * Build the shortest normalized prefix of one row's flattened text that is
 * unique among all rows — this is the exact anchor text context_compact's
 * startAnchor/endAnchor resolution matches against, so it must stay in sync
 * with that tool's own prefix-growth algorithm (see the tool's own doc).
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
  // map normalized length back onto the raw (un-normalized) text: normAnchor
  // only removes whitespace/punctuation, never reorders, so walking the raw
  // string until it has produced `len` normalized characters is safe.
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
