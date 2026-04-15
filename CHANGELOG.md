# Changelog

All notable changes to the Airline Manager 4 Bot will be documented in this file.

## [1.2.1] - 2026-04-15
### Added
- **Label-Based Pricing Safety**: The bot now reads seat class labels (Economy, Business, etc.) before setting prices to ensure 100% accuracy even if the game UI shifts.
- **Zero-Idle Campaigns**: Replaced remaining sleeps in marketing logic with dynamic wait signals.

### Fixed
- **IDE Problems Resolved**: Updated `tsconfig.json` with DOM and ESNext libraries to clear persistent "4 Problems" in VS Code.

## [1.2.0] - 2026-04-15
### Added
- **Atomic Persistence**: Implemented `atomicWriteFileSync` in `GeneralUtils` to prevent file corruption during crashes.
- **Smart UI Interaction**: Replaced hard coded `sleep` delays with dynamic `waitForSelector` and `waitForLoadState` signals across all utilities.
- **Hardened Maintenance Logic**: Added "all snapshots" to bulk check iteration to prevent "Element Detached" errors.
- **Dependency Pinning**: Pinned all NPM dependencies to exact versions for build reproducibility.

### Changed
- Refined `playwright.yml` and `fuel-monitor.yml` indentation to clear IDE linting warnings.
- Improved `FleetUtils.departPlanes` loop with better resource-blocked detection.

### Fixed
- Fixed a duplicate `return` statement in `FleetUtils.getDepartureModalText`.
- Removed several unused environment variables from `playwright.yml`.

## [1.1.0] - 2026-04-14
### Added
- **cron-job.org Support**: Added comprehensive support and documentation for external the precise scheduling.
- **Dual Tracking Mode**: README updated with both GitHub Actions and cron-job.org instructions.

## [1.0.0] - 2026-04-06
### Added
- Initial release with core features: Fuel monitor, Automatic maintenance, and Easy mode pricing.
