# The tuning model

The musical domain (`src/domain/pitch.ts`, `src/domain/tuning.ts`, and the catalog in `src/instruments/catalog.ts`) is pure TypeScript. It knows nothing of the browser, Vue, Obicall or a microphone, and it is tested without them (`tests/domain/`).

## Pitch

- **Equal temperament.** A MIDI note `m` at the reference `A4 = r` has frequency `r · 2^((m − 69) / 12)`. The reference is 440 Hz by default, and the policy can set another (442 Hz moves every note by the same ratio).
- **Cents.** The distance from a target frequency `t` to a detected one `f` is `1200 · log₂(f / t)`. An octave is 1200 cents, and an equal-tempered semitone is 100.
- **Note names.** Sharps, in scientific pitch notation: C4 = MIDI 60, A4 = MIDI 69, and the octave changes at C.
- **The nearest note** of a frequency is the nearest MIDI note: 440 Hz is A4 at 0 cents. This is the generic model any pitched instrument can use.

## Tuning

An instrument is a list of target strings (label, MIDI note, published frequency), or no strings at all: the **chromatic** tuning, for voice, flute, or any pitched instrument.

| Instrument | Strings |
|---|---|
| Standard Guitar | E2 82.41 · A2 110 · D3 146.83 · G3 196 · B3 246.94 · E4 329.63 Hz |
| Standard Bass | E1 41.2 · A1 55 · D2 73.42 · G2 98 Hz |
| Violin | G3 196 · D4 293.66 · A4 440 · E5 659.26 Hz |
| Standard Ukulele | G4 392 · C4 261.63 · E4 329.63 · A4 440 Hz |
| Chromatic | none: the nearest note |

A reading of a frequency against a tuning works as follows:

1. **The target** is the string nearest in cents, if it lies within the **capture** range (600 cents). Otherwise the reading is of the nearest string and is *uncertain*. With no strings, the target is the nearest note.
2. **The status**, from the cents off the target and the source's confidence:

   | Status | When |
   |---|---|
   | **uncertain** | confidence below 0.6, whatever the cents |
   | **flat** | below −5 cents |
   | **in tune** | within ±5 cents, inclusive |
   | **sharp** | above +5 cents |

3. **Steady** (`isStable`): the last 2 readings have the same target and status, and lie within 3 cents of each other.
4. **No signal**: a frequency that isn't a positive finite number makes no reading. Silence clears the reading.

These numbers are the `DEFAULT_POLICY` (`src/domain/tuning.ts`). The policy is data, so a stricter tuner is a different policy, not different code.

### The acceptance examples

| Input | Reading |
|---|---|
| Standard Guitar: 108, 109, 110, 110 Hz, 250 ms apart | A2 flat (−31.8 cents), A2 flat (−15.8 cents), A2 in tune, A2 in tune and **steady** |
| 111 Hz | A2, 15.67 cents sharp |
| Chromatic: 440 Hz | A4, 0 cents, in tune |

These run in `tests/domain/tuning.test.ts`, through the whole application in `tests/app/session.test.ts` and `tests/harness/demo-input.test.ts`, and in the browser demo.

## Fusion

Several pitch sources heard together, within a 100 ms window, are fused by **inverse variance**:

- `x̂ = Σ(xᵢ/σᵢ²) / Σ(1/σᵢ²)`
- `σ̂² = 1 / Σ(1/σᵢ²)`
- the confidence is weighted the same way.

The fused value lies between the inputs, nearer the surer one, and the fused variance is below every input variance. This is the same mathematics as Obicall's native `obicall_static_fuse_1d`, bit for bit (`docs/OBICALL.md`). A source whose variance isn't positive, or whose frequency isn't finite, is dropped and reported.
