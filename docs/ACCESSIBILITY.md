# Accessibility

A tuner is used hands-free, often by someone looking at the instrument rather than the screen. AnyTune is designed to be usable without seeing it: every state is in words, and screen-reader users hear what changed, but only what matters.

## What the page is

- **Semantics.** One `main` landmark with its heading. The detected frequency is an `output`. The tuning meter is a `meter` whose value is the cents off the target, with its value also in words (`aria-valuetext`).
- **Not colour alone.** Every tuning status (*Flat*, *In tune*, *Sharp*, *Signal uncertain*, *No signal*) is a word on the page. The colour of the stylesheet follows it; it doesn't replace it.
- **Keyboard.** Every control is a native, focusable, labelled control: the instrument select, the input select (*Input*: Microphone or Demo), Start/Stop, and the Details toggle. No positive `tabindex`. The Details toggle says whether it is open (`aria-expanded`).
- **Errors** are an `alert`, in words: a microphone refused, missing, busy, disconnected, unsupported or on an insecure page; audio that can't start; an unsupported instrument. The words are in `docs/MICROPHONE.md`.
- **Hands-free with a microphone.** After one press of Start, tuning needs no further interaction: the reading follows the string, and the live region speaks at most once a second, whatever the microphone's frame rate.
- **The input is stated.** *Input: Simulated — …*, *Input: Recorded — … (simulated data)*, or later *Input: Microphone — …*, so that no one mistakes a demonstration for their instrument being heard.

## What is announced, and when

One polite live region (`role="status"`), present and empty from the first render. It says only what the **announcement policy** (`src/app/announcer.ts`) decides:

- It speaks when something a listener needs changes: the note, the tuning status, steadiness, the signal, the session.
- It speaks **at most once a second**, and never says the same thing twice in a row.
- A change inside the interval waits for the interval to end and is then announced as its latest state, or not at all if it came back to what was said.
- The cents moving within one status say nothing new. Losing the signal, or becoming uncertain, is said once. Stopping cancels what was waiting.

In words, when the acceptance sequence (108, 109, 110, 110 Hz, 250 ms apart) plays after Start, the live region says *Listening. Play a note.* Then, since all four readings arrive within that same second, it says only their latest state when the second is over: *A2, in tune and steady*. The visual meter shows every reading; the voice doesn't chatter. Heard on its own, the same sequence is announced *A2, 32 cents flat* at once, then *A2, in tune and steady* (`tests/app/announcer.test.ts`).

## How it is tested

- `tests/app/announcer.test.ts`: the policy in virtual time.
- `tests/components/a11y.test.ts`, on the real Vue runtime in jsdom:
  - the live region, and the hands-free announcements played live;
  - the semantics, words as well as colour, the keyboard, and errors as alerts;
  - **axe-core** (automated) finds no violation in four states: idle, listening flat, in tune and steady with the details open, and in error.
- `tests/components/ui.test.ts`: every status and the input are in words.

Automated checks don't replace testing with a screen reader and a real person. That has not been done yet, and it is listed in the remaining work (README).
