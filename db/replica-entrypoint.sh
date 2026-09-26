#!/bin/sh
# The read replica: on first start, copy the primary (pg_basebackup), then stream its WAL forever.
set -e
mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "replica: waiting for the primary…"
  until su-exec postgres pg_isready -h "$PRIMARY_HOST" -p 5432 -q; do sleep 1; done
  echo "replica: copying the primary (base backup)…"
  su-exec postgres env PGPASSWORD="${REPLICATION_PASSWORD:-replicator}" \
    pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U replicator -D "$PGDATA" -R -X stream
  echo "replica: base backup complete"
fi
exec su-exec postgres postgres -c hot_standby=on
