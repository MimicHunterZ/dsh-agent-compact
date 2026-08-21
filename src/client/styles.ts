export const CSS_TAG = '@mimichunterz/agent-compact/ctx-surface.css'

// cxp = "ctx panel" v2 (replaces the old cx1-prefixed hand-copy). Values
// reference the same --dsw-* design tokens the shipped trajectory panel
// uses (verified against its real compiled CSS), not hard-coded colors.
//
// Bottom clearance: --dsh-trajectory-bottom-clearance is NOT a global
// variable — the shipped trajectory panel only *defines* it locally on its
// own ledger element (scoped to that subtree), derived from the truly
// shared --dsh-composer-height (set on a shared scroller ancestor by the
// conversation composer via ResizeObserver). Our own cxpLedger sits in a
// separate DOM subtree, so referencing --dsh-trajectory-bottom-clearance
// without defining it here always fell back to the CSS default (0px): no
// space was ever reserved for the floating composer overlay, so the last
// rows sat underneath it and the pane could never actually scroll to the
// true bottom. Define the same derived value locally, exactly like
// trajectory's own ledger does, so cxpTablePane's padding-bottom resolves
// to a real pixel value instead of silently falling back to 0.
//
// Timeline/tag colors: matched byte-for-byte against trajectory's real
// compiled formulas (dsh-client-ui-trajectory/lib/client.js) instead of the
// earlier approximations — user=business-primary (unchanged), tool=warn
// label (unchanged), message now uses the exact
// `--trajectory-assistant-decoding-color` mix (brand 60% + error-secondary,
// not the old brand 62% + label-secondary approximation, which read too
// blue/flat next to trajectory's more violet assistant color), and a new
// `context` kind (green, state-success-primary 68% + label-secondary) was
// added for `user/message` rows whose `source.kind !== 'user'` — see
// surface-utils.ts's rowKind() and ../ctx-surface.ts's `source` field.
//
// cxpViewBar/cxpViewToggle/cxpViewAction mirror trajectory's own
// TrajectoryToolbar.module.css (.fV0t5q_*) pill/toggle look for the
// Duration/Turns/Calls-equivalent row CtxSurfaceView renders under the main
// toolbar (kept, not replaced: 刷新/清除选择/压缩此区间/search stay in
// .cxpToolbar; the new row is purely additive).
//
// cxpKindCell: trajectory's own kind slot is right-aligned
// (`.Y0dWHa_kindSlot{justify-content:flex-end}`) — its badges hug the right
// edge of the narrow kind column instead of hugging the left edge like the
// seq column next to it. Match that instead of the browser's default
// left-aligned <td>.
//
// cxpColKind width: first set to 66px to fit the new short badges (see
// rowLabel), but that forgot the <td>'s own `padding:0 8px` (16px eaten
// before the badge even starts) — 'ASSISTANT' (widest label) then clipped
// its last letter with no ellipsis (text-overflow only applies to a text
// node directly inside the overflow box, not a nested <span>, so it just
// silently cuts pixels). 84px leaves ~68px for the badge itself, comfortably
// fitting 'ASSISTANT' at this font-size. letter-spacing bumped .02em ->
// .035em to match trajectory's own `.Y0dWHa_kindTag` value exactly too.
export const CSS = `
.cxpRoot{--dsh-trajectory-toolbar-height:34px;box-sizing:border-box;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);flex-direction:column;display:flex;overflow:hidden}
.cxpToolbar{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;align-items:center;gap:6px;height:var(--dsh-trajectory-toolbar-height);padding:0 10px;display:flex}
.cxpToolbarBtn{color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-12);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;height:24px;padding:0 10px;display:inline-flex;align-items:center;gap:4px}
.cxpToolbarBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.cxpToolbarBtnActive{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-state-business-primary);font-weight:600}
.cxpToolbarBtnActive:hover{background:var(--dsw-alias-state-business-primary);opacity:.92;color:var(--dsw-alias-bg-layer-1)}
.cxpToolbarBtn:disabled{opacity:.4;cursor:default;background:var(--dsw-alias-bg-module-platform)}
.cxpToolbarStats{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);white-space:nowrap;margin-left:6px}
.cxpToolbarSearch{margin-left:auto;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);height:24px;padding:0 8px;width:180px}
.cxpViewBar{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:none;align-items:center;gap:2px;height:26px;padding:0 6px;display:flex}
.cxpViewToggle{height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-12);background:0 0;border:0;border-radius:3px;flex:none;align-items:center;gap:4px;padding:0 7px;display:inline-flex}
.cxpViewToggle:hover,.cxpViewToggle[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cxpViewToggleIcon{stroke:currentColor;stroke-width:1.25px;stroke-linecap:round;stroke-linejoin:round;flex:none;width:12px;height:12px}
.cxpViewAction{height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xxs-12);background:0 0;border:0;border-radius:3px;flex:none;align-items:center;gap:4px;padding:0 5px;display:inline-flex}
.cxpViewAction:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cxpViewActionIcon{color:var(--dsw-alias-label-tertiary);font:14px/14px var(--ds-font-family-code)}
.cxpTimeline{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);grid-template-columns:40px minmax(0,1fr);height:50px;display:grid;flex:none;overflow:hidden}
.cxpTlLabels{border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);font:9px/1 var(--dsw-font-family);position:relative}
.cxpTlLabels span{text-align:right;justify-content:flex-end;align-items:center;height:12px;display:flex;position:absolute;right:4px}
.cxpTlLabels span:nth-child(1){top:5px}
.cxpTlLabels span:nth-child(2){top:19px}
.cxpTlLabels span:nth-child(3){top:33px}
.cxpTlTrack{position:relative;overflow:hidden}
.cxpTlSpan{position:absolute;height:10px;border-radius:1.5px;cursor:pointer;opacity:.88;transition:opacity .1s}
.cxpTlSpan:hover{opacity:1;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-2),0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent)}
.cxpTlSpan[data-timeline-span=user]{background:var(--dsw-alias-state-business-primary)}
.cxpTlSpan[data-timeline-span=context]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 68%,var(--dsw-alias-label-secondary))}
.cxpTlSpan[data-timeline-span=message]{background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary)) 60%,var(--dsw-alias-state-error-secondary,var(--dsw-alias-label-secondary)))}
.cxpTlSpan[data-timeline-span=tool]{background:var(--dsw-alias-state-warn-label)}
.cxpTlSpan[data-selected=false]{opacity:.22}
.cxpTlSpan[data-current=true]{opacity:1;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-2),0 0 0 2px var(--dsw-alias-state-business-primary)}
.cxpTlTurnBoundary{position:absolute;top:0;bottom:0;width:1px;background:var(--dsw-alias-border-l1);pointer-events:none}
.cxpLedger{flex:1;min-width:0;min-height:0;display:flex;position:relative;overflow:hidden;container-type:inline-size;--dsh-trajectory-bottom-clearance:calc(var(--dsh-composer-height,152px) + 16px)}
.cxpTablePane{min-width:0;flex:1;position:relative;overflow:hidden auto;padding-bottom:var(--dsh-trajectory-bottom-clearance,0px)}
.cxpTbl{border-spacing:0;table-layout:fixed;width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xxs-12)}
.cxpTbl col.cxpColSeq{width:52px}
.cxpTbl col.cxpColKind{width:84px}
.cxpKindCell{text-align:right}
.cxpTbl td{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1);height:28px;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.cxpTblRow{cursor:pointer}
.cxpTblRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cxpTblRow[data-selected=true]{background:var(--dsw-alias-interactive-bg-active)}
.cxpSummaryRow{cursor:pointer}
.cxpSummaryRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cxpSummaryRow td{height:22px;color:var(--dsw-alias-label-tertiary)}
.cxpSummaryEllipsis{color:var(--dsw-alias-label-caption);font-weight:600;margin-right:6px}
.cxpSeq{color:var(--dsw-alias-label-caption);font:11px/16px var(--ds-font-family-code)}
.cxpKindTag{box-sizing:border-box;letter-spacing:.035em;border-radius:4px;font-size:10px;font-weight:650;line-height:16px;padding:0 5px;display:inline-flex}
.cxpKindTag[data-kind=user]{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.cxpKindTag[data-kind=context]{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 68%,var(--dsw-alias-label-secondary));background:var(--dsw-alias-state-success-tertiary)}
.cxpKindTag[data-kind=message]{color:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary)) 60%,var(--dsw-alias-state-error-secondary,var(--dsw-alias-label-secondary)));background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-business-primary)) 55%,var(--dsw-alias-state-error-secondary,var(--dsw-alias-label-secondary))) 15%,var(--dsw-alias-bg-layer-1))}
.cxpKindTag[data-kind=tool]{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.cxpSpanBadge{color:var(--dsw-alias-state-business-primary);font:600 10px/16px var(--dsw-font-family);margin-right:4px}
.cxpContent{color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px}
.cxpEmpty,.cxpErr{color:var(--dsw-alias-label-tertiary);text-align:center;padding:24px;font:var(--dsw-font-xxs-12)}
.cxpErr{color:var(--dsw-alias-state-error-primary)}
.cxpDetails{border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex-direction:column;flex:none;width:clamp(320px,38%,440px);min-width:0;max-width:calc(100% - 240px);min-height:0;display:flex;position:relative}
.cxpDetailsResizeHandle{cursor:col-resize;touch-action:none;background:0 0;border:0;width:8px;padding:0;position:absolute;top:0;bottom:0;left:-4px;z-index:2}
.cxpDetailsHeader{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;height:40px;padding:0 8px 0 12px;display:flex}
.cxpDetailsTitle{min-width:0;color:var(--dsw-alias-label-primary);align-items:center;gap:6px;display:flex;overflow:hidden}
.cxpDetailsTitleSeq{font:500 12px/16px var(--ds-font-family-code);flex:none}
.cxpDetailsTitleKind{color:var(--dsw-alias-label-tertiary);font:11px/16px var(--ds-font-family-code);overflow:hidden;text-overflow:ellipsis}
.cxpClose{width:26px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:16px}
.cxpClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cxpDetailTabs{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;flex:none;gap:2px;height:32px;padding:0 8px;display:flex;overflow:auto hidden}
.cxpDetailTab{color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-xs-13);background:0 0;border:0;padding:0 9px;position:relative}
.cxpDetailTab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cxpDetailTabActive{color:var(--dsw-alias-state-business-primary)}
.cxpDetailTabActive:after{content:"";position:absolute;left:9px;right:9px;bottom:0;height:2px;border-radius:1px 1px 0 0;background:var(--dsw-alias-state-business-primary)}
.cxpDetailBody{flex:1;min-height:0;overflow:hidden auto;padding:10px 14px}
.cxpOverview>div{display:grid;grid-template-columns:82px minmax(0,1fr);align-items:center;min-height:22px}
.cxpOverview dt{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.cxpOverview dd{margin:0;min-width:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cxpBlockHeading{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-strong-13,600 12px/18px var(--dsw-font-family));margin:12px 0 4px}
.cxpBlockHeading:first-child{margin-top:0}
.cxpBlockText{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13,13px/19px var(--dsw-font-family));white-space:pre-wrap;margin:0 0 8px}
.cxpBlockCode{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-module-platform));font:12px/19px var(--ds-font-family-code);white-space:pre-wrap;border-radius:4px;margin:0 0 8px;padding:8px}
.cxpJsonHost{font:12px/18px var(--ds-font-family-code)}
.cxpJsonHost [role=treeitem]{padding:1px 0}
.cxpJsonHost [data-json-expander]{display:inline-block;width:12px;color:var(--dsw-alias-label-caption);cursor:pointer;user-select:none}
.cxpJsonHost ul{list-style:none;margin:0;padding-left:14px;border-left:1px dotted var(--dsw-alias-border-l1)}
`
