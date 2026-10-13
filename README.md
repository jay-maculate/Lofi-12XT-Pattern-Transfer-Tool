# Lofi-12 XT patterns

Move a pattern, and the samples it uses, from one Lofi-12 XT project to another.

Open the page in Chrome or Edge, choose the SD card (or its `System` folder), pick a project on each side, and drag a pattern across. Drop it on a slot to replace that slot, or drop it on the empty part of the list to use the first empty slot.

The page reads and writes the card directly. Nothing is uploaded.


## What gets copied

The pattern file is written into the destination slot. Both pattern-number fields are set to that slot. Each sample the tracks use is copied into a free sample slot in the destination project, along with its `.wav` and `.wdt` file, unless that exact path is already in the destination. `filedb.bin` is left unchanged. A tested copy played on the device without it.
