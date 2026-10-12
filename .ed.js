const fs=require('fs');
function edit(p,pairs){let s=fs.readFileSync(p,'utf8');for(const [a,b] of pairs){if(!s.includes(a)) throw new Error('missing '+a.slice(0,40)); s=s.replace(a,b);} fs.writeFileSync(p,s);}
edit('docs/superpowers/specs/2026-10-12-label-printing-design.md',[
['   S-0123 · 1a2b3c4d\n   Ti-6Al-4V · "bracket A"\n   2026-10-01 · DP\n   ```\n','   S-0123 | 1a2b3c4d\n   Ti-6Al-4V | "bracket A"\n   2026-10-01 | DP\n   ```\n   The separator is ASCII ` | ` so a USB scanner, which types keystrokes and cannot type a middle dot, can\n   read every line. Labels printed earlier used ` · `; they still parse (decision 12).\n']]);
edit('docs/superpowers/plans/2026-10-12-label-printing.md',[
["'D1 SAMPLE\n<code> · <shortId>\n…'","'D1 SAMPLE\n<code> | <shortId>\n…'"]]);
edit('docs/runbooks/physical-test-backlog.md',[
["address instead (`http://d1-server...`): it says the camera needs the HTTPS address. Since PR B (#TBD).","address instead (`http://d1-server...`): it says the camera needs the HTTPS address. Open the dialog and\n  lock the phone, then unlock it: the camera comes back and scanning resumes without reopening the dialog. Open the\n  dialog, then switch to the phone's own camera app and back: the dialog shows \"The camera stopped...\" (or, if it\n  had only been hidden, resumes), and **Try again** restarts it. Since PR B (#TBD)."],
["QL-700 62 mm roll scans too, and the camera stops when the dialog is closed or the tab is switched away\n  and back. Since PR B (#TBD).","QL-700 62 mm roll scans too, and the camera light goes off when the dialog is closed. Lock/unlock mid-scan\n  resumes scanning, and opening the camera app and returning shows the \"stopped\" message or resumes, as on the\n  iPhone. Since PR B (#TBD)."]]);
