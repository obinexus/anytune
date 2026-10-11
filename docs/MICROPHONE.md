# The microphone input

AnyTune can listen to a real instrument through the computer's microphone. The microphone is one more pitch provider behind the existing `PitchProvider` contract. The tuning domain, the fusion, the application state and the `.obix` UI are the same ones that play the demo.

```
navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false })
  → AudioContext → MediaStreamAudioSourceNode → AnalyserNode (fftSize 4096; connected to nothing else, so nothing is played)
  → every 50 ms: the latest 4096 samples → the pitch detector (YIN) → PitchObservation { sourceId "microphone", frequencyHz, confidence, varianceHz2, timestampMs }
  → InverseVarianceFusion (the microphone is its only source) → TuningSession → toView → the .obix UI
```

| Where | What |
|---|---|
| `src/audio/pitch-detector.ts` | the detector: **pure**, with samples and a sample rate in, a frequency and a confidence (or nothing) out |
| `src/audio/microphone-provider.ts` | `MicrophonePitchProvider`: capture, frames, lifecycle and failures. It is given the browser's APIs rather than reaching for them. |
| `src/harness/browser-audio.ts` | the one place that names `navigator.mediaDevices`, `isSecureContext` and `AudioContext` |
| `src/harness/compose.ts` | the demo's two inputs: **Microphone**, and **Demo (recorded / simulated)**, which is the default |

## The pitch detector

**Algorithm.** YIN, from A. de Cheveigné and H. Kawahara, "YIN, a fundamental frequency estimator for speech and music", *JASA* 111(4), 2002. It is monophonic and instrument-neutral. It is not "the largest FFT bin".

1. The difference function `d(τ) = Σ_{j<W} (x_j − x_{j+τ})²`, over half the frame, with the frame's mean removed.
2. Its cumulative-mean normalization, `d′(τ) = d(τ) · τ / Σ_{k≤τ} d(k)`.
3. The first dip below the threshold (0.1), taken to its bottom. When none goes below it, the deepest dip is used instead.
4. **The octave check.** The shortest dip whose raw difference is within 10% of the chosen one's is the period. In noise the normalization favours multiples of the period, which would name a note an octave low.
5. **The period to a fraction of a sample**: a least-squares parabola over ±τ/24 samples around the dip.
6. frequency = sample rate / period.

| Parameter | Value |
|---|---|
| frequency range | 40 Hz (below the bass's E1, 41.2 Hz) to 2000 Hz |
| frame | 4096 samples: 85 ms at 48 kHz, 93 ms at 44.1 kHz. Half of it holds the longest period. |
| frame rate | one frame every 50 ms |
| confidence | 1 − d′ at the period, in 0…1. The domain calls a reading *uncertain* below 0.6. |
| silence | RMS below 0.004 (−48 dBFS) after removing the mean: no pitch at all |
| interpolation | least-squares parabola on d(τ), over ±τ/24 samples |

**Measured accuracy**, at 44.1 and 48 kHz, E1 to A5, on tones generated from their mathematics (`tests/audio/pitch-detector.test.ts`):

| Signal | Worst error | Target the tests hold it to |
|---|---|---|
| clean pure tone | 0.5 cent | ±1 cent, a fifth of the domain's ±5-cent window |
| clean harmonic-rich tone (plucked, weak or missing fundamental) | 1.7 cents (guitar: 1.3) | ±2 cents |
| tone in white noise at 20 dB SNR | 2.1 cents | ±2 cents on the guitar's tones |
| white noise alone | confidence ≤ 0.1 | never 0.6 |
| a wrong note named with confidence ≥ 0.6 | none at 10 and 20 dB SNR, under 1 in 100 at 3 and 6 dB | the same |

The domain's ±5-cent in-tune window was not widened for the detector.

**Variance.** The fusion needs a variance for every observation. The microphone's is `(f² / rate)² / 12` Hz², which is what a period known only to the nearest sample implies. It is a documented bound, not an estimate of the detector's error. With the microphone as the only source, it doesn't change the pitch passed on.

## Lifecycle

- **`start()`** first checks what can't work (an insecure page, no `getUserMedia`, no Web Audio) *before* asking for the permission. Then it asks for the microphone. For a tuner, echo cancellation, noise suppression and automatic gain are **preferences, never requirements**: a browser may ignore them, and `mic.info.processing` records what it reports (or `null` where it doesn't say). Next it builds the context and the analyser, resuming a context the browser starts suspended, records the sample rate actually used (`mic.info.sampleRate`), says *listening*, and reads frames.
- **`stop()`** stops the frames, disconnects the nodes, stops every track, closes the context, removes the `ended` listener, and publishes nothing afterwards.
- **Digital silence.** A real microphone always has a noise floor, far above −120 dBFS. So two seconds of samples all below that mean the audio is not arriving; a pause between plucks never looks like this.
  - With raw audio, the provider asks once more with the browser's processing on (`{ audio: true }`), since some laptop microphone arrays give sound only through it. The page then says *…, browser processing on*.
  - Still silent, the state is `microphone-muted`, and the page says so instead of *Listening*.

  This was found on a real laptop: an AMD microphone array in Firefox was opened and "listened" to while every sample was zero (loudest −154 dBFS).
