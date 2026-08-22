import * as React from 'react'
import { DetailPanel } from './DetailPanel.js'
import { compressPrompt, isToolRow, isTurnStart, laneOf, rowKind, rowLabel, rowPreview } from './surface-utils.js'
import type { CtxSurfaceRow, CtxSurfaceViewProps } from './types.js'

const EMPTY_ROWS: readonly CtxSurfaceRow[] = []
const DEFAULT_DETAILS_WIDTH = 380
const MIN_DETAILS_WIDTH = 320

// Turns/Calls 折叠后的表格行：真实行或折叠汇总行。
type DisplayItem =
  | { readonly kind: 'row'; readonly globalIdx: number; readonly row: CtxSurfaceRow }
  | { readonly kind: 'summary'; readonly key: string; readonly count: number }

export function CtxSurfaceView(props: CtxSurfaceViewProps): React.ReactElement {
  const { sessionId, readSurface, inputActions } = props
  const [rows, setRows] = React.useState<readonly CtxSurfaceRow[]>(EMPTY_ROWS)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [startIdx, setStartIdx] = React.useState<number | null>(null)
  const [endIdx, setEndIdx] = React.useState<number | null>(null)
  const [detailIdx, setDetailIdx] = React.useState<number | null>(null)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [refreshTick, setRefreshTick] = React.useState(0)
  const [detailsWidth, setDetailsWidth] = React.useState(DEFAULT_DETAILS_WIDTH)
  const resizeStartRef = React.useRef<{ startX: number; startWidth: number } | null>(null)

  const rowElRefs = React.useRef<Map<string, HTMLTableRowElement>>(new Map())

  // 视图栏状态：Duration/Turns/Calls 等价行；actualWidth 按 chars 比例分配宽度。
  const [actualWidth, setActualWidth] = React.useState(false)
  const [turnsCollapsed, setTurnsCollapsed] = React.useState(false)
  const [callsCollapsed, setCallsCollapsed] = React.useState(false)
  const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(new Set())

  const load = React.useCallback(() => {
    if (!sessionId || !readSurface) {
      setRows(EMPTY_ROWS)
      setLoading(false)
      setError(!readSurface ? 'readSurface prop 未传入' : 'sessionId prop 未传入')
      return
    }
    setLoading(true)
    readSurface({ sessionId }).then((result) => {
      if (result && result.ok === true) {
        setRows(result.value.rows || EMPTY_ROWS)
        setError(null)
      } else {
        setRows(EMPTY_ROWS)
        setError((result && result.error && result.error.message) || '读取 surface 失败')
      }
    }).catch((err: unknown) => {
      setRows(EMPTY_ROWS)
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setLoading(false))
  }, [sessionId, readSurface])

  React.useEffect(() => { load() }, [load, refreshTick])

  const handleSelect = React.useCallback((idx: number) => {
    setDetailIdx(idx)
    const row = rows[idx]
    if (row && isToolRow(row)) return
    if (startIdx === null) { setStartIdx(idx); setEndIdx(null); return }
    if (idx === startIdx) { setStartIdx(null); setEndIdx(null); return }
    setEndIdx(idx)
  }, [rows, startIdx])

  const handleCompress = React.useCallback(() => {
    if (startIdx === null || endIdx === null || !inputActions || !inputActions.setDraft) return
    const lo = Math.min(startIdx, endIdx)
    const hi = Math.max(startIdx, endIdx)
    inputActions.setDraft(compressPrompt(rows, lo, hi))
    setStartIdx(null); setEndIdx(null)
  }, [startIdx, endIdx, rows, inputActions])

  const clearSelection = React.useCallback(() => { setStartIdx(null); setEndIdx(null) }, [])

  const toggleTurns = React.useCallback(() => {
    setTurnsCollapsed((v) => !v)
    setExpandedKeys(new Set())
  }, [])

  const toggleCalls = React.useCallback(() => {
    setCallsCollapsed((v) => !v)
    setExpandedKeys(new Set())
  }, [])

  const expandGroup = React.useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }, [])

  const filtered = React.useMemo(() => {
    if (!searchQuery.trim()) return rows
    const q = searchQuery.toLowerCase()
    return rows.filter((r) => r.text.toLowerCase().includes(q) || String(r.seq).includes(q))
  }, [rows, searchQuery])

  const totalChars = React.useMemo(() => rows.reduce((a, r) => a + r.chars, 0), [rows])
  const span = startIdx !== null && endIdx !== null ? { lo: Math.min(startIdx, endIdx), hi: Math.max(startIdx, endIdx) } : null

  const tlWidths = React.useMemo(() => {
    const n = filtered.length
    if (n === 0) return []
    if (!actualWidth) return filtered.map(() => 100 / n)
    const total = filtered.reduce((a, r) => a + Math.max(1, r.chars), 0)
    return filtered.map((r) => Math.max(1, (r.chars * 100) / total))
  }, [filtered, actualWidth])

  let tlLeft = 0
  const tlSpans = filtered.map((row, i) => {
    const globalIdx = rows.indexOf(row)
    const width = tlWidths[i]
    const selected = span !== null && globalIdx >= span.lo && globalIdx <= span.hi
    const item = { globalIdx, row, left: tlLeft, width, selected }
    tlLeft += width
    return item
  })

  // 轮次边界刻度：在每个轮次左缘画一条竖线。
  const turnBoundaries = tlSpans.filter((s, i) => i > 0 && isTurnStart(s.row)).map((s) => s.left)

  // domKeyOf：把每行的 globalIdx 映射到当前代表它的 <tr> 的 ref key，供滚动同步使用。
  const { displayItems, domKeyOf } = React.useMemo<{ displayItems: DisplayItem[]; domKeyOf: Map<number, string> }>(() => {
    const items: DisplayItem[] = []
    const domKeyOf = new Map<number, string>()
    let i = 0
    while (i < filtered.length) {
      const row = filtered[i]
      const globalIdx = rows.indexOf(row)
      if (turnsCollapsed && isTurnStart(row)) {
        items.push({ kind: 'row', globalIdx, row })
        domKeyOf.set(globalIdx, 'row-' + globalIdx)
        i += 1
        const key = 'turn-' + globalIdx
        const runStart = i
        let count = 0
        while (i < filtered.length && !isTurnStart(filtered[i])) { i += 1; count += 1 }
        if (count > 0) {
          if (expandedKeys.has(key)) {
            for (let j = runStart; j < runStart + count; j += 1) {
              const r = filtered[j]
              const gIdx = rows.indexOf(r)
              items.push({ kind: 'row', globalIdx: gIdx, row: r })
              domKeyOf.set(gIdx, 'row-' + gIdx)
            }
          } else {
            items.push({ kind: 'summary', key, count })
            for (let j = runStart; j < runStart + count; j += 1) domKeyOf.set(rows.indexOf(filtered[j]), key)
          }
        }
        continue
      }
      if (!turnsCollapsed && callsCollapsed && isToolRow(row)) {
        const key = 'calls-' + globalIdx
        const runStart = i
        let count = 0
        while (i < filtered.length && isToolRow(filtered[i])) { i += 1; count += 1 }
        if (expandedKeys.has(key)) {
          for (let j = runStart; j < runStart + count; j += 1) {
            const r = filtered[j]
            const gIdx = rows.indexOf(r)
            items.push({ kind: 'row', globalIdx: gIdx, row: r })
            domKeyOf.set(gIdx, 'row-' + gIdx)
          }
        } else {
          items.push({ kind: 'summary', key, count })
          for (let j = runStart; j < runStart + count; j += 1) domKeyOf.set(rows.indexOf(filtered[j]), key)
        }
        continue
      }
      items.push({ kind: 'row', globalIdx, row })
      domKeyOf.set(globalIdx, 'row-' + globalIdx)
      i += 1
    }
    return { displayItems: items, domKeyOf }
  }, [filtered, rows, turnsCollapsed, callsCollapsed, expandedKeys])

  // 滚动台账的滚动容器到当前 detailIdx 对应的 <tr>（平滑、居中）。
  React.useEffect(() => {
    if (detailIdx === null) return
    const key = domKeyOf.get(detailIdx)
    if (!key) return
    const el = rowElRefs.current.get(key)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [detailIdx, domKeyOf])

  const onResizePointerDown = React.useCallback((event: React.PointerEvent) => {
    resizeStartRef.current = { startX: event.clientX, startWidth: detailsWidth }
    const onMove = (e: PointerEvent) => {
      const start = resizeStartRef.current
      if (!start) return
      const next = start.startWidth - (e.clientX - start.startX)
      setDetailsWidth(Math.max(MIN_DETAILS_WIDTH, next))
    }
    const onUp = () => {
      resizeStartRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [detailsWidth])

  const detailRow = detailIdx !== null ? rows[detailIdx] ?? null : null

  return React.createElement('div', { className: 'cxpRoot', 'data-conversation-composer-overlay': '' },
    React.createElement('div', { className: 'cxpToolbar' },
      React.createElement('button', { className: 'cxpToolbarBtn', onClick: () => setRefreshTick((t) => t + 1) }, '刷新'),
      React.createElement('button', {
        className: 'cxpToolbarBtn',
        onClick: clearSelection,
        disabled: startIdx === null && endIdx === null,
      }, '清除选择'),
      React.createElement('button', {
        className: 'cxpToolbarBtn' + (span !== null ? ' cxpToolbarBtnActive' : ''),
        onClick: handleCompress,
        disabled: span === null,
      }, '压缩此区间'),
      React.createElement('span', { className: 'cxpToolbarStats' },
        'sid ' + sessionId.slice(0, 10) + ' · ' + rows.length + ' 条 · ' + totalChars + ' 字'
        + (rows.length ? ' · seq ' + rows[0].seq + '–' + rows[rows.length - 1].seq : '')),
      React.createElement('input', {
        className: 'cxpToolbarSearch',
        placeholder: '搜索',
        value: searchQuery,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value),
      }),
    ),
    React.createElement('div', { className: 'cxpViewBar', role: 'toolbar', 'aria-label': '视图选项' },
      React.createElement('button', {
        type: 'button',
        className: 'cxpViewToggle',
        'aria-pressed': actualWidth,
        title: actualWidth ? '切换为等宽显示' : '切换为按字符数宽度显示',
        onClick: () => setActualWidth((v) => !v),
      },
        React.createElement('svg', {
          className: 'cxpViewToggleIcon',
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
          React.createElement('circle', { cx: '8', cy: '8', r: '5.25' }),
          React.createElement('path', { d: 'M8 4.75V8l2.25 1.5' }),
        ),
        'Duration',
      ),
      React.createElement('button', {
        type: 'button',
        className: 'cxpViewAction',
        'aria-pressed': turnsCollapsed,
        title: turnsCollapsed ? '展开全部输入轮次' : '折叠全部输入轮次',
        onClick: toggleTurns,
      },
        React.createElement('span', { className: 'cxpViewActionIcon', 'aria-hidden': 'true' }, turnsCollapsed ? '⊞' : '⊟'),
        'Turns',
      ),
      React.createElement('button', {
        type: 'button',
        className: 'cxpViewAction',
        'aria-pressed': callsCollapsed,
        title: callsCollapsed ? '展开全部工具调用' : '折叠全部工具调用',
        onClick: toggleCalls,
      },
        React.createElement('span', { className: 'cxpViewActionIcon', 'aria-hidden': 'true' }, callsCollapsed ? '⊞' : '⊟'),
        'Calls',
      ),
    ),
    React.createElement('div', { className: 'cxpTimeline' },
      React.createElement('div', { className: 'cxpTlLabels' },
        React.createElement('span', null, '输入'),
        React.createElement('span', null, '模型'),
        React.createElement('span', null, '工具'),
      ),
      React.createElement('div', { className: 'cxpTlTrack' },
        tlSpans.map((s) => React.createElement('div', {
          key: s.globalIdx,
          className: 'cxpTlSpan',
          'data-timeline-span': rowKind(s.row),
          'data-selected': span === null ? true : s.selected,
          'data-current': s.globalIdx === startIdx || s.globalIdx === endIdx,
          style: { left: s.left + '%', width: 'max(2px, ' + s.width + '%)', top: 5 + laneOf(s.row) * 14 + 'px' },
          onClick: () => handleSelect(s.globalIdx),
          title: rowPreview(s.row),
        })),
        turnBoundaries.map((left, i) => React.createElement('div', {
          key: 'boundary-' + i,
          className: 'cxpTlTurnBoundary',
          style: { left: left + '%' },
        })),
      ),
    ),
    React.createElement('div', { className: 'cxpLedger' },
      React.createElement('div', { className: 'cxpTablePane' },
        loading && rows.length === 0
          ? React.createElement('div', { className: 'cxpEmpty' }, '加载中…')
          : error
            ? React.createElement('div', { className: 'cxpErr' }, error)
            : React.createElement('table', { className: 'cxpTbl' },
                React.createElement('colgroup', null,
                  React.createElement('col', { className: 'cxpColSeq' }),
                  React.createElement('col', { className: 'cxpColKind' }),
                  React.createElement('col', null),
                ),
                React.createElement('tbody', null,
                  filtered.length === 0
                    ? React.createElement('tr', null, React.createElement('td', { colSpan: 3, className: 'cxpEmpty' }, rows.length === 0 ? '暂无 surface 消息' : '无匹配结果'))
                    : displayItems.map((item) => {
                        if (item.kind === 'summary') {
                          return React.createElement('tr', {
                            key: item.key,
                            className: 'cxpSummaryRow',
                            ref: (el: HTMLTableRowElement | null): void => {
                              if (el) rowElRefs.current.set(item.key, el)
                              else rowElRefs.current.delete(item.key)
                            },
                            onClick: () => expandGroup(item.key),
                            title: '点击展开',
                          },
                            React.createElement('td', { colSpan: 3 },
                              React.createElement('span', { className: 'cxpSummaryEllipsis' }, '⋯'),
                              '已折叠 ' + item.count + ' 条'))
                        }
                        const { globalIdx, row } = item
                        const isStart = globalIdx === startIdx
                        const isEnd = globalIdx === endIdx
                        const inSpan = span !== null && globalIdx >= span.lo && globalIdx <= span.hi
                        return React.createElement('tr', {
                          key: row.seq,
                          className: 'cxpTblRow',
                          ref: (el: HTMLTableRowElement | null): void => {
                            const key = 'row-' + globalIdx
                            if (el) rowElRefs.current.set(key, el)
                            else rowElRefs.current.delete(key)
                          },
                          'data-selected': isStart || isEnd || inSpan || globalIdx === detailIdx,
                          onClick: () => handleSelect(globalIdx),
                        },
                          React.createElement('td', { className: 'cxpSeq' }, row.seq),
                          React.createElement('td', { className: 'cxpKindCell' },
                            (isStart ? React.createElement('span', { className: 'cxpSpanBadge' }, '起点') : null),
                            (isEnd ? React.createElement('span', { className: 'cxpSpanBadge' }, '终点') : null),
                            React.createElement('span', { className: 'cxpKindTag', 'data-kind': rowKind(row), title: row.type }, rowLabel(row))),
                          React.createElement('td', { className: 'cxpContent' }, rowPreview(row)),
                        )
                      }),
                ),
              ),
      ),
      React.createElement(DetailPanel, {
        row: detailRow,
        onClose: () => setDetailIdx(null),
        width: detailsWidth,
        onResizeStart: onResizePointerDown,
      }),
    ),
  )
}
