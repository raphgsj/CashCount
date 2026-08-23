# Infrastructure

PF-010 provides a local PostgreSQL instance. Deployment documentation is added in the
production-hardening phase; this Compose file is for development and tests only.

## Local PostgreSQL

Start PostgreSQL from the repository root:

```bash
docker compose -f infra/docker-compose.yml up -d --wait postgres
docker compose -f infra/docker-compose.yml ps
```

The `--wait` option waits for PostgreSQL's `pg_isready` health check. Verify the connection from
inside the container with:

```bash
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U cashcount -d cashcount -c 'select 1;'
```

The local-only defaults are:

```text
Host: 127.0.0.1
Port: 5432
Database: cashcount
User: cashcount
Password: cashcount-local
LOCAL_DATABASE_URL=postgresql://cashcount:cashcount-local@127.0.0.1:5432/cashcount
```

Override `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_PORT` in the environment
that invokes Compose when different local values are needed. Never reuse these development defaults
in a deployed environment.

### Docker running in UTM

When the active Docker context points to the Ubuntu UTM VM, the published database port is on the
VM's loopback interface. Keep this SSH tunnel open in a separate terminal while Mac applications
connect to PostgreSQL:

```bash
ssh -N -L 5432:127.0.0.1:5432 cashcount-utm
```

The application still uses the same `LOCAL_DATABASE_URL` shown above. The tunnel keeps PostgreSQL
off the VM's network-facing interfaces.

### Stop or reset

Stop the service while preserving its named volume:

```bash
docker compose -f infra/docker-compose.yml down
```

To intentionally erase all local PostgreSQL data and start from an empty database, add `--volumes`
to that command. This deletion is permanent.
