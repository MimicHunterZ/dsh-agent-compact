// @mimichunterz/agent-compact: 锚点 → 边界解析的纯函数核心。
// 从 src/index.ts 抽出：这里的一切都只是 `(nodes, args)` 的纯函数，不依赖
// ctx、不发起任何 I/O，因此可以直接单测（见 test/boundary.test.mjs），不需要
// 启一个真的 Cordis 会话或 mock 服务。
//
// 锚点在「当前」surface 上按归一化文本匹配定位 seq，每次调用重新解析；
// 匹配到的边缘会被吸附到平衡的 tool-call/result 边界上。

import { normText } from './normalize.js'
import { nodeFlatText } from './surface-text.js'
import type { SurfaceNode } from './optimizer.js'

interface SurfaceNodeErrorData {
  error?: { code?: unknown } | null
}

/**
 * 恰好携带这一个 tool-call 的 assistant/message 节点（用于判断该调用所属的
 * 消息节点能否被 shadow，而不破坏同一条消息里的其他兄弟 tool-call）。
 */
export function soleToolCall(n: SurfaceNode, callId: string): boolean {
  if (n.type !== 'assistant/message') return false
  const content = (n.data as { message?: { content?: unknown } } | undefined)?.message?.content
  if (!Array.isArray(content)) return false
  const calls = content.filter((b) => {
    const block = b as { type?: unknown; id?: unknown }
    return block !== null && typeof block === 'object' && block.type === 'tool-call'
  })
  return calls.length === 1 && (calls[0] as { id?: unknown }).id === callId
}

// skipReasoning：让锚点匹配文本与模型所见对齐（跳过 reasoning 与图片块）；
// 归档（skipReasoning = false）保留完整原文，reasoning 与图片标记都保留。
export function nodeText(n: SurfaceNode, skipReasoning?: boolean): string {
  const skip = skipReasoning ?? false
  return nodeFlatText(n, { skipReasoning: skip, dropImages: skip })
}

export function nodeErrorTag(n: SurfaceNode): string {
  const d = (n.data as SurfaceNodeErrorData | undefined) ?? null
  if (d && d.error && d.error.code) return ' error=' + String(d.error.code)
  return ''
}

export function preview(text: unknown, max: number): string {
  const t = String(text || '')
  return t.length <= max ? t : t.slice(0, max) + '…'
}

// 宽容变体：去掉渲染器添加的 [tool-call <name>] / [tool-result] 标记。
function strippedText(s: string): string {
  return normText(
    s
      .replace(/\[tool-call\s+[^\]]*\]\s*/g, '')
      .replace(/\[tool-result(?:\s+error)?\]\s*/g, ''),
  )
}

// 一个节点能否作为锚点匹配目标：只看 user/message、assistant/message；
// tool/result 节点不参与匹配，进行中轮次的 tool-call 节点也被排除。
// prefixHits（真正匹配）与 nearestHint（失败提示）共用同一条资格线，
// 保证提示里推荐的候选永远是下一次真的可能命中的节点。
function isEligibleAnchorNode(nodes: SurfaceNode[], i: number): boolean {
  const node = nodes[i]
  if (node.type !== 'user/message' && node.type !== 'assistant/message') return false
  if (i === nodes.length - 1 && /\[tool-call/.test(nodeText(node, true))) return false
  return true
}

// 唯一前缀匹配：锚点必须是恰好一个消息节点的归一化前缀，避免静默替换错节点。
export function prefixHits(nodes: SurfaceNode[], anchor: string): number[] {
  const a = normText(anchor)
  const hits: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (!isEligibleAnchorNode(nodes, i)) continue
    const node = nodes[i]
    const n = normText(nodeText(node, true))
    const s = strippedText(nodeText(node, true))
    if (n.startsWith(a) || s.startsWith(a)) hits.push(i)
  }
  return hits
}

// AMBIGUOUS 候选的预览：多条 checkpoint 消息共享官方注入的固定前缀
// （host 的 `dsh-compaction-basic` 给每条 checkpoint 套的 preamble/
// `<compacted-summary>` 标签，逐字相同）时，若每条都只截前 80 字，
// 预览会完全一样、看不出该选哪个。这里先找出所有候选共享的最长前缀，
// 跳过它再截 80 字，让预览从真正分叉的内容开始。
function hitPreview(nodes: SurfaceNode[], hits: number[]): string {
  const texts = hits.map((i) => nodeText(nodes[i], true))
  const shared = hits.length > 1 ? commonPrefixLen(texts) : 0
  return hits.map((i, k) => nodeSummaryLine(nodes, i, shared, texts[k])).join('\n')
}

function commonPrefixLen(texts: string[]): number {
  if (texts.length < 2) return 0
  let len = texts[0].length
  for (let k = 1; k < texts.length && len > 0; k++) {
    const b = texts[k]
    let i = 0
    const max = Math.min(len, b.length)
    while (i < max && texts[0][i] === b[i]) i++
    len = i
  }
  return len
}

