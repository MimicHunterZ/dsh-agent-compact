// Host-side typert Remote descriptor for `ctxSurface/read`.
//
// This is real TypeScript source compiled by `tsc` (see tsconfig.json) into
// `lib/typert.host.js` — it is NOT a codegen output. There is no tool in
// this package that derives a zod schema from a TypeScript type, so the
// schema below is still hand-written; what changed is that it is now
// type-checked AGAINST the real interfaces from ctx-surface.ts via
// `AssertEqual` below. If this schema ever drifts from CtxSurfaceReadResult
// or CtxSurfaceReadRequest again, `tsc` fails the build instead of the
// mismatch only surfacing later as a live "business result failed boundary
// validation" RPC error (see ctx-surface.ts's history comment for the
// incident this is guarding against).
import { z } from 'zod'
import type { CtxSurfaceBlock, CtxSurfaceReadRequest, CtxSurfaceReadResult, CtxSurfaceRow } from './ctx-surface.js'

// Strict type-level equality check (distributive-safe). `Equal<A, B>` is
// `true` only when A and B are exactly the same type in both directions.
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
      sourceLocation: { file: 'src/ctx-surface.ts', line: 160, column: 3 },
    },
  ],
  model: {
    services: [
      {
        description: 'Live folded surface reader for the browser context panel; reads the model-visible session history (shadowed events removed, seq-stamped) and never mutates the session.',
        summary: 'Live folded surface reader.',
        tags: [],
        jsDoc: '/**\n * Live-surface reader for the browser panel. Pure consumer: reads the folded\n * surface snapshot and never mutates the session.\n */',
        key: 'ctxSurface',
        exportName: 'CtxSurfaceService',
        members: [
          {
            kind: 'method',
            name: 'read',
            signature: "@Remote('read') async read(request: CtxSurfaceReadRequest): Promise<CtxSurfaceReadResult>",
            summary: 'Read the current folded surface rows of one session.',
            jsDoc: '/**\n * Read the current folded surface rows of one session (shadowed events\n * removed, model history order, seq-stamped).\n * @param request - session to inspect.\n * @returns folded rows or an explicit failure.\n */',
          },
        ],
        types: [
          {
            name: 'CtxSurfaceBlock',
            declaration: "export interface CtxSurfaceBlock {\n    readonly kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'image' | 'block';\n    readonly label?: string;\n    readonly text: string;\n    readonly chars: number;\n}",
          },
          {
            name: 'CtxSurfaceRow',
            declaration: "export interface CtxSurfaceRow {\n    readonly seq: number;\n    readonly type: string;\n    readonly text: string;\n    readonly chars: number;\n    readonly blocks: readonly CtxSurfaceBlock[];\n}",
          },
          {
            name: 'CtxSurfaceReadRequest',
            declaration: "export interface CtxSurfaceReadRequest {\n    readonly sessionId: string;\n}",
          },
          {
            name: 'CtxSurfaceReadResult',
            declaration: "export interface CtxSurfaceReadResult {\n    readonly rows: readonly CtxSurfaceRow[];\n}",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
}
