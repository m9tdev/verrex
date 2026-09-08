# Changelog

## [0.2.0](https://github.com/m9tdev/verrex/compare/ts-plugin-v0.1.0...ts-plugin-v0.2.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* reactivity API rewrite — atom/fn/get/For/On/Catch replace Async/asyncRef/streamRef/list/h.track/h.read/VerrexLive and the .value compiler rewrites. Rationale in packages/core/src/runtime/AGENTS.md (Reactivity model).

### Features

* reactivity migration — effect-atom API with caller-owned R/E ([#195](https://github.com/m9tdev/verrex/issues/195)) ([9e16f86](https://github.com/m9tdev/verrex/commit/9e16f86ebf1257bfeea80cdf61d4ba85a06f61b5))


### Bug Fixes

* **deps:** bump effect to 4.0.0-beta.98 ([#149](https://github.com/m9tdev/verrex/issues/149)) ([5b85faf](https://github.com/m9tdev/verrex/commit/5b85fafaa47e5fd8b439f0b39b319568870046e9))
* suppress Component.make's name-slot inlay hint in .vx files ([#113](https://github.com/m9tdev/verrex/issues/113)) ([26ea8b3](https://github.com/m9tdev/verrex/commit/26ea8b364423a3a689222542b0f8641c6cc7d479))
