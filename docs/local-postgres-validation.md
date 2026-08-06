# Local PostgreSQL validation

Large historical validation runs must use a disposable local database rather than a shared Neon project. Production
continues to use Neon; this setup only changes local commands when `LOCAL_DATABASE_WS_PROXY` is explicitly set.

The application uses `@neondatabase/serverless`, whose `Pool` transport requires a WebSocket proxy even when the
PostgreSQL server is local. Use the official `neondatabase/wsproxy` source and restrict it to the validation container.

## Ephemeral containers

~~~bash
docker run \
  --name yearn-prices-validation-postgres \
  --tmpfs /var/lib/postgresql/data:rw,size=768m \
  -e POSTGRES_USER=yearn_prices \
  -e POSTGRES_PASSWORD=local_validation_only \
  -e POSTGRES_DB=yearn_prices \
  -p 127.0.0.1:55432:5432 \
  -d postgres:16-alpine

git clone --depth 1 https://github.com/neondatabase/wsproxy.git /tmp/neon-wsproxy
docker build -t yearn-prices-neon-wsproxy:local /tmp/neon-wsproxy
docker network create yearn-prices-validation
docker network connect yearn-prices-validation yearn-prices-validation-postgres
docker run \
  --name yearn-prices-validation-wsproxy \
  --network yearn-prices-validation \
  -e LISTEN_PORT=:80 \
  -e ALLOW_ADDR_REGEX='^yearn-prices-validation-postgres:5432$' \
  -p 127.0.0.1:55433:80 \
  -d yearn-prices-neon-wsproxy:local
~~~

PostgreSQL data lives in container tmpfs and disappears with the container. The proxy listens only on loopback and can
forward only to the named validation database container.

## Environment and commands

Use the host TCP endpoint for migrations:

~~~bash
export DATABASE_URL=postgresql://yearn_prices:local_validation_only@127.0.0.1:55432/yearn_prices
export DATABASE_SCHEMA=yearn_prices_validation_example
./node_modules/.bin/db-migrate up --config ./database.validation.json --env dev
~~~

Use the container hostname and loopback proxy for application scripts and tests:

~~~bash
export DATABASE_URL=postgresql://yearn_prices:local_validation_only@yearn-prices-validation-postgres:5432/yearn_prices
export LOCAL_DATABASE_WS_PROXY=127.0.0.1:55433/v1
export DATABASE_SCHEMA=yearn_prices_validation_example

bun run test:postgres
bun run --preload ./scripts/configure-local-database.ts scripts/run-daily-price-cycle.ts
~~~

`LOCAL_DATABASE_WS_PROXY` rejects non-loopback endpoints and credentials. Without it, the normal Neon transport is
unchanged.

## Teardown

After retaining the required secret-free artifacts:

~~~bash
docker rm -f yearn-prices-validation-wsproxy yearn-prices-validation-postgres
docker network rm yearn-prices-validation
~~~
