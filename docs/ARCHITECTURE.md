# MerchRoute Architecture

## Overview

MerchRoute is a local-first npm workspaces application. A React web interface communicates with a Fastify server that scans configured media directories, persists local review state, and performs verified folder handoffs. PostgreSQL-backed modules add procurement, shipping, pricing, and download-task management.

## Components

```text
apps/web
  React, Ant Design, React Query
       |
       | HTTP /api/v1
       v
apps/server
  Fastify, filesystem services, PostgreSQL repositories
       |
       +--> local application data
       +--> configured candidate/archive/queue folders
       +--> optional n8n download webhooks

packages/shared
  Zod schemas, shared types, workflow defaults, country data
```

## Media Review and Delivery

1. The scanner reads enabled candidate roots and discovers product folders.
2. The web interface requests thumbnails and originals through validated relative paths.
3. Review selections are saved as drafts or approved into the pending queue.
4. Delivery copies selected files into a destination-local `.staging` directory.
5. MerchRoute validates the package and writes manifests plus `_READY.json`.
6. The staging directory is atomically renamed to its final destination.
7. Delivery and archive outcomes are recorded independently so partial failures can be retried safely.

## Persistence

Local application data contains configuration, review state, logs, thumbnail cache, and temporary files. Its default location is platform-specific and can be overridden with `APP_DATA_DIR`.

PostgreSQL is optional for the image review and folder-delivery path. It is required for procurement, download jobs, shipping templates, and pricing templates.

## Trust Boundaries

- Candidate folders are external input and remain read-only.
- Browser-supplied paths must remain relative to a validated product root.
- Target paths must resolve inside configured queue or archive roots.
- Symlinks and hidden staging folders are excluded from normal scanning.
- The server is local-only unless remote binding is explicitly enabled.

## Cross-Platform Rules

- Use Node.js `path` APIs instead of manually joining path separators.
- Store platform-specific absolute paths in runtime configuration, not business logic.
- Keep browser-facing relative paths normalized with `/` and convert them at the server boundary.
- Test Windows and POSIX path behavior independently where security decisions depend on path semantics.
