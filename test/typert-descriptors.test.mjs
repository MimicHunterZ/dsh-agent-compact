import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { TYPERT } from '../lib/typert.host.js'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// DeepSeek Harness 0.2 的 TypertCodec（strict）把 `schema: TypertSchema` 换成了
// `create: () => TypertSchema`：Gateway 的解码路径是 `codec.create().parse(value)`。
// 描述符只是普通对象字面量，tsc 不会按 TypertCodec 校验，所以这里显式守卫。
function assertStrictCodec(codec, where) {
  assert.ok(codec, `${where}: missing codec`)
  assert.equal(codec.mode, 'strict', `${where}: expected a strict codec`)
  assert.equal(typeof codec.typeSymbol, 'string', `${where}: missing typeSymbol`)
  assert.equal(typeof codec.create, 'function', `${where}: strict codec must expose create()`)
  assert.equal(typeof codec.create().parse, 'function', `${where}: create() must return a schema with parse()`)
  assert.equal('schema' in codec, false, `${where}: 0.2 dropped the pre-built \`schema\` field`)
}

function assertDescriptors(contribution, face) {
  const list = face === 'host' ? contribution.invocations : contribution.descriptors
  assert.ok(Array.isArray(list) && list.length > 0, `${face}: expected at least one invocation`)
  for (const descriptor of list) {
    const at = `${face} ${descriptor.id}`
    for (const parameter of descriptor.parameters) assertStrictCodec(parameter.codec, `${at} parameter ${parameter.wire}`)
    assertStrictCodec(descriptor.result, `${at} result`)
    if (descriptor.invocation.kind === 'context') assertStrictCodec(descriptor.invocation.codec, `${at} context`)
  }
}

test('host typert face declares 0.2 `create` codecs', () => {
  assert.equal(TYPERT.face, 'host')
  assertDescriptors(TYPERT, 'host')
})

test('client typert face declares 0.2 `create` codecs', () => {
  assertDescriptors(TYPERT_REMOTE, 'remote')
})

test('built client bundle inlines 0.2 `create` codecs (build-client.mjs stays in sync)', () => {
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
  assert.match(bundle, /create:\s*\(\)\s*=>\s*_ctxSurface_read_request\$schema/)
  assert.match(bundle, /create:\s*\(\)\s*=>\s*_ctxSurface_read_result\$schema/)
  assert.doesNotMatch(bundle, /schema:\s*_ctxSurface_read_request\$schema/)
  assert.doesNotMatch(bundle, /schema:\s*_ctxSurface_read_result\$schema/)
})
