# Brother .lbx generation in browser JS (QL-700, DK-22205)

Brother publishes NO .lbx spec. Everything below is from reverse-engineering projects. Verified items were
checked against a real P-touch Editor-produced file (jdlien `default-text-only-12mm.lbx`, downloaded and unzipped).
Items marked UNVERIFIED were not confirmed against a QR-containing, QL-series file.

## 1. Container and XML
- .lbx = ordinary ZIP. Entries: `label.xml`, `prop.xml`, optional images (BMP/TIFF). Verified: the sample's two entries
  are Deflate-compressed; jdlien's writer adds label.xml, prop.xml, then images.
  - https://github.com/jdlien/lbx-utils (README, `src/lbx_utils/generator/lbx_generator.py`)
  - https://github.com/Alecto3-D/brother-p-touch-editor-format (QL-700 sample: zip of label.xml, prop.xml, TIF)
  - https://www.randomhacks.co.uk/extracting-data-from-brother-p-touch-label-printer-lbx-files/
- Namespaces (all `http://schemas.brother.info/ptouch/2007/lbx/<x>`): main(pt), style, text, draw, image, barcode,
  database, table, cable. prop.xml uses `.../lbx/meta` + Dublin Core (`dc`, `dcterms`).
- Root: `<pt:document ... version="1.9" generator="com.brother.PtouchEditor">` > `pt:body currentSheet="Sheet 1" direction="LTR"`
  > `style:sheet name="Sheet 1"` > `style:paper`, `style:cutLine`, `style:backGround`, `pt:objects`.
  (wheelerfs PR #21 emitted version 1.7 for a PT-D610BT, so 1.7-1.9 all seem accepted.)
- Units: points with the suffix, e.g. `width="33.6pt"` (not twips). 1 mm = 2.8346 pt, so 62 mm = 175.7 pt.
  Source: jdlien `data/schema/lbx-specification.md`.
- `style:paper` (verified, PT-P710BT 12 mm): `media="0" width="33.6pt" height="2834.4pt" marginLeft="2.8pt" marginTop="5.6pt"
  marginRight="2.8pt" marginBottom="5.6pt" orientation="landscape" autoLength="true" monochromeDisplay="true"
  printColorDisplay="false" printColorsID="0" paperColor="#FFFFFF" paperInk="#000000" split="1" format="259"
  backgroundTheme="0" printerID="30256" printerName="Brother PT-P710BT"`.
  In landscape, `width` is the tape width. `format` and `printerID` are numeric codes per tape/printer. **The DK-22205 /
  QL-700 values (format, printerID, margins, media) are not published anywhere I found: UNVERIFIED, must come from a
  real export.** Continuous = autoLength="true" (plus a height that Editor recomputes).
- Text object (verified), strict child order: `pt:objectStyle` (with `pt:pen`, `pt:brush`, `pt:expanded`) ->
  `text:ptFontInfo` (`text:logFont name weight="400|700" ...`, `text:fontExt size orgSize ...`) -> `text:textControl` ->
  `text:textAlign` -> `text:textStyle` -> `pt:data` (text as element content) -> `text:stringItem charLen="N"` (per-run font info).
  jdlien says `orgSize` = 3.6 x font size (sample: size 21.7pt, orgSize 28.8pt, so not literally 3.6x; keep the pair copied from the export). Bold = `weight="700"` (UNVERIFIED, standard LOGFONT).
- Gotchas (jdlien README/spec): element order is strict, wrong order can crash Editor; emit the body on one line, text as
  element content, all elements prefixed.
- QR object (from jdlien generator code, UNVERIFIED on real QL file): `barcode:barcode` containing, in order:
  `pt:objectStyle` (x,y,width,height in pt, pen `style="INSIDEFRAME"`, `pt:expanded objectName="Barcode1" ...`),
  `barcode:barcodeStyle protocol="..."` (jdlien writes the lowercase alias "qr"; the real value is probably "QRCODE": UNVERIFIED) with attrs `lengths zeroFill
  barWidth="0.8pt" barRatio="1:3" humanReadable="false" humanReadableAlignment checkDigit autoLengths margin sameLengthBar
  bearerBar`, then `barcode:qrcodeStyle model="2" eccLevel="7%|15%|25%|30%" cellSize="2pt" mbcs="auto" joint="1" version="auto"`,
  then `pt:data` (content). jdlien cell sizes: 0.8pt..2.4pt (5 steps); default 2pt, ~58pt square for 29 modules.
  Source: https://github.com/jdlien/lbx-utils/blob/main/src/lbx_utils/generator/lbx_generator.py (lines ~880-1020).
  No complete QR-bearing label.xml is published that I could fetch.
- Alternative that avoids the barcode object: wheelerfs PR #21 (browser-only, no libs, own deflate zip writer via
  `CompressionStream('deflate-raw')`) draws the QR as a 720 dpi 1-bit BMP image inside the lbx (QR modules = whole printer dots).
  Prints and scans, but the QR is not editable in Editor. https://github.com/wheelejay/wheelerfs.com/pull/21