- **Start and stop are idempotent.** Rounds of them leak no track, context, node, timer or listener, and a `stop()` while the permission prompt is open releases whatever is granted afterwards. `tests/audio/microphone-provider.test.ts` checks this on a fake browser that counts what it hands out.

## When it doesn't work

Every failure is a **state**. `start()` never rejects, and the page says what happened in words; no browser exception text reaches it.

| State | When | What the page says |
|---|---|---|
| `insecure-context` | not https, and not localhost | *The microphone works only on a secure page: https, or localhost. Open AnyTune over https to tune with it.* |
| `unsupported` | no `getUserMedia`, or no Web Audio | *This browser cannot give AnyTune the microphone. Use a current Edge, Chrome, Firefox or Safari — or the demo input.* |
| `permission-denied` | `NotAllowedError`, `SecurityError` | *Microphone permission was denied. Allow the microphone to tune.* |
| `no-device` | `NotFoundError`, `OverconstrainedError` | *No microphone was found. Connect one to tune.* |
| `microphone-unavailable` | `NotReadableError`, `AbortError`, anything else | *The microphone could not be opened — another application may be using it. Close it, then start again.* |
| `audio-failed` | the AudioContext can't be made or won't resume | *The browser could not start its audio processing. Start again, or reload the page.* |
| `disconnected` | the track ends: unplugged, or the permission revoked | *The input was disconnected. Start again to tune.* |
| `microphone-muted` | two seconds of **digital silence** (every sample below −120 dBFS), with raw audio *and* with the browser's processing | *The microphone is sending no sound at all — it may be muted. Check the microphone mute key, and your system’s microphone privacy settings (on Windows: Settings → Privacy & security → Microphone → “Let desktop apps access your microphone”). Then start again.* |
| no signal | silence | *No signal* |
| low confidence | a noisy room | *Signal uncertain* |

AnyTune hears **one note at a time**. Several notes at once, such as a strummed chord, can look periodic to the detector and be read as a wrong note *with* confidence. Pluck one string at a time.

The page never falls back from the microphone to the demo while still saying "Microphone". Switching input is the user's choice, and switching while listening stops the microphone first.

## Privacy

> Microphone audio is processed locally for pitch detection. AnyTune does not upload or persist raw microphone audio.

This is what the implementation does. A frame's samples live in one buffer, which each frame overwrites, and they go to the detector and nowhere else. Only the detected frequency and confidence leave the provider, and AnyTune's code sends nothing anywhere: the page makes no requests beyond loading its own files. The page shows this statement whenever the microphone is the input.

## Browsers

- `getUserMedia` needs a **secure context**. `http://localhost` counts, so `npm run dev` works; a deployment needs **HTTPS**.
- The page needs a current Edge, Chrome, Firefox or Safari. Older Safari's `webkitAudioContext` is accepted.
- The first Start asks for permission. A browser remembers the answer per site, and a refusal is changed in the site's settings (the icon by the address).
- Laptop microphones differ. Some ignore the request to switch automatic gain and noise suppression off. `mic.info.processing` records what the browser reports.
- The in-app browser used to develop AnyTune blocks microphone access by design. The failure path was seen working there: a denied permission, said in words.

## What has been seen on real hardware

### Physical guitar validation: PERFORMED in Microsoft Edge

The owner performed it on 2026-09-28, with a nylon-string classical guitar in standard tuning.

| | |
|---|---|
| Browser | Microsoft Edge, `http://localhost:5173/` (`npm run dev`) |
| Device | Default - Microphone Array (AMD Audio Device), 48 kHz |
| Real observation | the D string detected at about **145.1 Hz**, about **20 cents flat** of D3 (146.83 Hz): *FLAT*, *20.2 cents flat*, *Holding steady* |
| Result | AnyTune received and classified a physical guitar through the laptop microphone |

This is one string, one observation. The rest of the procedure below (every open string tuned to *In tune*, compared against another tuner) has not been recorded yet.

### Firefox with this microphone array: not validated

On the same laptop, Firefox opened the same microphone, and its track reported live and running while it delivered **effectively digital-silent PCM**. The owner's measurement of the raw audio: quietest −180 dBFS, loudest −154 dBFS.

AnyTune now:

- detects sustained digital silence (every sample below −120 dBFS for two seconds);
- retries once with the browser's audio processing;
- says which processing mode is active (*…, browser processing on*);
- shows an explicit failure, *The microphone is sending no sound at all…*, if the audio is still silent.

