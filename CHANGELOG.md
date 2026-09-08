# Changelog

All notable changes to MerchRoute are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Dates use the `YYYY-MM-DD` format.

## [Unreleased]

## [1.0.0] - 2026-09-09

### Changed

- Deliver approved local imports, PDD/1688 downloads and E001 white-background images directly to configured workflow directories, with frozen default parameters, durable delivery identities and history-based recovery.
- Paginate every platform's local-import directory list at 10 entries per page while retaining cross-page selection, primary directories and preview information.
- Hide review and delivery progress cards on review, task, pending and history pages while retaining background updates, delivery details and history retries.
- Align MerchRoute and the bundled Jimeng proxy at version 1.0.0. Bind the formal image `merchroute/jimeng-free-api-all:1.0.0` and container `merchroute-jimeng-v1.0.0` to verified source and image identities; preserve existing task storage and rollback support.
- Preserve legacy pending delivery, E002/E003 review, E004/E005 direct delivery and all previously accepted features.

## [0.1.10] - 2026-09-08

### Changed

- Open local-import variant directory names in Windows Explorer or macOS Finder while preserving selection, preview and in-page browsing controls.
- Retain the Jimeng rc.13 unified image-count and partial-success policy, bounded retries, durable idempotency ledger, welcome page and deployment rollback support.
- Package sanitized E001/E002/S003 workflow exports from the accepted local n8n versions; preserve the E003 calling contract.
- Model identifier research for 5.0 Pro does not constitute a new integration. Previously documented upstream failures for the 2.0, 2.0 Pro and 2.1 text-to-image paths remain disclosed.

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

[Unreleased]: https://github.com/kyleliu-ai/MerchRoute/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kyleliu-ai/MerchRoute/releases/tag/v1.0.0
[0.1.10]: https://github.com/kyleliu-ai/MerchRoute/releases/tag/v0.1.10
[0.1.0]: https://github.com/kyleliu-ai/MerchRoute/releases/tag/v0.1.0
