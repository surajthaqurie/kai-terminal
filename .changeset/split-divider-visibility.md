---
"kai-terminal": patch
---

Make the split-pane divider visible in every theme, fixing the invisible seam on dark terminals (kali). The divider used the 8%-white subtle token, which composited to ~1.2:1 against the kali terminal background — indistinguishable from it. It now uses the per-theme `--border-strong` token (~2:1 on kali, clearly visible everywhere), locked by a new contrast test covering all eight themes, while hover/active keep the accent treatment. Also sets `box-sizing: border-box` on grid panes so the active pane's 1px border paints inside its tile instead of pushing 1px over the neighbor.
