# AnyTune and Obicall

[Obicall](https://github.com/obinexus) is OBINexus's sensor-fusion runtime: sources publish observations, a journal admits and records them, and a broker fuses them into estimates. AnyTune's tuning pipeline has the same shape: pitch sources, fusion, one estimate. That's why AnyTune was designed so that Obicall could one day carry its pitch.

It can't today. This document separates what AnyTune does with Obicall now from what it simulates, and from what Obicall must gain first. The reference is obicall `ae5581a` (version 0.1.1, ABI 1.0), built and staged read-only. AnyTune never modifies Obicall.

## Current integration boundary

| | Status |
|---|---|
| **Real `.obr` reader** | **Implemented and tested.** `src/adapters/obicall-replay.ts` (`ObicallReplayReader`) |
| **Native scalar-fusion conformance** | **Implemented and tested.** `tests/fusion/native-conformance.test.ts` against `obicall_static_fuse_1d` |
| **Obicall Hz/frequency observation** | **Not supported by the current Obicall ABI** |
| **Native browser bridge** | **Not implemented.** The browser never loads Obicall |

### Implemented now

- **`ObicallReplayReader`** (`src/adapters/`) reads Obicall's replay journal the way Obicall reads it. It checks each record in the order `obicall_journal_read_record` does:
  - the `JORB` magic;
  - the 40-byte little-endian header;
  - `record_len = 40 + observation_len` and `observation_len ≤ 4096`;
  - the CRC-32/ISO-HDLC of the observation;
  - the window sequence, the admission time and the admission reason;
  - the wire-encoded observation, decoded field by field.

  It stops at the first torn or malformed record. It never skips past one: it keeps the records before it and leaves its offset at the start of the bad record. It names the stop with Obicall's own status words.
- It is a **format adapter**, never a pitch provider. What it reads is what Obicall carries: positions, velocities and ranges.

### Proven compatible, against the real Obicall

- **The replay format.** The reader is tested on Obicall's real recording, `demo.obr`, copied unchanged with its SHA-256 pinned to Obicall's own artifact manifest. It has 102 records, final window sequence 102, and two sensors (`cam_position_a`, `imu_a`) each restarted once, with sequences rising per boot. Each record is a 2-D position in metres. The oracle is Obicall itself:
  - `tools/obicall/record-oracle.ts` gave the recording and ten torn variants of it to the real staged `obicall replay`: cut in an observation, cut in a header, a flipped observation bit, a flipped CRC bit, a bad magic, a record length that doesn't match, an observation over 4096 bytes, and two re-sealed records that only the decoding can reject.
  - What `obicall replay` said is committed in `tests/fixtures/obicall/replay-oracle.json`: the records read, admitted, the last window sequence, and the status it stopped at.
  - The reader agrees on every one. The test asks the executable again whenever the staged build is present.
- **The fusion mathematics.** AnyTune fuses pitch by inverse variance (`src/fusion/scalar-fusion.ts`). A native harness (`tools/obicall-native/fuse-harness.c`, built by `build.sh` against the staged `obicall.dll`) calls `obicall_static_fuse_1d` and nothing else. The comparison covers 2 050 cases:
  - Obicall's worked example: 10.0 with variance 0.04 and 10.4 with variance 0.16 fuse to 10.08 with variance 0.032;
  - the identity, and several measurements;
  - every refusal: no measurement, a variance ≤ 0 or −0, NaN and infinities, and a bad value after good ones;
  - overflow, subnormals and signed zeros;
  - the order of accumulation;
  - 2 000 seeded cases.

  AnyTune gives the same status and **the same bits** on all of them (`tests/fixtures/obicall/fuse-oracle.json`). A control shows that a fusion summing in the reverse order would fail.
- **What this claims:** AnyTune's fusion implementation equals Obicall's native scalar-fusion mathematics. **What it does not claim:** that Obicall transports Hz observations. It doesn't.

### Simulated

- All the pitch AnyTune plays: the demo's input (`src/harness/demo-input.ts`) and the committed pitch recordings (`tests/fixtures/pitch/*.json`, format `anytune-pitch-recording/1`, origin `simulated`). These are AnyTune's own JSON, never `.obr`, and never "produced by Obicall". The page says so: *Input: Recorded — … (simulated data)*.
- `SimulatedPitchFusion` and `RecordedPitchFusion` implement the domain's `PitchFusionPort` with AnyTune's compatibility fusion.

### Blocked by Obicall's current capabilities

Obicall's observation has these units: `UNSPECIFIED`, `METERS`, `METERS_PER_SECOND` and `RADIANS`. Validation rejects `UNSPECIFIED`. Its payload shapes are `POSITION_1D`, `POSITION_2D`, `POSITION_2D_VELOCITY` and `RANGE_1D`. Its broker's estimator is a 2-D constant-velocity position Kalman filter.

**A frequency can't be expressed.** AnyTune won't relabel hertz as metres, metres per second, radians or an unspecified unit to get pitch through validation. So pitch never goes through Obicall today.

### The future native path

`NativeObicallPitchFusion` would be a third implementation of `PitchFusionPort`, used only once Obicall can carry a frequency. The domain, the application, the UI and the browser demo wouldn't change. The smallest extension of Obicall this needs, in Obicall, by its maintainers:

1. **`OBICALL_UNITS_HERTZ`**: a unit for frequency.
2. **A scalar or frequency payload shape**, e.g. `FREQUENCY_1D` (`[hz]`, variance in Hz²).
3. **Validation** that accepts it: a finite, positive frequency and a positive variance, with the unit and shape checked together.
4. **Wire encoding**, which needs no layout change (the payload is already a count and doubles), and its tests.
5. **Journal and replay**, which record it as they record anything. `obicall replay` must then not feed it to the 2-D position filter.
6. **A scalar path in the broker/estimator**: `obicall_static_fuse_1d` already exists and is the mathematics AnyTune shares (above). A 1-D estimator for pitch would add smoothing over time.
7. **Tests**: unit, wire round-trip, journal, and an end-to-end frequency pipeline.
8. **An ABI/version decision**: a new unit and shape extend enumerations the ABI publishes (ABI 1.0 → 1.1 if additive, or a major version if a consumer could misread them).

Then, in AnyTune: a `NativeObicallPitchFusion` adapter outside the browser (a native process or service, since the browser can't load a DLL), a transport to the page, and the same conformance tests against the native answers.
