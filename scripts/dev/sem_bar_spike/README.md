# SEM data-bar OCR spike (2026-10-16)

Throwaway trial for the SEM data-bar reader
([spec](../../../docs/superpowers/specs/2026-10-16-sem-data-bar-reader-design.md)). It is not wired into the crawler.

## Result

The test set was 300 TIFFs from SEM-named folders on the lab share. 246 of them carry FEI metadata (tag 34682), which
serves as the ground truth.

| Field | Right |
|---|---|
| HV (kV) | 246/246 |
| WD (mm) | 246/246 |
| spot | 246/246 |
| det (when the bar shows it) | 148/148 |
| mode | 246/246 |
| mag | 246/246 (consistent with `HFW`: mag × HFW is one of two screen-width constants, 0.2984 m or 0.858 of that) |

The run takes about 47 s for 300 files over SMB on the CPU (RapidOCR's recogniser, onnxruntime). 13 file names
disagree with the bar's magnification. The metadata shows that the file names are wrong, not the bar.

## What made it work

1. **Don't run text detection.** Splitting the bar with RapidOCR's detector smears the whole bar into one line
   ("20.0yky db .2mm ..."). Cut the bar into its cells yourself and call only the recogniser,
   `RapidOCR().text_recognizer([imgs])`.
2. **Cells.** The vertical white divider columns (bright in more than 90% of the bar height) give the cell edges. Split
   the header row from the value row at the **darkest row gap** in the middle band, judged on the left 40% of the
   width. There is no horizontal line between the two rows inside the cells. The only horizontal lines are under the
   scale bar, on the right, and a mean over the full width mistakes the scale-bar line for a divider.
3. **Preparation.** Invert to black on white, scale ×2 with Lanczos, and add 6 px of white padding.
4. **Map by header text, not by position.** Layouts differ between instruments and set-ups:
   `HV | det | WD | mag | mode | spot` on some, `mode | HV | spot | WD | mag` (no det) on others. The scale-bar cell
   has its label ("40 µm") on the top row.
5. **Confidence is a poor filter.** Correct reads scored as low as 0.62, so the spec's 0.8 threshold would reject
   good values. Validate the format and range instead, and cross-check mag × HFW where metadata exists.

## Run

```sh
python -m venv .venv && .venv/Scripts/pip install rapidocr-onnxruntime
.venv/Scripts/python ocr_trial.py paths.txt 'Z:\star_group1' out.json   # paths.txt: share-relative .tif paths
```
