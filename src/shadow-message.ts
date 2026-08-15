import { createUserMessage } from '@deepseek-ai/dsh-llm'

const SHADOW_PLUGIN = 'tool-context-compression'

/** Create a valid, non-checkpoint user message for a surface shadow. */
export function createShadowUserMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: SHADOW_PLUGIN },
  })
}
