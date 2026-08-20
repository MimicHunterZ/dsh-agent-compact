import * as React from 'react'
import { DetailPanel } from './DetailPanel.js'
import { compressPrompt, isToolRow, laneOf, rowKind, rowPreview } from './surface-utils.js'
import type { CtxSurfaceRow, CtxSurfaceViewProps } from './types.js'

const EMPTY_ROWS: readonly CtxSurfaceRow[] = []
const DEFAULT_DETAILS_WIDTH = 380
const MIN_DETAILS_WIDTH = 320

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
    const total = filtered.reduce((a, r) => a + Math.max(1, r.chars), 0)
    return filtered.map((r) => Math.max(1, (r.chars * 100) / total))
  }, [filtered])

  let tlLeft = 0
  const tlSpans = filtered.map((row, i) => {
    const globalIdx = rows.indexOf(row)
    const width = tlWidths[i]
    const selected = span !== null && globalIdx >= span.lo && globalIdx <= span.hi
    const item = { globalIdx, row, left: tlLeft, width, selected }
    tlLeft += width
    return item
  })

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
          'data-timeline-span': rowKind(s.row.type),
          'data-selected': span === null ? true : s.selected,
          'data-current': s.globalIdx === startIdx || s.globalIdx === endIdx,
          style: { left: s.left + '%', width: 'max(2px, ' + s.width + '%)', top: 5 + laneOf(s.row) * 14 + 'px' },
          onClick: () => handleSelect(s.globalIdx),
          title: rowPreview(s.row),
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
                    : filtered.map((row) => {
                        const globalIdx = rows.indexOf(row)
                        const isStart = globalIdx === startIdx
                        const isEnd = globalIdx === endIdx
                        const inSpan = span !== null && globalIdx >= span.lo && globalIdx <= span.hi
                        return React.createElement('tr', {
                          key: row.seq,
                          className: 'cxpTblRow',
                          'data-selected': isStart || isEnd || inSpan || globalIdx === detailIdx,
                          onClick: () => handleSelect(globalIdx),
                        },
                          React.createElement('td', { className: 'cxpSeq' }, row.seq),
                          React.createElement('td', null,
                            (isStart ? React.createElement('span', { className: 'cxpSpanBadge' }, '起点') : null),
                            (isEnd ? React.createElement('span', { className: 'cxpSpanBadge' }, '终点') : null),
                            React.createElement('span', { className: 'cxpKindTag', 'data-kind': rowKind(row.type) }, row.type)),
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
