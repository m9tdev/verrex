# Changelog

## [0.4.0](https://github.com/m9tdev/verrex/compare/core-v0.3.0...core-v0.4.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* reactivity API rewrite — atom/fn/get/For/On/Catch replace Async/asyncRef/streamRef/list/h.track/h.read/VerrexLive and the .value compiler rewrites. Rationale in packages/core/src/runtime/AGENTS.md (Reactivity model).
* **runtime:** mount owns its AtomRegistry ([#167](https://github.com/m9tdev/verrex/issues/167)) mount's R used to REQUIRE AtomRegistry without being able to express that it must OUTLIVE the mount effect — so the natural `mount(...).pipe(Effect.provide(VerrexLive))` type-checked, disposed the registry the moment the DOM attached, and silently froze the live UI. The type system could not encode the lifetime requirement, so this deletes the requirement instead: - mount creates its own registry, provides it to the app effect (a component's `yield* AtomRegistry` resolves to it), and discharges it from the app's R via Exclude - disposal is a finalizer registered BEFORE buildDom, so LIFO scope close detaches the DOM and tears down child subscriptions against a still-live registry, disposing it last — the UI and its reactivity always die together - the footgun shape is now a no-op (VerrexLive is deprecated, kept as a compat layer); the disposed-registry error rewrite goes away with the failure mode it guarded Pins: registry-lifetime.test.ts (no provision needed; footgun shape stays reactive; yield* resolves to mount's live registry; scope close detaches DOM and disposes the registry together — all four fail under the old shape) plus a channels.test-d.ts assertion that mount discharges AtomRegistry from R. BREAKING CHANGE: mount no longer accepts an externally provided AtomRegistry. `Effect.provide(VerrexLive)` around mount is now harmless but unused; VerrexLive is deprecated and will be removed in a future release. (#173)

### Features

* reactivity migration — effect-atom API with caller-owned R/E ([#195](https://github.com/m9tdev/verrex/issues/195)) ([9e16f86](https://github.com/m9tdev/verrex/commit/9e16f86ebf1257bfeea80cdf61d4ba85a06f61b5))
* **runtime,testing:** RootSink reference + ui.sinkCauses; handler interrupts reach the sink ([#191](https://github.com/m9tdev/verrex/issues/191)) ([59ea302](https://github.com/m9tdev/verrex/commit/59ea30207c030856c4b9f272a8eb2328e0fb1bed))
* **runtime:** streamRef — asyncRef's push sibling for Stream ([#124](https://github.com/m9tdev/verrex/issues/124)) ([3b66e29](https://github.com/m9tdev/verrex/commit/3b66e296e651470906c70888379689c3d201ad48))


### Bug Fixes

* **runtime:** fold Async arm / Catch fallback R onto the boundary ([#120](https://github.com/m9tdev/verrex/issues/120)) ([#192](https://github.com/m9tdev/verrex/issues/192)) ([541f549](https://github.com/m9tdev/verrex/commit/541f5490a1310bb37606990cc07795a6185722ec))
* **runtime:** per-dispatch handler scope owned by the constructing node ([#185](https://github.com/m9tdev/verrex/issues/185)) ([79a0fac](https://github.com/m9tdev/verrex/commit/79a0fac59b894eaed68615132e637b8564697b93))
* **runtime:** report reader re-render throws to the root sink ([#203](https://github.com/m9tdev/verrex/issues/203)) ([59ec94b](https://github.com/m9tdev/verrex/commit/59ec94bf5c628364af2e5a627680ae302a8aa168))


### Code Refactoring

* **runtime:** mount owns its AtomRegistry ([#167](https://github.com/m9tdev/verrex/issues/167)) mount's R used to REQUIRE AtomRegistry without being able to express that it must OUTLIVE the mount effect — so the natural `mount(...).pipe(Effect.provide(VerrexLive))` type-checked, disposed the registry the moment the DOM attached, and silently froze the live UI. The type system could not encode the lifetime requirement, so this deletes the requirement instead: - mount creates its own registry, provides it to the app effect (a component's `yield* AtomRegistry` resolves to it), and discharges it from the app's R via Exclude - disposal is a finalizer registered BEFORE buildDom, so LIFO scope close detaches the DOM and tears down child subscriptions against a still-live registry, disposing it last — the UI and its reactivity always die together - the footgun shape is now a no-op (VerrexLive is deprecated, kept as a compat layer); the disposed-registry error rewrite goes away with the failure mode it guarded Pins: registry-lifetime.test.ts (no provision needed; footgun shape stays reactive; yield* resolves to mount's live registry; scope close detaches DOM and disposes the registry together — all four fail under the old shape) plus a channels.test-d.ts assertion that mount discharges AtomRegistry from R. BREAKING CHANGE: mount no longer accepts an externally provided AtomRegistry. `Effect.provide(VerrexLive)` around mount is now harmless but unused; VerrexLive is deprecated and will be removed in a future release. ([#173](https://github.com/m9tdev/verrex/issues/173)) ([2436294](https://github.com/m9tdev/verrex/commit/2436294428412fea0715c0e5fd31943963e0efd9))

## [0.3.0](https://github.com/m9tdev/verrex/compare/core-v0.2.0...core-v0.3.0) (2026-07-20)


### ⚠ BREAKING CHANGES

* **runtime:** the `AtomRegistry` must now OUTLIVE the mount's `Scope`. `h.track` deriveds live in the registry, so disposing it severs every live subscription. `mount(app, el).pipe(Effect.provide(VerrexLive))` is now wrong — it scopes the layer to the mount effect, which completes as soon as the DOM attaches, and the UI renders once then silently stops updating. Build the layer into a longer-lived scope instead (`Layer.build` under `Scope.provide`); the README shows the shape. This requirement is not expressible in `mount`'s type today — `R` says the registry is required, not that it must outlive the scope — so the broken form still type-checks and fails at runtime. Tracked in #167.
* **runtime:** an app whose event handler returns a failing or service-requiring Effect no longer compiles until the error meets a `Catch` or the Layer is provided at the root. The runtime sink still contains untyped failures.
* **compiler:** lower component tags to direct calls — generics survive, Tag* folds die ([#104](https://github.com/m9tdev/verrex/issues/104))

### Features

* **check:** --watch, severity flags, colored summary (astro-check parity) ([#97](https://github.com/m9tdev/verrex/issues/97)) ([49e13e0](https://github.com/m9tdev/verrex/commit/49e13e0aef36af28175d850ce62268dbefa5db79)), closes [#78](https://github.com/m9tdev/verrex/issues/78)
* **compiler:** lower component tags to direct calls — generics survive, Tag* folds die ([#104](https://github.com/m9tdev/verrex/issues/104)) ([898d1eb](https://github.com/m9tdev/verrex/commit/898d1ebe840c25ec49380a4b67aba9af72fc92f9)), closes [#71](https://github.com/m9tdev/verrex/issues/71)
* **runtime:** Async without failure arm puts E on the live channel ([#86](https://github.com/m9tdev/verrex/issues/86)) ([9e81c7f](https://github.com/m9tdev/verrex/commit/9e81c7f45e375280ad4c1da56f6872da8cdaab3a)), closes [#73](https://github.com/m9tdev/verrex/issues/73)
* **runtime:** AsyncHandle — public refetch for asyncRef, Async accepts handles ([#101](https://github.com/m9tdev/verrex/issues/101)) ([8156fc1](https://github.com/m9tdev/verrex/commit/8156fc1ca8116c4d7aad6164f4a0527157b3ca41))
* **runtime:** Component.make — the canonical component constructor ([#103](https://github.com/m9tdev/verrex/issues/103)) ([8b42741](https://github.com/m9tdev/verrex/commit/8b42741d57980abcd070a50a5abfd5ceb653d2fb)), closes [#70](https://github.com/m9tdev/verrex/issues/70)
* **runtime:** retry callback for Async failure arms ([#95](https://github.com/m9tdev/verrex/issues/95)) ([f30431c](https://github.com/m9tdev/verrex/commit/f30431c67766c72208eb39ab9111c5580d3b52cf))
* **runtime:** tag-selective failure arm for Async (mirrors Catch's tag map) ([#88](https://github.com/m9tdev/verrex/issues/88)) ([1f61c66](https://github.com/m9tdev/verrex/commit/1f61c66000608b00c839cf1035884ed1c1b79a69))
* **runtime:** typed event handlers — fold handler E onto View&lt;E&gt;, R into the element ([#110](https://github.com/m9tdev/verrex/issues/110)) ([e7a0577](https://github.com/m9tdev/verrex/commit/e7a057781f2f73ef26b0213d4981acc589a81940))


### Bug Fixes

* **deps:** bump effect to 4.0.0-beta.98 ([#149](https://github.com/m9tdev/verrex/issues/149)) ([5b85faf](https://github.com/m9tdev/verrex/commit/5b85fafaa47e5fd8b439f0b39b319568870046e9))
* **deps:** upgrade Babel to 8 (coordinated family bump) ([#150](https://github.com/m9tdev/verrex/issues/150)) ([2404da1](https://github.com/m9tdev/verrex/commit/2404da19e5d678d8bd1f70f11eab1e9f7cd575b6))
* **language:** survive unparseable mid-edit .vx source ([#102](https://github.com/m9tdev/verrex/issues/102)) ([7529433](https://github.com/m9tdev/verrex/commit/7529433b09bcf5813e0c931a98d20b7db9525cf7))
* **runtime:** form-control props as DOM properties, remove attrs on falsy ([#155](https://github.com/m9tdev/verrex/issues/155)) ([ab8ade8](https://github.com/m9tdev/verrex/commit/ab8ade859fee151ecf47e68678eeeed9f54c8c85))
* **runtime:** reject undispatched tag-map shapes at construction ([#94](https://github.com/m9tdev/verrex/issues/94)) ([d2654ab](https://github.com/m9tdev/verrex/commit/d2654abf6bf7ecfab1eeb16ec313a076403b47e1))
* **runtime:** tear down h.track derived subscriptions on subtree unmount ([#136](https://github.com/m9tdev/verrex/issues/136)) ([ca2825d](https://github.com/m9tdev/verrex/commit/ca2825d71428915a18fa4f7da3f9e7ae0d1c45b7))
* suppress Component.make's name-slot inlay hint in .vx files ([#113](https://github.com/m9tdev/verrex/issues/113)) ([26ea8b3](https://github.com/m9tdev/verrex/commit/26ea8b364423a3a689222542b0f8641c6cc7d479))


### Code Refactoring

* **runtime:** h.track deriveds become demand-driven registry-owned Atoms ([#153](https://github.com/m9tdev/verrex/issues/153)) ([e1942d0](https://github.com/m9tdev/verrex/commit/e1942d0a79fa0d7d4651db995170af602b3acad9))

## [0.2.0](https://github.com/m9tdev/verrex/compare/core-v0.1.0...core-v0.2.0) (2026-06-10)


### ⚠ BREAKING CHANGES

* **core:** mount requires Effect<View<never>, never, R> — every construction and live error must be discharged before mounting.
* **core:** `Await` is removed — use `Async` / `asyncRef`.
* **core:** list()'s render index is now AtomRef.ReadonlyRef<number> (read index.value); it updates on reorder/shift without re-rendering the row.

### Features

* **core:** extract pure keyed-list reconciler; make list index reactive ([#55](https://github.com/m9tdev/verrex/issues/55)) ([8e8c1e9](https://github.com/m9tdev/verrex/commit/8e8c1e96c67c1f9b3f7fdec6f3cf3a5becb28629))
* **core:** replace Await with Async + asyncRef (errors-as-values) ([618e85a](https://github.com/m9tdev/verrex/commit/618e85a08889f37cc83d2f7f912e73d8835d413f))
* **core:** typed error boundaries (Catch) + View&lt;E&gt; mount gate ([4d2d737](https://github.com/m9tdev/verrex/commit/4d2d73794747e11bc77ca2d06421076642051164))
