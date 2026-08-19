# Contributing to MerchRoute

Thank you for helping improve MerchRoute. Please keep changes focused, testable, and safe for local product media.

## Development Setup

1. Install Node.js 20 LTS or 22 LTS. Node.js 22 is recommended.
2. Fork and clone the repository.
3. Run `npm ci` from the repository root.
4. Copy `.env.example` to `.env` only when local overrides are needed.
5. Run `npm run dev` and open `http://127.0.0.1:4173`.

## Before Opening a Pull Request

Run the complete local verification suite:

```bash
npm run check
npm run test:e2e
```

Database-backed integration tests run only when `DATABASE_URL` is present. Do not use a production database for tests.

## Pull Request Guidelines

- Explain the problem, the chosen solution, and any behavior changes.
- Keep unrelated refactors out of the same pull request.
- Add or update tests for user-visible behavior and path-safety rules.
- Update README or files under `docs/` when setup or configuration changes.
- Never commit `.env`, credentials, product media, generated output, local databases, or application data.
- Preserve Windows and macOS path compatibility by using Node.js `path` APIs.
- Treat candidate/source folders as read-only. Destructive file operations require explicit validation and tests.

## Commit Messages

Use a short imperative subject, for example:

```text
Fix delivery retry state handling
Add macOS path validation coverage
```

## Reporting Bugs

Use the GitHub bug report template and include reproducible steps, expected behavior, actual behavior, operating system, Node.js version, and sanitized logs. Remove file paths or data that identify customers, products, credentials, or private infrastructure.