The processed-audio retry in Firefox on this machine was then observed (2026-09-29, on the native runtime — below, "Attempts"): it is **still digitally silent**, and AnyTune said so. Tune in Edge (or Chrome) on this laptop.

### Two silences, kept apart

| | Threshold | What it means | What the page says |
|---|---|---|---|
| **Digital silence** | every sample below −120 dBFS, sustained for 2 s | the audio is not arriving: a device, driver or permission failure | the retry with processing, then *The microphone is sending no sound…* |
| **Musical silence** | frame RMS below −48 dBFS | valid audio with no useful musical signal: the room between notes, or a note too faint | *No signal*, still listening |

Neither is loosened for the other. The YIN detector and its −48 dBFS threshold were not weakened for Firefox's zero-valued stream. `tests/audio/microphone-silence.test.ts` checks both: a −60 dBFS tone gives no pitch and triggers no retry, and a −70 dBFS room is never "muted".

## Practice and Play: "I did not hear 35 notes" — a diagnosis

The owner's attempts (2026-10-11, in a browser on the laptop above) were reviewed as *0 of 35 right*, with every note "not heard". One more
attempt showed *17 of 35 right, 0 on time*. These were browser attempts, so nothing was saved, and the sessions' capture state and event
times **cannot be recovered**. What the code shows is which failure paths existed then, and what has changed since.

| What could have happened | Why it read as "not heard" then | What happens now |
|---|---|---|
| The raw microphone sent **digital silence**: the AMD array did this in Firefox, and practice asked for raw audio | Practice had no silence check and no retry with the browser's processing, unlike the tuner | The input check sees digital silence, asks again with processing on and says so, then says the microphone is muted. Nothing is judged before a note is heard. |
| The guitar reached the microphone **too faintly** | A melody at a −38 dBFS peak gives onsets but no confident pitch, because YIN treats frames below −48 dBFS RMS as silence. Those onsets were dropped. (Measured on the synthetic melody: 13/13 notes at −32 dBFS, 0/13 at −38.) | The input meter shows the level, and the check says "only faintly". An onset whose pitch cannot be named is now *unclear*: never a mistake, and never "not heard". |
| The capture **stalled** or the device ended | Every target without a heard note was judged missed, whether or not the microphone was delivering sound | The capture's coverage is recorded. Targets it did not cover are unassessed, the review says how much was assessed, and with nothing assessed: "This attempt could not be assessed — check your microphone". |
| The microphone heard **the reference through the speakers**, or the browser's latency figure is far from the real delay (the *0 on time* attempt) | Notes judged right in pitch but consistently off in time | Not fixed: there is no calibration. The review gives the typical offset, and the timing details show the browser's figures as estimates. Headphones are advised. |

Every assessed review now ends with what the microphone delivered: when audio arrived, how much was sound, the loudest level, and any
silence, gap or disconnection. So a review like *0 of 35* can now be diagnosed from the attempt itself.

## Tuning a guitar with the microphone: the manual acceptance test

**Status:** performed in Edge for one string (above); the full procedure has not been recorded yet. The automated tests use generated signals. This is the procedure for a person with a guitar.

1. `cd D:\Projects\anytune`, then `npm run dev`.
2. Open the address it prints (`http://localhost:5173/`) in Edge or Chrome.
3. Instrument: **Standard Guitar**.
4. Input: **Microphone**. The page says *Input: Microphone — your microphone, once Start is pressed*, with the privacy statement below it.
5. Optionally, press **Details** now to show the confidence while tuning.
6. Press **Start tuning**, and allow the microphone when the browser asks. The page now names the microphone and its sample rate, and says *Listening*.
7. Put the computer down within a metre of the guitar, in a quiet room. Pluck one open string at a time and let it ring.
8. For each string, check that the page names it and shows its frequency, the cents off and the status, and that these follow the peg as you turn it, with no other press:

   | String | Target |
   |---|---|
   | 6th, low E | E2 ≈ 82.41 Hz |
   | 5th | A2 = 110.00 Hz |
   | 4th | D3 ≈ 146.83 Hz |
   | 3rd | G3 = 196.00 Hz |
   | 2nd | B3 ≈ 246.94 Hz |
   | 1st, high E | E4 ≈ 329.63 Hz |

   The status reads *Flat* below −5 cents, *In tune* within ±5, and *Sharp* above +5. *Holding steady* appears when two readings agree within 3 cents.
9. Record for each string: the note named, the frequency shown when in tune, whether *In tune* and *Holding steady* appeared, and anything wrong, such as the wrong string named, an octave off, or *Signal uncertain* while it rang clearly.
10. Press **Stop**. The browser's microphone indicator should go out.

A comparison against another tuner (a clip-on, or a phone app) on the same string is the best check of the cents.

