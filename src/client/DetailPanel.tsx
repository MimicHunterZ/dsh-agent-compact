import * as React from 'react'
import { JsonTree } from './JsonTree.js'
import { rowKind, rowLabel } from './surface-utils.js'
import type { CtxSurfaceRow } from './types.js'

type Tab = 'summary' | 'content' | 'raw'

const TAB_LABEL: Record<Tab, string> = { summary: '总览', content: '内容', raw: '原始 JSON' }
const TABS: readonly Tab[] = ['summary', 'content', 'raw']

function BlockView(props: { readonly block: CtxSurfaceRow['blocks'][number] }): React.ReactElement | null {
  const { block } = props
  if (block.kind === 'text' || block.kind === 'reasoning') {
    if (!block.text) return null
    return React.createElement(React.Fragment, null,
      block.label ? React.createElement('div', { className: 'cxpBlockHeading' }, block.label) : null,
      React.createElement('p', { className: 'cxpBlockText' }, block.text),
    )
  }
  if (block.kind === 'tool-call') {
    return React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'cxpBlockHeading' }, 'tool-call' + (block.label ? ' · ' + block.label : '')),
      React.createElement('pre', { className: 'cxpBlockCode' }, block.text),
    )
  }
  if (block.kind === 'tool-result') {
    return React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'cxpBlockHeading' }, 'tool-result' + (block.label ? ' · ' + block.label : '')),
      React.createElement('pre', { className: 'cxpBlockCode' }, block.text || '(空)'),
    )
  }
  if (block.kind === 'image') {
    return React.createElement('div', { className: 'cxpBlockHeading' }, '[image]')
  }
  return block.text ? React.createElement('pre', { className: 'cxpBlockCode' }, block.text) : null
}

export function DetailPanel(props: {
  readonly row: CtxSurfaceRow | null
  readonly onClose: () => void
  readonly width: number
  readonly onResizeStart: (event: React.PointerEvent) => void
}): React.ReactElement | null {
  const { row, onClose, width, onResizeStart } = props
  const [tab, setTab] = React.useState<Tab>('content')
  if (row === null) return null
  return React.createElement('div', { className: 'cxpDetails', style: { width: width + 'px' } },
    React.createElement('button', { className: 'cxpDetailsResizeHandle', onPointerDown: onResizeStart, 'aria-hidden': true }),
    React.createElement('div', { className: 'cxpDetailsHeader' },
      React.createElement('div', { className: 'cxpDetailsTitle' },
        React.createElement('span', { className: 'cxpDetailsTitleSeq' }, 'seq ' + row.seq),
        React.createElement('span', { className: 'cxpKindTag', 'data-kind': rowKind(row), title: row.type }, rowLabel(row)),
        React.createElement('span', { className: 'cxpDetailsTitleKind' }, row.type),
      ),
      React.createElement('button', { className: 'cxpClose', onClick: onClose, 'aria-label': '关闭详情' }, '×'),
    ),
    React.createElement('div', { className: 'cxpDetailTabs', role: 'tablist' },
      TABS.map((t) => React.createElement('button', {
        key: t,
        role: 'tab',
        className: 'cxpDetailTab' + (tab === t ? ' cxpDetailTabActive' : ''),
        'aria-selected': tab === t,
        onClick: () => setTab(t),
      }, TAB_LABEL[t])),
    ),
    React.createElement('div', { className: 'cxpDetailBody' },
      tab === 'summary' ? React.createElement('dl', { className: 'cxpOverview' },
        React.createElement('div', null, React.createElement('dt', null, 'seq'), React.createElement('dd', null, String(row.seq))),
        React.createElement('div', null, React.createElement('dt', null, '类型'), React.createElement('dd', null, row.type)),
        React.createElement('div', null, React.createElement('dt', null, '字符数'), React.createElement('dd', null, String(row.chars))),
        React.createElement('div', null, React.createElement('dt', null, 'blocks'), React.createElement('dd', null, String(row.blocks.length))),
      ) : null,
      tab === 'content' ? (row.blocks.length > 0
        ? row.blocks.map((b, i) => React.createElement(BlockView, { key: i, block: b }))
        : React.createElement('p', { className: 'cxpBlockText' }, row.text || '(空)')) : null,
      tab === 'raw' ? React.createElement(JsonTree, { data: row as unknown as import('./JsonTree.js').JsonValue, initialDepth: 2 }) : null,
    ),
  )
}
