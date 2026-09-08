# Changelog

All notable changes to MerchRoute are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Dates use the `YYYY-MM-DD` format.

## [Unreleased]

### Current batch: 0.1.10 candidate

- Open local-import variant directory names in Windows Explorer or macOS Finder while preserving selection, preview and in-page browsing controls.
- Retain the Jimeng rc.13 unified image-count and partial-success policy, bounded retries, durable idempotency ledger, welcome page and deployment rollback support.
- Package sanitized E001/E002/S003 workflow exports from the accepted local n8n versions; preserve the E003 calling contract.
- Model identifier research for 5.0 Pro does not constitute a new integration. Previously documented upstream failures for the 2.0, 2.0 Pro and 2.1 text-to-image paths remain disclosed.
- This batch is a candidate until complete verification and formal publication; publishing does not activate local production services.

### Added

- GitHub CI, contribution guidance, security policy, and repository metadata.
- Cross-platform installation and architecture documentation.

### Security

- Upgraded `@fastify/static` to 10.x to address path handling advisories.
- Replaced the stale npm SheetJS package with the official SheetJS 0.20.3 distribution.

## [0.1.0] - 2026-07-14

### Added

- Local review workbench for AI-generated commerce images.
- Configurable workflow stages, image selection, drafts, and batch delivery.
- Atomic `.staging` handoff with manifests, `_READY.json`, conflict revisions, and retry history.
- Procurement records and configurable n8n download webhooks.
- Versioned cross-border shipping and pricing templates.
- Windows and macOS launchers, unit tests, integration tests, and Playwright coverage.

[Unreleased]: https://github.com/kyleliu-ai/MerchRoute/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kyleliu-ai/MerchRoute/releases/tag/v0.1.0