## On OBIX's native runtime (Phase 6)

The same microphone path runs on OBIX's native runtime (`npm run dev:native`): the provider, the session and the page are the same, only the runtime that draws the page differs. It is tested on generated signals through the fake browser, on both runtimes, and the two pages are compared (`tests/integration/microphone.test.ts`, `tests/native/vue-vs-native.test.ts`); in the in-app browser, which blocks the microphone, the native page shows the permission alert. **A physical instrument through the microphone on the native runtime has not been tried**: the physical reading above was on the Vue runtime.

### The manual native acceptance test (Phase 6.1) — NOT YET PERFORMED

```
PHYSICAL_NATIVE_MICROPHONE_VALIDATION = NOT_PERFORMED
```

This is the one Phase 6.1 acceptance item still open. Only the owner can perform it, and nothing claims it until they have: the automated checks (generated signals through the fake
browser, the recorded demo on `dev:native` reaching A2 in tune) are **not** a physical microphone result and are never counted as one.

**The command** (from the AnyTune folder):

```
cd D:\Projects\anytune
npm run dev:native
```

`npm run dev:native` — not `npm run dev`, which is the Vue runtime, the default. Vite prints the local address (`http://localhost:<port>/`; the port is whichever is free).

**The procedure:**

1. Open the printed `localhost` address in **Microsoft Edge** (localhost counts as a secure page, so the microphone is allowed).
2. Instrument: **Standard Guitar**. Input: **Microphone**. Press **Start tuning** and allow the microphone when Edge asks.
3. Pluck at least **one real open string** of the guitar; if possible, all six (targets: E2 ≈ 82.41 Hz, A2 = 110.00 Hz, D3 ≈ 146.83 Hz, G3 = 196.00 Hz, B3 ≈ 246.94 Hz,
   E4 ≈ 329.63 Hz), turning the peg to see *Flat* / *In tune* / *Sharp* and *Holding steady* follow it with no other press.
4. Press **Stop**; Edge's microphone indicator should go out.

**What to record, per string:**

| Field | Where it is read |
|---|---|
| browser | Edge's version (`edge://version`) |
| instrument | the Instrument select — must be *Standard Guitar* |
| input | the Input select — must be *Microphone* |
| detected frequency | the frequency under the note (e.g. `145.1 Hz`) |
| target frequency | the string's target above, for the note AnyTune named |
| cents | the cents line (e.g. `20.2 cents` flat) |
| tuning state | *Flat* / *In tune* / *Sharp*, and whether *Holding steady* appeared |
| microphone status | the listening line (*Listening*), and the Details line `Input: Microphone — <device name>` |
| runtime = native | the command was `npm run dev:native`, and Edge's developer tools (Sources, or Network filtered to JS) list the `obix-runtime-*` modules and **no `vue` module** |

**The acceptance criteria.** The result is a pass only if all of these hold:

- the input is the **microphone**: the Details line reads `Input: Microphone — <device name>` and the listening line reads *Listening* — never `Input: Recorded — …` or
  `Input: Simulated — …`, and never *Recording ended*;
- the reading **follows the string**: plucking a different string, or turning the peg, changes the note, frequency and cents; the frequency is plausible for the string plucked
  (the note named is the string's note, within the tuner's range of cents);
- it is **distinguishable from the recorded demo**: the demo input replays a fixed script — A2 at 108, 109, 110, 110 Hz, ending on exactly `110.0 Hz`, `0.0 cents`, *Recording
  ended* — and cannot change when a string is plucked; a physical reading does;
- the runtime is **native**: `npm run dev:native`, no `vue` module on the page;
- **Stop** releases the microphone.

A failure (no reading, a wrong note, an error message) is recorded as it is seen, with the words the page shows, and is not a pass.

**Attempts** (each recorded as seen; none is a pass):

| Date | Browser | Runtime | Instrument · input · device | What the page showed | Result |
|---|---|---|---|---|---|
| 2026-09-29 | **Firefox** | native (`vite --mode native`, `localhost:5173`) | Standard Guitar · Microphone · *Default - Microphone Array (AMD Audio Device), 48 kHz* | *Listening*, *Input connected*, `— Hz`, *NO SIGNAL*; then the alert *The microphone is sending no sound at all — it may be muted…* | **complete digital silence; no frequency detected; not a pass** |

The Firefox attempt is an observation about Firefox with this microphone array, not a result for the native runtime either way: the same array gave Firefox digital silence on
the Vue runtime too (above), and the alert is shown only after the retry with the browser's processing was silent as well. The test the checkpoint asks for is in **Microsoft
Edge**, on the native runtime; it has not been performed.

Until the owner reports the result, this stays `PHYSICAL_NATIVE_MICROPHONE_VALIDATION = NOT_PERFORMED`. The one physical reading so far (above) was on the **Vue** runtime.
