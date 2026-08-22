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

test('resolveBoundaries: ambiguous checkpoint-style hits get shared-prefix-elided previews', () => {
  // host 的 dsh-compaction-basic 给每条 checkpoint 套的固定 preamble/
  // <compacted-summary> 标签逐字相同、远超 80 字；两条 checkpoint 撞上同一个
  // 短锚点时，若预览还是从头截 80 字，两条会长得一模一样，没法据此选。
  const preamble =
    'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ' +
    'Treat the captured context as established background and build on it without restating it. Continue the task ' +
    'directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>'
  const nodes = [
    userNode(1, preamble + '## Dependency upgrade task (done)\nsome details'),
    userNode(2, preamble + '## Nit cleanup task (done)\nother details'),
  ]
  let message = ''
  try {
    resolveBoundaries(nodes, { endAnchor: preamble })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /AMBIGUOUS: 2 nodes/)
  assert.match(message, /shared \d+-char prefix elided/)
  const lines = message.split('\n').filter((l) => l.startsWith('pos '))
  assert.equal(lines.length, 2)
  assert.notEqual(lines[0], lines[1])
  assert.match(lines[0], /Dependency upgrade/)
  assert.match(lines[1], /Nit cleanup/)
})

test('resolveBoundaries: unmatched-anchor hint never recommends a tool/result or in-progress tool-call node', () => {
  const nodes = [
    userNode(1, 'please fix the login bug'),
    // 这条 assistant/message 里嵌了一个失败的 context_compact 调用，参数里
    // 逐字回带了锚点文本本身——旧的 nearestHint 不区分节点类型，词重叠算法
    // 会把它当成"最接近"的候选推荐回来，纯属自我循环、毫无信息量。
    assistantToolCallNode(2, 'call-1', 'context_compact', '{"endAnchor":"please fix the login zzz"}'),
    toolResultNode(3, 'please fix the login zzz result text'),
  ]
  let message = ''
  try {
    resolveBoundaries(nodes, { endAnchor: 'please fix the login zzz' })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /not found on the surface/)
  assert.doesNotMatch(message, /tool\/result/)
})

test('resolveBoundaries: CJK anchor-overlap hint tokenizes by character, not by whole sentence', () => {
  const nodes = [
    userNode(1, '把插件依赖升级到最新版本并跑一遍测试'),
    userNode(2, '完全不相关的另一段话'),
  ]
  // 锚点与 seq 1 共享前 12 个字，但结尾不同，不会作为前缀命中；旧的按空格
  // 分词在没有空格的中文里会把整句当成一个词，几乎必然算出 0 重叠、给不出
  // 任何提示。逐字切词后应该能算出 seq 1 明显更接近，把它列进提示里。
  let message = ''
  try {
    resolveBoundaries(nodes, { endAnchor: '把插件依赖升级到最新版本，然后提交' })
  } catch (err) {
    message = err.message
  }
  assert.match(message, /not found on the surface/)
  assert.match(message, /pos 0 \| seq 1/)
})

test('spanText: renders every node with its seq/pos/type header and keeps full text', () => {
  const nodes = [userNode(5, 'step done'), assistantTextNode(6, 'acknowledged')]
  const text = spanText(nodes, 0, 1)
  assert.match(text, /--- seq 5 \| pos 0 \| user\/message ---\nstep done/)
  assert.match(text, /--- seq 6 \| pos 1 \| assistant\/message ---\nacknowledged/)
})
