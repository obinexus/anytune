# `.obr` journal conformance fixtures

These files test that AnyTune's **own** reader and writer of the `.obr` journal format (`src/adapters/obr-journal.ts`) conform to the format. They are not pitch data and not music. AnyTune does not depend on, load, link or run Obicall (`docs/OBR.md`).

| File | What it is | Where it comes from |
|---|---|---|
| `demo.obr` | The format's demonstration journal: 102 records, two sensors (`cam_position_a`, `imu_a`), each restarted once, and 2-D positions in metres. | Published with [obicall](https://github.com/obinexus/obicall) `ae5581a` (`share/obicall/recordings/demo.obr`), copied unchanged. SHA-256 `3838115346787cfacb55674dd738b5437ec01858a6fd28651ccad417786c79b4`, as the artifact manifest it was published with states. MIT License, © 2026 Nnamdi Michael Okpala / OBINexus Computing (see `THIRD_PARTY_NOTICES.md`). |
| `replay-oracle.json` | What the format's reference implementation (`obicall replay`, `ae5581a`) said, once, of `demo.obr` and of every torn variant `tools/obr/torn-variants.ts` derives from it: records read, admitted, last window, and the status it stopped at. | Recorded in 2026 before Obicall was removed from AnyTune. **Frozen**: the tool that asked was removed with Obicall, and the file is never edited. It is evidence about the format, not a dependency. |

`tests/adapters/obr-journal.test.ts` reads every variant and compares with the frozen answers, and writes `demo.obr` back byte for byte with AnyTune's writer.
