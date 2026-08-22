import test from 'node:test'
import assert from 'node:assert/strict'
import { normText } from '../lib/normalize.js'

test('CJK full-width punctuation maps to half-width', () => {
  // 全角逗号 U+FF0C 与半角 U+002C 的匹配
  assert.equal(normText('已经重启了，那别人'), '已经重启了,那别人')
  assert.equal(normText('为什么要这样？'), '为什么要这样?')
  assert.equal(normText('。！？；：'), '.!?;:')
  assert.equal(normText('、'), ',')
  assert.equal(normText('（【｛～…'), '([{~...')
  assert.equal(normText('“双引”和‘单引’'), '"双引"和\'单引\'')
})

test('whitespace collapses and trims (incl. full-width space U+3000)', () => {
  assert.equal(normText('  a   b\n c '), 'a b c')
  assert.equal(normText('　全角空格　'), '全角空格')
})

test('ordinary CJK and half-width text passes through unchanged', () => {
  assert.equal(normText('已经重启了,那别人在其它插件改这个 root 会崩吗'), '已经重启了,那别人在其它插件改这个 root 会崩吗')
  assert.equal(normText('[tool-call context_compact] {"a":1}'), '[tool-call context_compact] {"a":1}')
})

test('normalized prefix matching is stable for uniqueness', () => {
  // 仅标点宽度不同的消息匹配同一锚点——归一化绝不能静默二选一。
  const a = normText('看到了吗，我们现在')
  const b = normText('看到了吗,我们现在')
  assert.equal(a, b)
})
