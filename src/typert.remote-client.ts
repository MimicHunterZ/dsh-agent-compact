// Client-side typert Remote descriptors for `ctxSurface/read` (Node-facing
// export only — the actual browser bundle in lib/client.js extracts this
// exact compiled text verbatim in scripts/build-client.mjs so the browser
// copy can never independently drift; see that script's header comment).
//
// Real TypeScript source compiled by `tsc`, type-checked against
// ctx-surface.ts the same way as typert.host.ts — see that file's header
// for why this matters.
import { z } from 'zod'
import type { CtxSurfaceBlock, CtxSurfaceReadRequest, CtxSurfaceReadResult, CtxSurfaceRow } from './ctx-surface.js'

type Equal<A, B> = A extends B ? (B extends A ? true : false) : false
function assertEqual<A, B>(_check: Equal<A, B>): void {}

const request$schema = z.object({
  sessionId: z.intersection(z.string(), z.unknown()).readonly(),
})
assertEqual<z.infer<typeof request$schema>, CtxSurfaceReadRequest>(true)

const block$schema = z.object({
  kind: z.union([z.literal('text'), z.literal('reasoning'), z.literal('tool-call'), z.literal('tool-result'), z.literal('image'), z.literal('block')]).readonly(),
  label: z.string().readonly().optional(),
  text: z.string().readonly(),
  chars: z.number().readonly(),
})
assertEqual<z.infer<typeof block$schema>, CtxSurfaceBlock>(true)

const row$schema = z.object({
  seq: z.number().readonly(),
  type: z.string().readonly(),
  text: z.string().readonly(),
  chars: z.number().readonly(),
  blocks: z.array(block$schema).readonly(),
})
assertEqual<z.infer<typeof row$schema>, CtxSurfaceRow>(true)

const result$schema = z.object({
  rows: z.array(row$schema).readonly(),
}).readonly()
assertEqual<z.infer<typeof result$schema>, CtxSurfaceReadResult>(true)

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
            schema: request$schema,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@mimichunterz/agent-compact/ctx-surface#CtxSurfaceReadResult',
        schema: result$schema,
      },
      sourceLocation: { file: 'src/ctx-surface.ts', line: 160, column: 3 },
    },
  ],
}

export default TYPERT_REMOTE
