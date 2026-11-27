# Changelog

All notable changes to Kaswin are documented in this file.

## Contract Profile Compatibility Policy

Every GitHub Release explicitly lists all **compatible contract profiles** compiled into that build.
When a release **adds, changes, or drops** any compatible contract profile:

1. The release entry below **must** include a `Contract Profile Changes` section documenting the old and new 64-hex Profile IDs and backward-compatibility impact.
2. GitHub Actions (`release.yml`) automatically diffs `compatibleProfiles` against the previous `v*` tag and blocks publication if a profile change is not documented in this file.
3. Rounds created under older/incompatible profiles remain read-only under **Incompatible rounds** in newer builds; to settle or operate historical rounds on an older profile, use the matching historical Release artifact.

---

## [v0.1.3.7] - 2026-11-27

### Compatible Contract Profiles

| Protocol | Asset | Contract Profile ID | Notes |
|---|---|---|---|
| `rolling-v1` | `KAS` / `TKAS` | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` | Unchanged |
| `kusdt-v2` | `kUSDT` (KCC-20) | `39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445` | Unchanged from `v0.1.3.2` (token `50b3477e…1513fd3`) |

### Changed
- **Brand & PWA icons**: Replaced the Kaswin header logo, `favicon`, `apple-touch-icon`, and dynamic PWA manifest icons with the new mint-green ticket + gold `K` emblem (`docs/images/kaswin-icon.svg` and `docs/images/kaswin-icon.png`, scaled to 1.6× / ~90% width), and fixed the `512x512` manifest icon reference.

---

## [v0.1.3.6] - 2026-11-26

### Compatible Contract Profiles

| Protocol | Asset | Contract Profile ID | Notes |
|---|---|---|---|
| `rolling-v1` | `KAS` / `TKAS` | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` | Unchanged |
| `kusdt-v2` | `kUSDT` (KCC-20) | `39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445` | Unchanged from `v0.1.3.2` (token `50b3477e…1513fd3`) |

### Changed
- **Documentation**: Removed stale `UNVALIDATED` labels across `README.md`, `README.zh-CN.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, and `contracts/README.md`; added `docs/REVIEW-V0.1.3.1-20261124.md` and `docs/V3-RESEARCH-NOTES.md`.
- **Redteam baseline**: Added `tests/redteam/kusdt-v2-baseline.mjs` exporting `kaspa-redteam/baseline/1` suites for all 7 `kusdt-v2` contracts.

---

## [v0.1.3.5] - 2026-11-25

### Compatible Contract Profiles

| Protocol | Asset | Contract Profile ID | Notes |
|---|---|---|---|
| `rolling-v1` | `KAS` / `TKAS` | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` | Unchanged |
| `kusdt-v2` | `kUSDT` (KCC-20) | `39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445` | Unchanged from `v0.1.3.2` (token `50b3477e…1513fd3`) |

### Changed
- **Mobile navigation & compact plaza**: Moved mobile `Explore / Create / Mine / Settings` and theme toggle into a top-right dropdown menu, removed the floating bottom bar and top help icon (keeping **How it works** in the footer), and collapsed the plaza controls into a single compact row (`Live / Ended / Starred` + collapsible search + refresh).
- **Wallet header & Create duration**: Displayed connected wallet balance as a compact two-decimal pill (`bigint`-formatted, no truncated address clutter) and added `Min / Hr / Day` unit selection for custom draw durations.
- **Round detail polish**: Styled starred state with a filled gold star, gave the round hero KPI/stepper more breathing room with a concise single-line close countdown, and removed nested double-card padding in the action panel.
- **Public build & repository hygiene**: Replaced hardcoded staging build flags/URLs and absolute local paths across source, build scripts, tests, and docs with generic build-time/environment configuration; added `win.kaspay.top` to README.

---

## [v0.1.3.4] - 2026-11-25

### Compatible Contract Profiles

