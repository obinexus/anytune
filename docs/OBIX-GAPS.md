# What the OBIX IR does not express yet, and how AnyTune's screens are written around it

AnyTune's UI runs on two runtimes from the same `.obix` files: the official Vue runtime, and OBIX's native runtime, which runs each component's
canonical IR (`obix-dop-ir/3`). A component the IR cannot express is still compiled for Vue, but the lowering marks it **deferred**, and the native
runtime cannot run it. CONTRIBUTING says not to work around the compiler in secret. So this page lists every IR limit the journey's shell
(`AnyTuneShell` and its screens) was written around.

The pipeline is the `obix-compiler-*` packages at 0.5.0, as `package-lock.json` pins them. Each limit was reproduced with a minimal component
through `tools/obix/trace.ts` (`traceComponent`). The diagnostics below are the lowering's own words. In every case the Vue frontend compiled
the component without a diagnostic: these are limits of the IR, not of the Vue path.

| Written | Lowering's diagnostic | What AnyTune's components do instead |
| --- | --- | --- |
| A prop typed by a named type: `defineProps<{ song: Song }>()`, including an imported type such as `HomeView` | `OBIX_DOP_DEFERRED_PROP`: the type `Song` is not one the IR names | Each prop's type is written inline as an object-literal type (`AnyTuneShell`, `PracticeScreen`, …). It is longer, and the view types in `src/app/*-view.ts` must be kept in step by hand. `tests/components/shell.test.ts` renders every screen on both runtimes to catch a mismatch. |
| An indexed type: `View['title']` | `OBIX_DOP_DEFERRED_PROP`: the type `TSIndexedAccessType` is not one the IR names | As above. |
| A bound `class`: `:class="{ current: current }"` | `OBIX_DOP_DEFERRED_BINDING`: a bound `class` is normalized by Vue at run time…: the IR has no class value yet | State is shown as a `data-*` attribute that the stylesheet selects on (`data-kind`, `data-hand`, `data-phase`), and as `aria-current` on the navigation. |
| A bound `style`: `:style="s.left"` | `OBIX_DOP_DEFERRED_BINDING`: `style` is normalized by Vue at run time into an object: the IR has no style value yet | Anything placed by computed coordinates (the Play timeline, the fretboard, the guitar's markers) is SVG, with each coordinate a bound attribute (`:x`, `:cx`, `:width`, `:transform`). |
| A local declaration in an action: `const v = …; emit('pick', v)` | `OBIX_DOP_DEFERRED_STATEMENT`: a declaration inside an action is not lowered yet (and `OBIX_DOP_DEFERRED_REFERENCE` for its use) | Each action is one `emit` of an expression. |
| An `if` in an action | `OBIX_DOP_DEFERRED_STATEMENT`: an `if` statement is not lowered yet | One event per control. The decision is made in TypeScript (`src/harness/shell-app.ts`), not in the component. |
| A call other than the IR's intrinsics: `String(Date.now())` | `OBIX_DOP_DEFERRED_EXPRESSION`: a call is not lowered yet: the IR calls only its intrinsic functions — Math.round | Every value shown is formatted in the view (`src/app/practice-view.ts`, `src/app/shell.ts`), and the components only bind it. This is the layering CONTRIBUTING asks for anyway. |
| An event payload of type `File` | `OBIX_DOP_DEFERRED_SCRIPT`: the type `File` is not one the IR names | The file inputs (`#midi-file`, `#obr-file`) emit with no payload. The harness reads the chosen file from the input by its id (`readFile` in `src/harness/main.ts`). |
| An event payload of type `Event` | `OBIX_DOP_DEFERRED_SCRIPT`: the type `Event` is not one the IR names | As above. A `<select>`'s value is emitted as a string, read from `event.target` inside the handler, which the IR does lower. |

With these choices, all 20 components lower with no diagnostic. `tests/obix/trace.test.ts` asserts this, so a component that regresses to
deferred fails the tests.

## Not reported upstream

These limits have not been filed with OBIX. Filing them means publishing to the OBIX project, which needs the owner's go-ahead. The minimal
reproductions are the table's left column, each a complete `.obix` file of under ten lines.
