// Anchor-matching text normalization for context_compact.
//
// Matching is UNIQUE-PREFIX: an anchor must be a normalized prefix of exactly
// one message node. Normalization collapses whitespace and maps CJK full-width
// punctuation to its half-width form (，→, 、→, 。→. ！→! ？→? ；→; ：→:
// “”/‘’→quotes （）→() 【】→[] ｛｝→{} ～→~ …→...), so an anchor does not depend
// on the byte width of the punctuation the user typed — the full-width comma in
// real message text must not force the model to reproduce U+FF0C exactly.
//
// The mapping is applied to BOTH the anchor and the node text, so a mismatch
// can only come from a real difference in wording, never from punctuation
// width. Normalization never disambiguates: if two nodes end up sharing the
// same normalized prefix, the caller still gets an AMBIGUOUS error instead of a
// silent pick, and zero hits still error with closest-node hints.

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

/** Collapse whitespace and map CJK full-width punctuation to half-width. */
export function normText(s: string): string {
  let out = ''
  for (const c of s) out += PUNCT_NORM[c] ?? c
  return out.replace(/\s+/g, ' ').trim()
}
