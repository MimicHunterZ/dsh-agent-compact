import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * 本插件注入的合成用户消息所用的来源标记。
 *
 * DeepSeek Harness 0.2 起 `MessageSourceMap` 取消了通用的 `plugin` 类型：
 * 每个生产者改为「在自己的模块里声明自己的 kind」（见 dsh-compaction 的
 * `compact-checkpoint`）。消费者对未知 kind 一律按未知处理，因此这里声明
 * 一个插件私有的 kind，既不冒充真实用户轮次，也不会被误认成压缩检查点。
 */
export const SHADOW_SOURCE_KIND = 'agent-compact'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-compact': { kind: 'agent-compact' }
  }
}

/** 为 surface shadow 创建一个合法、非检查点的用户消息。 */
export function createShadowUserMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SHADOW_SOURCE_KIND },
  })
}
