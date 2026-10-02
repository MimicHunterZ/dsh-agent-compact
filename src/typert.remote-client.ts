// `ctxSurface/read` 的客户端 typert Remote 描述符。
// schema 复用 ./ctx-surface.ts；浏览器 bundle 由 scripts/build-client.mjs 从
// 编译产物中提取（见该脚本），本文件仅面向 Node 侧消费。
import { request$schema, result$schema } from './ctx-surface.js'

export const TYPERT_REMOTE = {
  package: '@mimichunterz/agent-compact',
  descriptors: [
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
            // 0.2 的 TypertCodec（strict）由 `schema` 值改为 `create()` 惰性取 schema。
            create: () => request$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@mimichunterz/agent-compact/ctx-surface#CtxSurfaceReadResult',
        create: () => result$schema,
      },
      sourceLocation: { file: 'src/ctx-surface.ts', line: 181, column: 3 },
    },
  ],
}

export default TYPERT_REMOTE
