import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveBoundaries,
  snapStartBalanced,
  snapEndBalanced,
  soleToolCall,
  spanText,
} from '../lib/boundary.js'

// ---- 合成 surface 节点：形状对齐真实 session surface 事件（见 src/boundary.ts
// 依赖的 nodeContent/blockText 契约），不需要真的会话/服务即可单测。 ----

function userNode(seq, text, source) {
  // user/message 事件的 content 直接挂在 data 顶层（对齐 dsh-llm 的
  // createUserMessage 返回形状），不像 assistant/message、tool/result 那样
  // 嵌一层 `.message`——nodeContent() 按事件类型分两条路径读取，这里必须对齐。
  return {
    seq,
    type: 'user/message',
    data: { content: [{ type: 'text', text }], ...(source ? { source: { kind: source } } : {}) },
  }
}

function assistantTextNode(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

function assistantToolCallNode(seq, callId, name, args) {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', id: callId, name, arguments: args }] } },
  }
}

function assistantMultiToolCallNode(seq, ids) {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: ids.map((id) => ({ type: 'tool-call', id, name: 'x', arguments: '{}' })) } },
  }
}

function toolResultNode(seq, text, isError) {
  return {
    seq,
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', isError: !!isError, content: [{ type: 'text', text }] }] } },
  }
}

test('resolveBoundaries: resolves start/end anchors to the matching node seqs', () => {
  const nodes = [
    userNode(1, 'do step one please'),
    assistantTextNode(2, 'working on step one now'),
    userNode(3, 'now do step two'),
    assistantTextNode(4, 'working on step two now'),
  ]
  const b = resolveBoundaries(nodes, { startAnchor: 'do step one', endAnchor: 'working on step one' })
  assert.equal(b.startSeq, 1)
  assert.equal(b.endSeq, 2)
  assert.equal(b.method, 'start=anchor + end=anchor')
})

test('resolveBoundaries: omitted startAnchor defaults to the first node', () => {
  const nodes = [userNode(1, 'hello there'), assistantTextNode(2, 'hi back')]
  const b = resolveBoundaries(nodes, { endAnchor: 'hi back' })
  assert.equal(b.startSeq, 1)
  assert.equal(b.endSeq, 2)
  assert.match(b.method, /start=first/)
})

test('resolveBoundaries: missing endAnchor throws an actionable error', () => {
  const nodes = [userNode(1, 'hello')]
  assert.throws(() => resolveBoundaries(nodes, {}), /provide endAnchor/)
})

test('resolveBoundaries: ambiguous anchor lists every matching hit', () => {
  const nodes = [userNode(1, 'do the thing'), userNode(2, 'do the thing again')]
  assert.throws(() => resolveBoundaries(nodes, { endAnchor: 'do the thing' }), /AMBIGUOUS: 2 nodes/)
})

test('resolveBoundaries: unmatched anchor reports the closest nodes as a hint', () => {
  const nodes = [userNode(1, 'please fix the login bug')]
  assert.throws(() => resolveBoundaries(nodes, { endAnchor: 'totally unrelated text' }), /not found on the surface/)
})

test('resolveBoundaries: resolved start after resolved end is rejected', () => {
  const nodes = [userNode(1, 'first message'), userNode(2, 'second message')]
  assert.throws(
    () => resolveBoundaries(nodes, { startAnchor: 'second message', endAnchor: 'first message' }),
    /start sits after resolved end/,
  )
})

test('resolveBoundaries: end anchor on a tool-calling turn snaps forward through its tool/result', () => {
  const nodes = [
    userNode(1, 'run the tests'),
    assistantToolCallNode(2, 'call-1', 'run_tests', '{}'),
    toolResultNode(3, 'all green'),
    userNode(4, 'great, ship it'),
  ]
  const b = resolveBoundaries(nodes, { endAnchor: '[tool-call run_tests]' })
  // 终点吸附穿过了紧随其后的 tool/result（seq 3），而不是停在发起调用的
  // assistant/message（seq 2）——否则区间会留下一个没有其调用者的孤立结果。
  assert.equal(b.endSeq, 3)
  assert.match(b.method, /end-snapped/)
})

test('resolveBoundaries: CJK full/half-width punctuation does not create false ambiguity', () => {
  const nodes = [
    userNode(1, '已经重启了，那别人在其它插件改这个 root 会崩吗'),
    assistantTextNode(2, '不会崩，各插件的补丁是独立应用的'),
  ]
  // 锚点用半角逗号，节点原文用全角逗号：normText 统一映射后仍应唯一匹配。
  const b = resolveBoundaries(nodes, { startAnchor: '已经重启了,那别人', endAnchor: '不会崩' })
  assert.equal(b.startSeq, 1)
  assert.equal(b.endSeq, 2)
})

test('snapStartBalanced: a tool/result start snaps back to the assistant/message that issued it', () => {
  const nodes = [
    userNode(1, 'run it'),
    assistantToolCallNode(2, 'call-1', 'run', '{}'),
    toolResultNode(3, 'ok'),
  ]
  assert.equal(snapStartBalanced(nodes, 2), 1)
})

test('snapStartBalanced: a message-type start is left untouched', () => {
  const nodes = [userNode(1, 'hi'), assistantTextNode(2, 'hello')]
  assert.equal(snapStartBalanced(nodes, 1), 1)
})

test('snapEndBalanced: extends through every trailing tool/result of the same call', () => {
  const nodes = [
    assistantToolCallNode(1, 'call-1', 'run', '{}'),
    toolResultNode(2, 'partial'),
    toolResultNode(3, 'final'),
    userNode(4, 'thanks'),
  ]
  assert.equal(snapEndBalanced(nodes, 0), 2)
})

test('soleToolCall: true only for an assistant/message carrying exactly this one tool-call', () => {
  const solo = assistantToolCallNode(1, 'call-1', 'run', '{}')
  assert.equal(soleToolCall(solo, 'call-1'), true)
  assert.equal(soleToolCall(solo, 'call-2'), false)

  const multi = assistantMultiToolCallNode(2, ['call-a', 'call-b'])
  assert.equal(soleToolCall(multi, 'call-a'), false)

  const notAssistant = userNode(3, 'hi')
  assert.equal(soleToolCall(notAssistant, 'call-1'), false)
})

test('spanText: renders every node with its seq/pos/type header and keeps full text', () => {
  const nodes = [userNode(5, 'step done'), assistantTextNode(6, 'acknowledged')]
  const text = spanText(nodes, 0, 1)
  assert.match(text, /--- seq 5 \| pos 0 \| user\/message ---\nstep done/)
  assert.match(text, /--- seq 6 \| pos 1 \| assistant\/message ---\nacknowledged/)
})
