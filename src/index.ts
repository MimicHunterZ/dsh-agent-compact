// @mimichunterz/agent-compact: 上下文压缩工具（bundle 插件）。
// 注册模型可见的 context_compact 工具，并在首次使用时修补压缩引擎，
// 使其 summarize() 尊重 agent 自行编写的检查点（参见 ./optimizer.js）。

import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { createShadowUserMessage } from './shadow-message.js'
import { patchEngine } from './optimizer.js'
import { normText } from './normalize.js'
import { CtxSurfaceService } from './ctx-surface.js'
import type { AgentLike, OptimizedEngineLike, SessionLike, SurfaceNode } from './optimizer.js'

export const name = 'tool-context-compression'

export const inject = ['tools', 'systemPrompt']

export interface Config {
  autoArchive: boolean
  volumeNudgeTokens: number
}

export const Config: Schema<Config> = Schema.object({
  autoArchive: Schema.boolean().default(true).description('context_compact saves the full raw span to a spill artifact before replacing it.'),
  volumeNudgeTokens: Schema.number().default(20000).description('Every time accumulated tool-result output (heuristic token count) since the last compaction crosses another multiple of this amount, remind the model to consider context_compact. Set to 0 to disable.'),
})

export function apply(ctx: Context, config: Config) {
  // 注意：sessionQuery 与 agentPresets 必须在每次调用时解析——它们在 apply
  // 时可能尚未挂载，此时捕获会让 context_compact 工具失效。
  const tools = ctx.get('tools')
  if (!tools) throw new Error('@mimichunterz/agent-compact: tools service unavailable')

  // 为浏览器「上下文」面板注册 ctxSurface 服务（`ctxSurface/read`）。
  new CtxSurfaceService(ctx)

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

  // 使用类型别名（而非 interface），使其携带隐式索引签名，
  // 嵌入工具结果时仍可赋值给 JsonValue。
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

  interface SessionEventLike {
    type?: string
    seq?: number
    data?: unknown
    sourceEventSeqs?: unknown
  }

  // 恰好携带这一个 tool-call 的 assistant/message 节点（用于判断该调用所属的
  // 消息节点能否被 shadow，而不破坏同一条消息里的其他兄弟 tool-call）。
  function soleToolCall(n: SurfaceNode, callId: string): boolean {
    if (n.type !== 'assistant/message') return false
    const content = (n.data as { message?: { content?: unknown } } | undefined)?.message?.content
    if (!Array.isArray(content)) return false
    const calls = content.filter((b) => {
      const block = b as { type?: unknown; id?: unknown }
      return block !== null && typeof block === 'object' && block.type === 'tool-call'
    })
    return calls.length === 1 && (calls[0] as { id?: unknown }).id === callId
  }

  interface AnyBlock {
    type?: string
    text?: unknown
    name?: unknown
    arguments?: unknown
    isError?: unknown
    content?: unknown
  }

  // ---- volume-nudge：冷启动的主动压缩提醒 ----
  // 用会话占用量的增长量作为提醒信号：自上次压缩以来增长每跨过
  // config.volumeNudgeTokens 的一个整数倍，就提示模型考虑压缩。
  // 度量指标按优先级：
  //  1. sessionProjections 的 contextPressure.projectedTokens（provider 真实
  //     usage 的投影，每次 LLM 调用都会重新同步到真实值）；
  //  2. tokenMeter 的 surfaceTokens（chars/4 启发式），仅当 (1) 不可用时使用。
  // 两者均按会话增量累积，服务缺席时整个特性降级为 no-op。
  const volumeBaseline = new WeakMap<SessionLike, number>()

  interface TokenMeterLike {
    measure(session: SessionLike): { surfaceTokens?: number } | null | undefined
  }

  interface SessionProjectionsLike {
    snapshot(session: SessionLike): { values?: Record<string, unknown> } | null | undefined
  }

  function surfaceTokensOf(session: SessionLike): number | null {
    const meter = ctx.get('tokenMeter') as TokenMeterLike | undefined
    if (!meter || typeof meter.measure !== 'function') return null
    try {
      const m = meter.measure(session)
      const tokens = m && typeof m.surfaceTokens === 'number' ? m.surfaceTokens : null
      return tokens
    } catch (e) {
      return null
    }
  }

  function contextPressureProjectedTokensOf(session: SessionLike): number | null {
    const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
    if (!projections || typeof projections.snapshot !== 'function') return null
    try {
      const snap = projections.snapshot(session)
      const values = snap && snap.values
      const contextPressure = values ? (values as { contextPressure?: { projectedTokens?: unknown } }).contextPressure : undefined
      const projected = contextPressure && typeof contextPressure.projectedTokens === 'number' ? contextPressure.projectedTokens : null
      return projected
    } catch (e) {
      return null
    }
  }

  function occupancyTokensOf(session: SessionLike): number | null {
    const projected = contextPressureProjectedTokensOf(session)
    if (projected !== null) return projected
    return surfaceTokensOf(session)
  }

  function resolveService(agent: AgentLike, serviceName: string): unknown {
    const direct = ctx.get(serviceName)
    if (direct) return direct
    // agentPresets 按每次调用解析（apply 时注册表可能尚未挂载）。
    const agentPresets = ctx.get('agentPresets')
    const presets = agentPresets as { serviceFor?: (agent: { ctx: unknown }, name: string) => unknown } | undefined
    if (presets && typeof presets.serviceFor === 'function' && agent && agent.ctx) {
      try {
        const viaPreset = presets.serviceFor({ ctx: agent.ctx }, serviceName)
        if (viaPreset) return viaPreset
      } catch (e) {
        /* 忽略错误，继续向下 */
      }
    }
    return undefined
  }

  function agentOf(exec: { agent?: unknown }): AgentWithSession | null {
    const agent = exec.agent as AgentLike | undefined
    if (!agent || !agent.session) return null
    return agent as AgentWithSession
  }

  // ---- surface 文本提取 ----
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

  // skipReasoning：让锚点匹配文本与模型所见对齐（跳过 reasoning 与图片块）；
  // 归档（skipReasoning = false）保留完整原文。
  function blockText(b: unknown, depth: number, skipReasoning: boolean): string {
    if (depth > 5 || !b || typeof b !== 'object') return ''
    const blk = b as AnyBlock
    if (skipReasoning && blk.type === 'reasoning') return ''
    if (skipReasoning && blk.type === 'image') return ''
    if (typeof blk.text === 'string') return blk.text
    if (blk.type === 'tool-call') {
      return '[tool-call ' + String(blk.name ?? '') + '] ' + (typeof blk.arguments === 'string' ? blk.arguments : '')
    }
    if (blk.type === 'tool-result') {
      return '[tool-result' + (blk.isError ? ' error' : '') + '] ' + blocksText(blk.content, depth + 1, skipReasoning)
    }
    if (blk.type === 'image') return '[image]'
    if (Array.isArray(blk.content)) return blocksText(blk.content, depth + 1, skipReasoning)
    return ''
  }

  function blocksText(blocks: unknown, depth: number, skipReasoning: boolean): string {
    if (!Array.isArray(blocks)) return ''
    let out = ''
    for (const b of blocks) out += blockText(b, depth, skipReasoning) + '\n'
    return out
  }

  function nodeText(n: SurfaceNode, skipReasoning?: boolean): string {
    const blocks = nodeContent(n)
    if (!blocks) return ''
    return blocksText(blocks, 0, skipReasoning ?? false).replace(/\n+$/, '')
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

  // ---- 基于锚点的边界解析 ----
  // 锚点在「当前」surface 上按归一化文本匹配定位 seq，每次调用重新解析；
  // 匹配到的边缘会被吸附到平衡的 tool-call/result 边界上。

  // normText 来自 ./normalize.ts：折叠空白、将 CJK 全角标点映射为半角，
  // 同时应用于锚点与节点文本。

  // 宽容变体：去掉渲染器添加的 [tool-call <name>] / [tool-result] 标记。
  function strippedText(s: string): string {
    return normText(
      s
        .replace(/\[tool-call\s+[^\]]*\]\s*/g, '')
        .replace(/\[tool-result(?:\s+error)?\]\s*/g, ''),
    )
  }

  // 唯一前缀匹配：锚点必须是恰好一个消息节点的归一化前缀，避免静默替换错节点；
  // tool/result 节点不参与匹配，进行中轮次的 tool-call 节点也被排除。
  function prefixHits(nodes: SurfaceNode[], anchor: string): number[] {
    const a = normText(anchor)
    const hits: number[] = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.type !== 'user/message' && node.type !== 'assistant/message') continue
      if (i === nodes.length - 1 && /\[tool-call/.test(nodeText(node, true))) continue
      const n = normText(nodeText(node, true))
      const s = strippedText(nodeText(node, true))
      if (n.startsWith(a) || s.startsWith(a)) hits.push(i)
    }
    return hits
  }

  function hitPreview(nodes: SurfaceNode[], hits: number[]): string {
    return hits.map((i) => 'pos ' + i + ' | seq ' + nodes[i].seq + ' | ' + nodes[i].type + ': ' + preview(nodeText(nodes[i], true), 80)).join('\n')
  }

  // 将单个锚点解析为唯一节点下标，解析失败时抛出带有可操作提示的错误。
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

  function snapEndBalanced(nodes: SurfaceNode[], ei: number): number {
    // 只要后面还有 tool result，assistant/message 的边缘就保持开放；
    // 连续的 tool/result 节点属于同一对调用，因此要一直推进穿过它们，
    // 直到整对完全闭合。
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

  // 按与锚点的词重叠度给节点排序，用于在匹配失败时提示该传什么内容。
  // 廉价、确定、足以作为提示。
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
      .map((n, i) => ({ i: i, score: anchorOverlap(nodeText(n, true), anchorNorm) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .filter((s) => s.score > 0)
    if (!scored.length) return ''
    return scored.map((s) => 'pos ' + s.i + ' | seq ' + nodes[s.i].seq + ' | ' + nodes[s.i].type + ': ' + preview(nodeText(nodes[s.i], true), 80)).join('\n')
  }

  function resolveBoundaries(nodes: SurfaceNode[], args: { startAnchor?: unknown; endAnchor?: unknown }): BoundaryResolveResult {
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

  // 按会话顺序编号的归档：从会话 spill 目录已有的最大数字后缀推导下一个编号；
  // 无 `root` 字段的后端降级为内存计数器。
  const archiveCounters = new Map<string, number>()

  function spillRootOf(spillStore: SpillStoreLike): string | null {
    const s = spillStore as unknown as { root?: unknown } | null
    return s && typeof s.root === 'string' && s.root ? s.root : null
  }

  function sessionSpillDir(root: string, sessionId: string): string {
    return join(root, 'session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 12))
  }

  // 会话 spill 目录中已存在的最大数字后缀，不存在则为 0。
  async function maxArchiveNumber(root: string, sessionId: string): Promise<number> {
    try {
      const entries = await readdir(sessionSpillDir(root, sessionId))
      let max = 0
      for (const name of entries) {
        const m = /-(\d+)\.txt$/.exec(name)
        if (m) max = Math.max(max, Number(m[1]))
      }
      return max
    } catch (e) {
      return 0 // 目录缺失或不可读：回退到内存计数器
    }
  }

  async function archiveSpan(agent: AgentWithSession, spillStore: SpillStoreLike, nodes: SurfaceNode[], si: number, ei: number): Promise<SurfaceArchive | null> {
    if (!spillStore) return null
    const content = spanText(nodes, si, ei)
    const sid = agent.session.id
    const root = spillRootOf(spillStore)
    const scanned = root ? await maxArchiveNumber(root, sid) : 0
    const n = Math.max(scanned, archiveCounters.get(sid) ?? 0) + 1
    archiveCounters.set(sid, n)
    const ref = await spillStore.saveText({
      owner: { sessionId: sid },
      source: { toolName: 'context_compact', callId: null, label: 'auto-archive' },
      suggestedName: String(n).padStart(6, '0') + '.txt',
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

  // 从持久的 compaction/summary 事件中读取摘要用量。
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
      /* 忽略 */
    }
    return null
  }

  const disposers: (() => void)[] = []

  // `context_compact` 的主机级 system-prompt 指引（order 118，全局提示层）。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    disposers.push(systemPrompt.section({
      name: 'tool:context_compact',
      order: 118,
      text: 'Use the context_compact tool to proactively externalize conversation spans that have served their purpose, the way a smart human memory keeps what matters and lets go of the rest — routine memory hygiene, not a last resort. Compress only a span whose information a summary fully covers for the rest of the conversation; if verbatim detail may still be needed, leave it. The tool replaces only the span you select: compress in segments when important text sits inside a dead region, and compress large outputs (log queries, big file reads) as soon as they are read and digested. Evaluate whenever a span has been used up, not only at topic boundaries, and never compress the opening, the in-flight task, or the active instruction; preserve exact paths, commands, IDs, and the user\'s requirements in the checkpoint.',
    }))
  }

  // 会话发生压缩（含自动引擎）时重置增长基线。
  disposers.push(ctx.on('session/event', (session: SessionLike | undefined, event: SessionEventLike) => {
    try {
      if (!session || event.type !== 'compaction/summary') return
      const tokens = occupancyTokensOf(session)
      volumeBaseline.set(session, tokens ?? 0)
    } catch (e) {
      /* 忽略 */
    }
  }))

  // 通过 systemPrompt.context() 注入尾部实时提示：仅在增长跨过整数倍的那几步
  // 写入 KV 缓存（文本不变时是完全的 no-op），独立于自动引擎的压力阈值。
  if (systemPrompt) {
    disposers.push(systemPrompt.context({
      name: 'agent-compact:volume-nudge',
      order: 50,
      text: () => {
        try {
          const threshold = config.volumeNudgeTokens
          if (!(threshold > 0)) return ''
          const agentsService = ctx.get('agents')
          const current = agentsService && typeof (agentsService as { currentInitiator?: unknown }).currentInitiator === 'function'
            ? (agentsService as { currentInitiator: () => unknown }).currentInitiator()
            : undefined
          const agent = current as { session?: SessionLike } | undefined
          if (!agent || !agent.session) return ''
          const now = occupancyTokensOf(agent.session)
          if (now === null) return ''
          const baseline = volumeBaseline.get(agent.session) ?? 0
          const grown = now - baseline
          if (grown <= 0) return ''
          const bucket = Math.floor(grown / threshold)
          if (bucket <= 0) return ''
          const approxK = Math.round((bucket * threshold) / 1000)
          return '`context_compact` reminder: this session\'s surface has grown by roughly ' + approxK + 'k+ tokens since the last compaction (tool results AND your own reasoning/output both count). If the work that produced it has reached a conclusion, compact that span now with `context_compact` — do not wait to be asked.'
        } catch (e) {
          return ''
        }
      },
    }))
  }

  disposers.push(tools.register(defineTool({
    name: 'context_compact',
    description: 'Compress a past conversation span into one Markdown checkpoint you write; the raw span is archived to a spill artifact, the compaction recorded. Anchor matching: anchors match the opening text of a message body (user/assistant messages only; tool-call blocks, tool results, and other transcript structure excluded). Whitespace, tool-call markers, and full/half-width punctuation differences are ignored; each anchor must match exactly one user or assistant message. When to compact: ① Progress — compact each finished step at its topic boundary, keeping the active instruction and remaining steps live; ② Course correction — compact the failed span into a checkpoint recording what went wrong and the corrected direction, instead of carrying noise forward; ③ Rebaseline — stale opening requirements: compact the start too, restating current intent and what survives. Checkpoint: Markdown, terse bullets, ## sections; keep exact paths/commands/IDs and the user\'s requirements and direction. Per scene — Progress: Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Current Work / Next Step; Correction: what went wrong / root cause / fix / next; Rebaseline: current intent / surviving decisions / plan ahead. Constraints: one compaction per session at a time; checkpoint must be smaller than the compressed span; edges snap to balanced tool-call/result boundaries.',
    parameters: {
      startAnchor: { type: 'string', description: 'Verbatim opening of the span\'s first message. Required for a middle span; omitting starts at the conversation\'s first message, discarding opening requirements and direction — only for compressing all history up to endAnchor or rebaselining.' },
      endAnchor: { type: 'string', description: 'Verbatim opening of the span\'s last message; required. This node is replaced — pass its predecessor\'s opening to keep it.' },
      summary: { type: 'string', description: 'Required. The full Markdown checkpoint replacing the span, written by you from the conversation; never verbatim. Per-scene structure as in the description; must be smaller than the compressed content.' },
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
      // 把 agent 编写的检查点交给引擎；被修补的 summarizer 消费它（一次性）
      // 并完全跳过 LLM 调用。
      {
        const ext = ((engine as unknown as { _externalSummary?: Record<string, string> })._externalSummary ??= {})
        ext[agent.session.id] = args.summary
      }

      const spillStore = resolveService(agent, 'spillStore') as SpillStoreLike | undefined
      let archived: SurfaceArchive | null = null
      let archiveError: JsonValue | null = null
      if (config.autoArchive && spillStore) {
        try {
          archived = await archiveSpan(agent, spillStore, nodes, b.si, b.ei)
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
      // 成对清理：检查点是单独注入的，为避免检查点文本在 surface 出现两次，
      // 将该 tool-call 的 assistant/message 与其 tool/result 各 shadow 为一个
      // 占位符（仅当该消息恰好只含这一个 tool-call 时才安全）。
      const callId = (exec as { callId?: unknown }).callId
      if (typeof callId === 'string' && callId) {
        const holder = nodes.filter((n) => soleToolCall(n, callId)).pop()
        const assistantSeq = holder ? holder.seq : undefined
        if (assistantSeq !== undefined && assistantSeq > endSeq) {
          const sid = agent.session.id
          let done = false
          const off = ctx.on('session/event', (s: { id?: string } | undefined, ev: SessionEventLike) => {
            if (done) return
            if (!s || s.id !== sid) return
            if (ev.type !== 'tool/result') return
            const d = ev.data as { message?: { source?: { callId?: unknown } } } | null | undefined
            const src = d && d.message && d.message.source ? d.message.source.callId : undefined
            if (src !== callId) return
            done = true
            try {
              off()
            } catch (e) {
              /* 忽略 */
            }
            try {
              const session = agent.session as unknown as { append: (type: string, data: unknown, opts: unknown) => unknown }
              if (!session || typeof session.append !== 'function') return
              // 监听器在框架的 tool/result 发布流程内同步执行（appending 仍为
              // true），同步 append 会触发重入保护；延迟到微任务队列。
              const resultSeq = ev.seq
              const run = () => {
                try {
                  // 把归档定位符写进完成消息（承载它的 tool/result 随后被 shadow）。
                  const locText = archived && archived.locator ? String(archived.locator) : ''
                  const freedText = result.shadowedTokenCount !== undefined && result.shadowedTokenCount !== null
                    ? '; freed ~' + String(result.shadowedTokenCount) + ' tokens'
                    : ''
                  const doneText = '`context_compact` done: checkpoint above' + freedText + (locText
                    ? '; raw span archived at ' + locText + '.'
                    : '; raw span not archived.')
                  session.append('user/message', createShadowUserMessage(doneText), {
                    surfaceOp: { op: 'replace', start: assistantSeq, end: assistantSeq },
                    sourceEventSeqs: [assistantSeq],
                  })
                  // 复用该占位槽位作为自我触发的习惯提醒：每次成功调用都给
                  // 下一次留下提示，引导模型自主管理上下文。
                  session.append('user/message', createShadowUserMessage('`context_compact` result shadowed. Keep managing context this way on your own: once the next sub-task finishes, an error gets resolved, or a large tool result has been fully digested, compact that span before it goes stale — do not wait to be asked again.'), {
                    surfaceOp: { op: 'replace', start: resultSeq, end: resultSeq },
                    sourceEventSeqs: [resultSeq],
                  })
                  ctx.logger.info('[context_compact] %s paired cleanup: shadowed assistant/message %d + tool/result %d', sid, assistantSeq, resultSeq)
                } catch (e) {
                  ctx.logger.warn('[context_compact] %s paired cleanup failed: %s', sid, e && (e as Error).message ? (e as Error).message : String(e))
                }
              }
              if (typeof queueMicrotask === 'function') queueMicrotask(run)
              else setTimeout(run, 0)
            } catch (e) {
              ctx.logger.warn('[context_compact] %s paired cleanup setup failed: %s', sid, e && (e as Error).message ? (e as Error).message : String(e))
            }
          })
        }
      }
      // 调试指标只进日志，不进入模型可见的工具结果。
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
        /* 忽略 */
      }
    }
  }
}

