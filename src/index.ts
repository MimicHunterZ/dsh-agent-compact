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
import { resolveBoundaries, soleToolCall, spanText } from './boundary.js'
import type { AgentLike, OptimizedEngineLike, SessionLike, SurfaceNode } from './optimizer.js'

export const name = 'tool-context-compression'

export const inject = ['tools', 'systemPrompt']

export interface Config {
  autoArchive: boolean
  volumeNudgeTokens: number
}

export const Config: Schema<Config> = Schema.object({
  autoArchive: Schema.boolean().default(true).description('context_compact saves the full raw span to a spill artifact before replacing it.'),
  volumeNudgeTokens: Schema.number().default(50000).description('Every time accumulated tool-result output (heuristic token count) since the last compaction crosses another multiple of this amount, remind the model to consider context_compact. Set to 0 to disable.'),
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

  interface SessionEventLike {
    type?: string
    seq?: number
    data?: unknown
    sourceEventSeqs?: unknown
  }

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

  async function readSurfaceNodes(agent: AgentWithSession): Promise<SurfaceNode[] | null> {
    const sessionQuery = resolveService(agent, 'sessionQuery') as SessionQueryLike | undefined
    if (!sessionQuery) return null
    const snap = await sessionQuery.readSurface(agent.session.id)
    return snap && Array.isArray(snap.events) ? (snap.events as SurfaceNode[]) : []
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
      content,
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
      // 显式声明真实字段（而非开放的 additionalProperties:true 空对象），
      // 使 Code Mode 的 ToolOutputMap 能推导出这个工具的真实返回类型。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Always true on a successful call (a failure throws instead).' },
          archived: {
            required: true,
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  locator: { type: 'json', required: true, description: 'Opaque spill-store locator for the archived raw span.' },
                  retrievalHint: { type: 'json', required: true, description: 'Backend-specific hint for retrieving the archived span.' },
                },
              },
            ],
            description: 'Archive record when the raw span was saved, or null when it was not.',
          },
          archiveError: { type: 'string', description: 'Present only when autoArchive was requested but archiving failed; compaction still succeeded.' },
        },
      },
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

