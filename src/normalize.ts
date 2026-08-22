// context_compact 的锚点匹配文本归一化。
// 匹配采用「唯一前缀」：锚点必须是恰好一个消息节点的归一化前缀。归一化折叠
// 空白并把 CJK 全角标点映射为半角，同时应用于锚点与节点文本，因此不匹配只
// 可能来自措辞差异，绝不会来自标点宽度。

const PUNCT_NORM: Record<string, string> = {
  '\u3002': '.', // 。
  '\uFF0C': ',', // ，
  '\u3001': ',', // 、
  '\uFF01': '!', // ！
  '\uFF1F': '?', // ？
  '\uFF1B': ';', // ；
  '\uFF1A': ':', // ：
  '\u201C': '"', // “
  '\u201D': '"', // ”
  '\u2018': "'", // ‘
  '\u2019': "'", // ’
  '\uFF08': '(', // （
  '\uFF09': ')', // ）
  '\u3010': '[', // 【
  '\u3011': ']', // 】
  '\uFF3B': '[', // ［
  '\uFF3D': ']', // ］
  '\uFF5B': '{', // ｛
  '\uFF5D': '}', // ｝
  '\uFF5E': '~', // ～
  '\u2026': '...', // …
}

/** 折叠空白，并将 CJK 全角标点映射为半角。 */
export function normText(s: string): string {
  let out = ''
  for (const c of s) out += PUNCT_NORM[c] ?? c
  return out.replace(/\s+/g, ' ').trim()
}
