import * as React from 'react'

type JsonPrimitive = string | number | boolean | null | undefined
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

function isExpandable(value: JsonValue): value is readonly JsonValue[] | { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null
}

function entriesOf(value: JsonValue): Array<[string, JsonValue]> {
  if (Array.isArray(value)) return value.map((v, i) => [String(i), v] as [string, JsonValue])
  if (value !== null && typeof value === 'object') return Object.entries(value)
  return []
}

function previewOf(value: JsonValue): string {
  if (Array.isArray(value)) return '[' + value.length + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).length + '}'
  return ''
}

function primitiveText(value: JsonValue): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

/**
 * 小巧、零依赖的可折叠 JSON 树。刻意比功能完整的树查看器更精简（没有复制菜单、
 * 没有键盘焦点漫游 tabindex）——本面板只需要一个可读的、点击展开的结构视图。
 */
export function JsonTree(props: { readonly data: JsonValue; readonly initialDepth?: number }): React.ReactElement {
  return React.createElement('div', { className: 'cxpJsonHost', role: 'tree' }, React.createElement(JsonNode, {
    field: null,
    value: props.data,
    depth: 0,
    initialDepth: props.initialDepth ?? 1,
  }))
}

function JsonNode(props: { readonly field: string | null; readonly value: JsonValue; readonly depth: number; readonly initialDepth: number }): React.ReactElement {
  const { field, value, depth, initialDepth } = props
  const [expanded, setExpanded] = React.useState(depth < initialDepth)
  const expandable = isExpandable(value)
  const entries = expandable ? entriesOf(value) : []
  const label = field !== null ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, field + ': ') : null
  if (!expandable) {
    return React.createElement('div', { role: 'treeitem' }, label, React.createElement('span', null, primitiveText(value)))
  }
  return React.createElement('div', { role: 'treeitem', 'aria-expanded': expanded },
    React.createElement('span', {
      'data-json-expander': true,
      onClick: () => setExpanded((e) => !e),
    }, expanded ? '▾' : '▸'),
    label,
    React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, previewOf(value)),
    expanded && entries.length > 0
      ? React.createElement('ul', null, entries.map(([key, item]) => React.createElement('li', { key }, React.createElement(JsonNode, {
          field: Array.isArray(value) ? '[' + key + ']' : key,
          value: item,
          depth: depth + 1,
          initialDepth,
        }))))
      : null,
  )
}