## 2. Multiple labels per file
- Format has `pt:body currentSheet` / `style:sheet name`, and prop.xml has `meta:numPages`, but I found NO evidence of
  multi-sheet .lbx files being produced or tested by anyone; jdlien writes one sheet, `numPages=1`. P-touch Editor's own
  multi-label model is one layout + a connected database (CSV/Excel) merged at print time (the .lbxs bundle, Editor 6.4+:
  https://download.brother.com/pub/com/p-touch6-help/en-US/help/file/file_lbxs/file_lbxs.html). Editor 5 cannot open .lbxs.
- Practical options: (a) one .lbx per label zipped (wheelerfs does this: one lbx per unit plus a batch .zip per job);
  (b) one layout .lbx with merge fields (objects with `templateMergeTarget`, `database:` namespace) + CSV. (b) needs
  an exported sample, as the database elements are undocumented. Multi-sheet is a gamble: untested.

## 3. Newlines in QR data
Not documented. XML text content can hold literal LF (or `&#10;`), and the sample generator stores data as element text,
so multi-line `pt:data` is very likely accepted (Editor's QR dialog takes multi-line text), but UNVERIFIED. Note XML parsers
normalise CR/LF to LF; use `&#10;` and test. Options: model 2, eccLevel 7/15/25/30%, cellSize, version auto or 1-40, `mbcs` auto.
~200 chars at M level is about QR version 10-11 (57-61 modules): at 2pt cell about 120pt = 42 mm. Fits 62 mm width.

## 4. Encoding / zip
- XML declaration UTF-8, no BOM in the sample. Use UTF-8 without BOM, not UTF-16.
- Deflate worked (sample Defl:N); wheelerfs uses deflate-raw too. Stored should also be fine (jdlien notes mode "w" via
  Python zipfile; note Python's default there is actually STORED, so both methods evidently load). Keep entry order
  label.xml, prop.xml, images; plain names, no directories, no zip64/data-descriptor tricks.
  A hand-written store-only zip writer (CRC32 + headers, ~40 lines) avoids needing a library; `fflate`/JSZip also fine.

## 5. b-PAC
b-PAC SDK (Windows COM/.NET, fills a template .lbx and prints). Not usable from a browser; only from a native helper
(our desktop app could use it). Brother Web SDK for QL (WebUSB/raster) bypasses .lbx entirely.

## 6. Recommendation
1. Ask the maintainer for a template. Do not hand-write the QR object from third-party code.
2. Generate in JS by string templating that exported label.xml, replacing only `pt:data` content (and the text `charLen`
   and font attrs), zipping with label.xml, prop.xml in that order, UTF-8, deflate or store.
3. One .lbx per label, bundled as a .zip, until a multi-sheet file has been proven in Editor 5.
4. Maintainer should create in P-touch Editor 5.x: printer QL-700, media 62 mm continuous (DK-22205), landscape, auto
   length. Put ONE QR (Model 2, level M, the cell size we want, data = a ~170-char multi-line sample with real newlines),
   plus three text objects: line 1 bold ("CODE-0001"), line 2 regular (short ID), line 3 regular (nickname). Save as
   `label-template.lbx`. Also optionally a second copy with 2 labels via Insert > New Page / Layout, to see if multi-sheet exists.
   Then commit the unzipped label.xml/prop.xml for us to diff against the generator.
