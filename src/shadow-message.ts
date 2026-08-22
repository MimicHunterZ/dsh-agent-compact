import { createUserMessage } from '@deepseek-ai/dsh-llm'

const SHADOW_PLUGIN = 'tool-context-compression'

/** 为 surface shadow 创建一个合法、非检查点的用户消息。 */
export function createShadowUserMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: SHADOW_PLUGIN },
  })
}
