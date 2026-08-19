# Security Policy

## Supported Versions

MerchRoute is currently in early development. Security updates are provided for the latest release on the `main` branch.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting or security advisory feature for this repository.

Please include:

- A concise description of the issue and its impact.
- Reproduction steps or a minimal proof of concept.
- Affected operating systems and MerchRoute versions.
- Suggested mitigations, if known.

Do not include real credentials, customer information, product assets, or production filesystem paths. You can expect an initial acknowledgement within seven days.

## Security Boundaries

- MerchRoute binds to `127.0.0.1` by default.
- Remote binding requires the explicit `ALLOW_REMOTE=true` opt-in.
- Source media is treated as read-only.
- Path allowlists, traversal checks, and symlink filtering protect local files.
- `.env`, local databases, application state, logs, generated output, and backups are excluded from version control.

These controls reduce risk but do not replace operating-system permissions, secure database credentials, trusted network configuration, and regular dependency updates.