// 匹配失败提示复用的单行摘要：`pos <下标> | seq <序号> | <类型>: <前 80 字预览>`。
// skip>0 时表示与其它候选共享的前缀已被跳过，预览从分叉点开始（并标注跳过量）。
function nodeSummaryLine(nodes: SurfaceNode[], i: number, skip?: number, text?: string): string {
  const full = text ?? nodeText(nodes[i], true)
  const shown = skip ? full.slice(skip) : full
  const tag = skip ? ' (shared ' + skip + '-char prefix elided)' : ''
  return 'pos ' + i + ' | seq ' + nodes[i].seq + ' | ' + nodes[i].type + tag + ': ' + preview(shown, 80)
}

// 把归一化文本切成用于重叠度打分的 token：ASCII/数字按 3+ 字符的连续片段
// 切词（沿用原先"忽略过短词"的思路），CJK（中日韩）没有空格分词，逐字切开，
// 否则一整句连续中文会被当成一个词，重叠度算法对中文锚点基本失效。
const TOKEN_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7a3]|[A-Za-z0-9]{3,}/g
function tokenize(s: string): string[] {
  return s.match(TOKEN_RE) ?? []
}

// 按与锚点的词重叠度给节点排序，用于在匹配失败时提示该传什么内容。
// 廉价、确定、足以作为提示。
function anchorOverlap(nodeRaw: string, anchorNorm: string): number {
  const words = tokenize(anchorNorm)
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
    .map((_, i) => i)
    .filter((i) => isEligibleAnchorNode(nodes, i))
    .map((i) => ({ i: i, score: anchorOverlap(nodeText(nodes[i], true), anchorNorm) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .filter((s) => s.score > 0)
  if (!scored.length) return ''
  return scored.map((s) => nodeSummaryLine(nodes, s.i)).join('\n')
}

// 将单个锚点解析为唯一节点下标，解析失败时抛出带有可操作提示的错误。
export function resolveUniqueHit(nodes: SurfaceNode[], anchor: string, side: string): number {
  const hits = prefixHits(nodes, anchor)
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) {
    const hint = nearestHint(nodes, normText(anchor))
    throw new Error(side + ' not found on the surface: ' + preview(anchor, 120) + (hint ? '\nclosest nodes:\n' + hint : ''))
  }
  throw new Error(side + ' is AMBIGUOUS: ' + hits.length + ' nodes start with it. Lengthen the anchor to pick one:\n' + hitPreview(nodes, hits))
}

export function snapStartBalanced(nodes: SurfaceNode[], si: number): number {
  // tool/result 不能在没有其 assistant 消息的情况下作为区间开头：
  // 向前回退到最近的、发起这些调用的 assistant/message。
  while (si > 0 && nodes[si].type === 'tool/result') {
    let j = si - 1
    while (j > 0 && nodes[j].type !== 'assistant/message') j--
    if (nodes[j].type !== 'assistant/message') break
    si = j
  }
  return si
}

export function snapEndBalanced(nodes: SurfaceNode[], ei: number): number {
  // 只要后面还有 tool result，assistant/message 的边缘就保持开放；
  // 连续的 tool/result 节点属于同一对调用，因此要一直推进穿过它们，
  // 直到整对完全闭合。
  while (ei < nodes.length - 1 && nodes[ei + 1].type === 'tool/result') {
    ei++
  }
  return ei
}

export interface BoundaryResolveResult {
  si: number
  ei: number
  startSeq: number
  endSeq: number
  method: string
  detail: { startPos: number; endPos: number }
}

export function resolveBoundaries(nodes: SurfaceNode[], args: { startAnchor?: unknown; endAnchor?: unknown }): BoundaryResolveResult {
  if (!nodes.length) throw new Error('surface is empty; nothing to compact')
  const startAnchor = typeof args.startAnchor === 'string' && args.startAnchor.trim() ? args.startAnchor : ''
  const endAnchor = typeof args.endAnchor === 'string' && args.endAnchor.trim() ? args.endAnchor : ''
  // 结束侧是「必需」的，用来界定区间；起点默认取第一个节点。
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
    si,
    ei,
    startSeq: nodes[si].seq,
    endSeq: nodes[ei].seq,
    method: method.join(' + '),
    detail: { startPos: si, endPos: ei },
  }
}

export function spanText(nodes: SurfaceNode[], si: number, ei: number): string {
  const parts: string[] = []
  for (let i = si; i <= ei; i++) {
    const n = nodes[i]
    parts.push('--- seq ' + n.seq + ' | pos ' + i + ' | ' + n.type + nodeErrorTag(n) + ' ---\n' + nodeText(n))
  }
  return parts.join('\n\n')
}
