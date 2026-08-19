#!/bin/sh
set -eu

if [ -z "${MERCHROUTE_DB_PASSWORD:-}" ] || [ -z "${N8N_DB_PASSWORD:-}" ]; then
  echo "MerchRoute database passwords are required" >&2
  exit 1
fi

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=merchroute_password="$MERCHROUTE_DB_PASSWORD" \
  --set=n8n_password="$N8N_DB_PASSWORD" <<'SQL'
CREATE ROLE merchroute_app LOGIN PASSWORD :'merchroute_password';
CREATE DATABASE merchroute OWNER merchroute_app;
CREATE ROLE merchroute_n8n LOGIN PASSWORD :'n8n_password';
CREATE DATABASE merchroute_n8n OWNER merchroute_n8n;
REVOKE ALL ON DATABASE merchroute FROM PUBLIC;
REVOKE ALL ON DATABASE merchroute_n8n FROM PUBLIC;
SQL
