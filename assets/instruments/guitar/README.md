# Guitar artwork and its fretboard map

| File | What it is | Source and licence |
|---|---|---|
| `yorbederycke-guitar-6755435.svg` | The guitar AnyTune shows when guitar is chosen: a six-string acoustic guitar seen from the front, headstock up. **Kept exactly as supplied** (SHA-256 `8e2a36241e2eb838bb48a134798859b7217debf908dc132b58a2c18ad7e19df3`). | "Guitar, Music, Musical Instrument" by **yorbederycke** on Pixabay, https://pixabay.com/vectors/guitar-6755435/, under the **Pixabay Content License**, as that page stated on 2026-10-11. The licence allows use in an app without attribution; AnyTune credits the author anyway. It doesn't allow selling or redistributing the file as a standalone stock asset, which AnyTune doesn't do. |
| `fretboard-map.json` | Where each string and fret is on that drawing: the nut, 20 fret wires, the six string lines, the inlay frets, and a target point for every string and fret. Music never comes from the drawing, and the drawing code never computes music (`src/music/fretboard.ts`). | Derived from the artwork's geometry by `node tools/guitar/derive-fretboard-map.ts` (`--check` verifies the committed copy). It doesn't depend on element order. Its own check: the inlay dots fall on frets 3, 5, 7, 9, 12, 15 and 17. |

**Orientation.** For a right-handed guitar seen from the front with the headstock up, string 6 (low E) is on the viewer's left. A left-handed view mirrors the map (`mirrored`), and the labels follow the strings, not the side.

The artwork has no musical model of its own. Its strings are drawn lines, and the map adds the semantics: chords, voicings and suggested fingerings live in `src/music/chords.ts` and `src/music/guitar.ts`.
