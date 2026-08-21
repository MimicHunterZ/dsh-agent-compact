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

// Mirrors the shipped trajectory panel's own kind classification (see its
// trajectory-message-definitions.js): a `user/message` row whose recorded
// `source.kind` is anything other than `'user'` (plugin/system reminder,
// session recall, skill invocation, ...) is a synthetic "context" row, not
// a real user turn — same distinction trajectory colors green vs blue.
export function rowKind(row: CtxSurfaceRow): 'user' | 'context' | 'message' | 'tool' {
  if (row.type === 'tool/result') return 'tool'
  if (row.type === 'user/message') return row.source !== undefined && row.source !== 'user' ? 'context' : 'user'
  return 'message'
}

// timeline lane: tool/result -> 2, assistant/message -> 1, everything else -> 0.
export function laneOf(row: CtxSurfaceRow): number {
  if (row.type === 'tool/result') return 2
  if (row.type === 'assistant/message') return 1
  return 0
}

// A new "turn" starts at every real or synthetic input row (rowKind user or
// context) — our flat surface has no server-side turn number the way
// trajectory's own event-log analysis does, so grouping for the Turns
// toggle is derived purely from this boundary.
export function isTurnStart(row: CtxSurfaceRow): boolean {
  const k = rowKind(row)
  return k === 'user' || k === 'context'
}

// Short badge text for the kind tag — mirrors trajectory's own table
// (USER/ASSISTANT/TOOL/CONTEXT), instead of the raw `user/message` /
// `assistant/message` / `tool/result` wire type string, which is long
// enough to force the whole 类型 column wide and crowd out the content
// preview column. The full wire type stays available as the tag's title
// attribute (see CtxSurfaceView.tsx) so nothing is lost, just not shown by
// default.
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
  // row.text deliberately drops image markers now (see ctx-surface.ts's
  // blockText dropImages — keeps compressPrompt's anchors matching
  // index.ts's own image-free anchor text), so an image-only row with no
  // caption would otherwise show '(空)' with no hint an image is there;
  // row.blocks still carries the untouched per-block entries, so fall back
  // to that before giving up.
  if (row.blocks.some((b) => b.kind === 'image')) return '[图片]'
  return '(空)'
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
