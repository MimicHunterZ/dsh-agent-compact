// `ctxSurface/read` 的主机侧 typert Remote 描述符。
// schema 与类型都以 ./ctx-surface.ts 的 zod schema 为唯一源头，这里直接复用。
import { request$schema, result$schema } from './ctx-surface.js'

export const TYPERT = {
  package: '@mimichunterz/agent-compact',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@mimichunterz/agent-compact#ctxSurface/read',
      service: 'ctxSurface',
      namespace: 'ctxSurface',
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@mimichunterz/agent-compact/ctx-surface#CtxSurfaceReadRequest',
            schema: request$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@mimichunterz/agent-compact/ctx-surface#CtxSurfaceReadResult',
        schema: result$schema,
      },
      sourceLocation: { file: 'src/ctx-surface.ts', line: 225, column: 3 },
    },
  ],
  model: {
    services: [
      {
        description: 'Live folded surface reader for the browser context panel; reads the model-visible session history (shadowed events removed, seq-stamped) and never mutates the session.',
        summary: 'Live folded surface reader.',
        tags: [],
        jsDoc: '/**\n * 面向浏览器面板的实时 surface 读取器。纯消费者：读取折叠后的 surface 快照，\n * 绝不修改会话。\n */',
        key: 'ctxSurface',
        exportName: 'CtxSurfaceService',
        members: [
          {
            kind: 'method',
            name: 'read',
            signature: "@Remote('read') async read(request: CtxSurfaceReadRequest): Promise<CtxSurfaceReadResult>",
            summary: 'Read the current folded surface rows of one session.',
            jsDoc: '/**\n * 读取某个会话当前的折叠 surface 行（已移除 shadowed 事件，按模型历史顺序，\n * 带 seq 标记）。\n * @param request - 要检查的会话。\n * @returns 折叠后的行，或显式失败。\n */',
          },
        ],
        types: [
          {
            name: 'CtxSurfaceBlock',
            declaration: "type CtxSurfaceBlock = z.infer<typeof block$schema>; // { kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'image' | 'block'; label?: string; text: string; chars: number }",
          },
          {
            name: 'CtxSurfaceRow',
            declaration: "type CtxSurfaceRow = z.infer<typeof row$schema>; // { seq: number; type: string; text: string; chars: number; blocks: readonly CtxSurfaceBlock[]; source?: string }",
          },
          {
            name: 'CtxSurfaceReadRequest',
            declaration: "type CtxSurfaceReadRequest = z.infer<typeof request$schema>; // { sessionId: string }",
          },
          {
            name: 'CtxSurfaceReadResult',
            declaration: "type CtxSurfaceReadResult = z.infer<typeof result$schema>; // { rows: readonly CtxSurfaceRow[] }",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
}