| Protocol | Asset | Contract Profile ID | Notes |
|---|---|---|---|
| `rolling-v1` | `KAS` / `TKAS` | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` | Unchanged |
| `kusdt-v2` | `kUSDT` (KCC-20) | `39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445` | Unchanged from `v0.1.3.2` (token `50b3477e…1513fd3`) |

### Changed
- **ProtocolPlugin architecture & decoupled i18n**: Decoupled `web/` from covenant-specific code via build-time `@kaswin/protocol-bundles`, unified `ProtocolPlugin` / `ProtocolAdapter` interfaces, and structured `web/ui/locales/` (`zh-CN` / `en`) schema.
- **Simplified consumer raffle UI**: Streamlined top navigation (`Explore / Create / Mine`), moved How-it-works to a modal and removed the legacy budget SVG, simplified plaza cards and single-column Create flow (1h / 24h / Custom presets; 1 / 10 ticket quick pills), compacted the round hero KPI bar, and streamlined detail tabs to `Info` (default) + `Pixel wall`.
- **Parallel-shard smart buy & congestion handling**: Switched default kUSDT v2 buy routing to random open-shard selection with automatic UTXO-conflict failover, 3-strike congestion prompt (when active shards `< 8`), and a collapsed **Advanced options** shard selector.
- **Faster transaction preparation**: Parallelized `kusdt-v2` prepare I/O (`Promise.all` + batched node UTXO verification), added 15s wallet KCC-20 candidate prefetch/caching and 5s node fee-rate caching without relaxing on-chain verification.
- **Draw verification & live countdowns**: Enabled two-stage sealed draw countdowns and live 1s sales countdowns across all protocols; added collapsible **Verify draw** in round Info with local BLAKE2b-256 recomputation and a one-click zero-dependency Python 3 verification script.

---

## [v0.1.3.3] - 2026-11-24

### Compatible Contract Profiles

| Protocol | Asset | Contract Profile ID | Notes |
|---|---|---|---|
| `rolling-v1` | `KAS` / `TKAS` | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` | Unchanged |
| `kusdt-v2` | `kUSDT` (KCC-20) | `39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445` | Unchanged from `v0.1.3.2` (token `50b3477e…1513fd3`) |

### Changed
- **Profile isolation & incompatible rounds**: Verify `kusdt-v2` canonical genesis root / template match on stored rounds (`matchesProfile`) to prevent legacy-profile rounds from polluting active plaza lists; group legacy / incompatible-profile rounds into a low-profile **Incompatible rounds** collapsible section at the bottom of the plaza.
- **Profile transparency**: Display full 64-hex compatible contract Profiles (with one-click copy and GitHub Releases link) on the Rules page and footer; show each round's contract protocol and Profile ID in round details, and show full 64-hex Profile + copy button + GitHub Releases lookup link on incompatible round detail pages.
- **Indexer Profile coverage check**: Validate KCI `/info.profiles` and per-round `protocolId`/`profileId`, surfacing coverage status in Advanced settings and warning in the plaza when a connected indexer does not cover all active Profiles.
- **Branding**: Simplify browser tab title, header brand, footer, PWA manifest, and Kaspire wallet metadata to `Kaswin`.
- **Build & Release**: Record `compatibleProfiles` in `build-manifest.json`; update `.github/workflows/release.yml` to publish all compatible profiles, include matching `CHANGELOG.md` notes, and enforce changelog documentation whenever compatible profiles change.

---

## [v0.1.3.2] - 2026-11-24

### ⚠️ Contract Profile Changes (Breaking for `kusdt-v2`)

- **`kusdt-v2` Profile upgraded (incompatible with `v0.1.3.1` rounds)**:
  - Old (`v0.1.3.1`): `559e67acf808e5d48283421e01ac7dc3134d91109f09ac1257324fa85feb8f2a`
  - New (`v0.1.3.2`): `39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445`
  - Reason: canonical genesis root verification, covenant template updates, and audit fixes. Rounds created under `559e67ac…` cannot be operated in `v0.1.3.2+`; use Release `v0.1.3.1` if needed.
- **`rolling-v1` Profile**: unchanged (`b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`).

### Compatible Contract Profiles

| Protocol | Asset | Contract Profile ID |
|---|---|---|
| `rolling-v1` | `KAS` / `TKAS` | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` |
| `kusdt-v2` | `kUSDT` (KCC-20) | `39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445` |

### Fixed
- Enforce canonical `kusdt-v2` genesis root verification, submission fence, terminal guards, and security audit fixes.

---

## [v0.1.3.1] - 2026-11-23

### Contract Profile Changes

- **Added `kusdt-v2`**: `559e67acf808e5d48283421e01ac7dc3134d91109f09ac1257324fa85feb8f2a` (KCC-20 kUSDT parallel-shard rounds).
- **`rolling-v1` Profile**: unchanged (`b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`).

### Compatible Contract Profiles

| Protocol | Asset | Contract Profile ID |
|---|---|---|
| `rolling-v1` | `KAS` / `TKAS` | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` |
| `kusdt-v2` | `kUSDT` (KCC-20) | `559e67acf808e5d48283421e01ac7dc3134d91109f09ac1257324fa85feb8f2a` |

### Added
- Parallel-shard `kUSDT v2` round creation, buying, drawing, payout/refund settlement, unified UI, confirmation breakdown, and i18n.

---

## [v0.1.0] – [v0.1.2.5]

### Compatible Contract Profiles

| Protocol | Asset | Contract Profile ID |
|---|---|---|
| `rolling-v1` | `KAS` / `TKAS` | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` |

- Initial Rolling v1 sharded KAS covenant release, dual-network switch (Mainnet default + Testnet 10), Kaspire WalletConnect v2 support, terminal shard history preservation, and UI/i18n refinements.
