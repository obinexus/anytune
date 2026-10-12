# MIDI fixtures

| File | What it is | Where it comes from |
|---|---|---|
| `fur-elise-opening.mid` | The opening phrase of Beethoven's *Für Elise* (WoO 59): 3/8, A minor, 480 PPQ; ♩ = 72, then ♩ = 60 from bar 5; the right-hand melody (track 1, channel 1), the left hand (track 2, channel 2) with the sustain pedal, and one deliberate same-key overlap of A2 in bar 6. 48 notes, 495 bytes, SHA-256 `c82120509bb3bec94baab0ab8857f33c72d3eff1d6bb971dcf4711e5916e78fd`. | The composition is in the public domain. This encoding was written for AnyTune from the score by `tools/fixtures/fur-elise.ts` (`node tools/fixtures/fur-elise.ts`), and is MIT like the rest of AnyTune. It is written by **midi-file** 1.2.4, with running status and velocity-0 note-ons, so that AnyTune's reader is never tested on its own writer's output. |

No fixture here comes from a recording, a video or a download: they are scores, and nothing else.
