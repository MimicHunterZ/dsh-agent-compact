export const CSS_TAG = '@mimichunterz/agent-compact/ctx-surface.css'

// cxp = "ctx panel" v2。颜色值引用 --dsw-* 设计 token。注意：
// --dsh-trajectory-bottom-clearance 需在本地定义，否则 cxpTablePane 的底部
// 留白会回退为 0。
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
