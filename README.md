# Final Mini Project: Docker + docker-compose + CI Pipeline

A complete QA infrastructure: **Node.js API** + **PostgreSQL database** + **automated end-to-end tests** + **GitHub Actions CI pipeline**. Everything runs in Docker containers — the only things you need on your machine are Docker Desktop, Git and a GitHub account.

**Key idea:** the same tests run identically on every machine and in CI, because the entire environment (application, database, test runner) is described as code.

---

## Contents

1. [Architecture](#1-architecture)
2. [File structure](#2-file-structure)
3. [Step 1 — API application (`app/`)](#3-step-1--api-application-app)
4. [Step 2 — Tests (`tests/`)](#4-step-2--tests-tests)
5. [Step 3 — Dockerfile for the API](#5-step-3--dockerfile-for-the-api)
6. [Step 4 — Dockerfile for the tests](#6-step-4--dockerfile-for-the-tests)
7. [Step 5 — Environment variables (`.env`)](#7-step-5--environment-variables-env)
8. [Step 6 — docker-compose.yml](#8-step-6--docker-composeyml)
9. [Step 7 — Running locally](#9-step-7--running-locally)
10. [Step 8 — GitHub Actions CI pipeline](#10-step-8--github-actions-ci-pipeline)
11. [Step 9 — Push to GitHub and run the pipeline](#11-step-9--push-to-github-and-run-the-pipeline)
12. [Step 10 — Adding a new test + Pull Request](#12-step-10--adding-a-new-test--pull-request)
13. [QA discussion — where things can go wrong](#13-qa-discussion--where-things-can-go-wrong)
14. [Useful commands](#14-useful-commands)

---

## 1. Architecture

The project consists of **three services** that docker-compose starts together in a single network:

```
┌────────────┐      HTTP       ┌────────────┐      SQL       ┌────────────┐
│   TEST     │ ──────────────► │    API     │ ─────────────► │  DATABASE  │
│ (Jest +    │  http://app:3000│ (Node.js + │   pg driver    │ (PostgreSQL│
│  Axios)    │                 │  Express)  │                │    15)     │
└────────────┘                 └────────────┘                └────────────┘
```

**Data flow:** TEST → API → DATABASE

- **db** — PostgreSQL 15 database, stores users in the `users` table
- **app** — Express API with the routes `GET /users`, `POST /users` and `DELETE /users`
- **test** — a container that runs the Jest tests against the API and then exits (exit code 0 = PASS, 1 = FAIL)

Inside the docker network the services see each other **by service name** — that is why the tests call `http://app:3000` and the API connects to the database via the host `db`.

## 2. File structure

```
project/
├── app/                        # Node.js API application
│   ├── server.js               # Express server + PostgreSQL connection
│   └── package.json            # dependencies: express, pg
├── tests/                      # automated tests
│   ├── api.test.js             # Jest + Axios end-to-end tests
│   ├── package.json            # dependencies: jest, axios
│   ├── Dockerfile              # image for the test runner
│   └── .dockerignore           # excludes node_modules from the test build context
├── .github/
│   └── workflows/
│       └── test.yml            # GitHub Actions CI pipeline
├── Dockerfile                  # image for the API
├── .dockerignore               # excludes files from the docker build context
├── docker-compose.yml          # orchestration of all three services
├── .env                        # environment variables for the database
├── .gitignore
└── README.md
```

## 3. Step 1 — API application (`app/`)

### `app/server.js`

A simple user management API written in **Express**, storing data in a **PostgreSQL** database:

- `GET /users` — returns the list of all users from the database
- `POST /users` — adds a new user (`{ "name": "John" }`); if `name` is missing it returns **400** (validation)
- `DELETE /users` — deletes all users (the tests use it to reset state before running)

Key characteristics:

1. **Environment variables** — the database connection is not hardcoded; it is read from `process.env` (`DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`). The same image works locally and in CI; only the configuration changes.
2. **Connection pooling** — `pg.Pool` is used instead of individual connections, so database connections are reused.
3. **Async/await** — all database queries are asynchronous.
4. **Retry on startup** — the `initDb()` function creates the `users` table (`CREATE TABLE IF NOT EXISTS`) and retries if the database is not ready yet. This solves the classic "the app starts before the database" problem.

### `app/package.json`

```json
{ "dependencies": { "express": "^4", "pg": "^8" } }
```

## 4. Step 2 — Tests (`tests/`)

### `tests/api.test.js`

**End-to-end tests** (Jest + Axios) — no function is tested in isolation; the whole system is exercised: an HTTP request hits the real API, which writes to the real database.

The main test (`create user`) flows in three steps:

1. **Create a user** — `POST http://app:3000/users` with `{name: "John"}`
2. **Fetch the list** — `GET http://app:3000/users`
3. **Verify** — the list contains exactly 1 user and it is John

Additional tests (bonus extensions from the assignment):

- **GET test** — the list is an array and contains the created user
- **Validation** — `POST /users` without a name returns status 400
- **DELETE test** — after deletion the list is empty

Two QA-critical details in `beforeAll`:

- **`waitForApi()` (retry mechanism)** — before running, the tests poll in a loop until the API actually responds. Without this the tests could start too early and fail even though everything is correct.
- **Database reset** — `DELETE /users` before the tests, because the docker volume keeps data between runs. Without the reset a second run would fail (the database would contain 2 Johns while the test expects 1). Tests must be **repeatable**.

### `tests/package.json`

```json
{
  "dependencies": { "axios": "^1", "jest": "^29" },
  "scripts": { "test": "jest" },
  "jest": { "testTimeout": 30000 }
}
```

The timeout is raised to 30s because the first test also includes waiting for the API to become ready.

## 5. Step 3 — Dockerfile for the API

The `Dockerfile` in the project root:

```dockerfile
FROM node:18              # base image: Node.js 18 (contains node and npm)
WORKDIR /app              # working directory inside the container
COPY app/package.json .   # first only package.json ...
RUN npm install           # ... then install dependencies
COPY app .                # only then the rest of the code
CMD ["node", "server.js"] # command executed when the container starts
```

**Why is `package.json` copied before the rest of the code? Layer caching.** Docker caches every step (layer). If only `server.js` changes and `package.json` does not, Docker reuses the cached `npm install` layer — the build takes seconds instead of minutes.

**`.dockerignore`** — like `.gitignore`, but for Docker: it lists files that are excluded from the build context (`node_modules`, `.git`, docs...). This keeps builds fast and prevents unnecessary files from ending up in the image. There is one next to each Dockerfile (project root and `tests/`).

## 6. Step 4 — Dockerfile for the tests

`tests/Dockerfile`:

```dockerfile
FROM node:18
WORKDIR /tests
COPY package.json .   # paths are relative because the build context is ./tests
RUN npm install
COPY . .
CMD ["npm", "test"]   # the container runs the tests and exits
```

The test container is not a server — it runs the tests and **exits**. Its exit code (0 or 1) is the result of the whole pipeline.

## 7. Step 5 — Environment variables (`.env`)

```env
DB_HOST=db        # name of the docker-compose database service (DNS inside the docker network)
DB_USER=postgres  # PostgreSQL user (the default superuser)
DB_PASS=admin     # PostgreSQL password
DB_NAME=db        # database name
```

**Why `.env`?**

- **Security** — credentials are not hardcoded in the code
- **Flexibility** — same application, different configuration (local / CI / production)
- **Simplicity** — everything in one place

> **IMPORTANT:** In this practice project the `.env` file is intentionally committed to git (it contains only test values, and the project must work right after `git clone`). In a **real project** `.env` goes into `.gitignore`, and a `.env.example` without real values is committed instead.

## 8. Step 6 — docker-compose.yml

Compose describes all three services and their dependencies:

```yaml
services:
  db:                          # 1. Database
    image: postgres:15         # ready-made image from Docker Hub (not built)
    environment: ...           # credentials used to initialize the database
    ports:
      - "5433:5432"            # host port 5433 to avoid clashing with a local PostgreSQL
    volumes:
      - dbdata:/var/lib/postgresql/data   # data survives container restarts
    healthcheck:               # pg_isready - when the database is REALLY ready
      test: ["CMD-SHELL", "pg_isready -U postgres -d db"]

  app:                         # 2. API application
    build: .                   # built from the Dockerfile in the root
    ports:
      - "3000:3000"            # container port 3000 is also visible from the host
    env_file:
      - .env                   # environment variables from the .env file
    depends_on:
      db:
        condition: service_healthy   # wait until the database passes its healthcheck
    healthcheck:               # the API is ready when /users returns a response
      test: ["CMD", "curl", "-f", "http://localhost:3000/users"]

  test:                        # 3. Test runner
    build: ./tests
    depends_on:
      app:
        condition: service_healthy   # tests start only when the API is ready

volumes:
  dbdata:                      # named volume for the database data
```

Startup order: **db → (healthy) → app → (healthy) → test**. Plain `depends_on` only guarantees *start* order, not readiness — that is why **health checks** with `condition: service_healthy` were added (this is also the bonus part of the assignment).

> Note: the `version: "3.9"` field from older examples is omitted — it is obsolete in Compose v2 and only produces a warning.

## 9. Step 7 — Running locally

Prerequisites (see `docker_ci_min_requirements.pdf`): **Docker Desktop**, **Git**, **GitHub account**, **VS Code**. Node.js is NOT required — everything runs in Docker.

```bash
git clone <repository-url>
cd <repository-folder>
docker compose up --build
```

What happens, in order:

1. The API image is built (Dockerfile in the root)
2. The test image is built (`tests/Dockerfile`)
3. The database (`db`) starts and compose waits until it is healthy
4. The API (`app`) starts and compose waits until it is healthy
5. The tests (`test`) run

Expected result at the end of the output:

```
test-1  | PASS ./api.test.js
test-1  |   ✓ create user
test-1  |   ✓ get users returns list with created user
test-1  |   ✓ post without name returns 400
test-1  |   ✓ delete users empties the list
test-1  |
test-1  | Test Suites: 1 passed, 1 total
test-1  | Tests:       4 passed, 4 total
test-1 exited with code 0
```

If you see **PASS** — the environment is set up correctly. To stop: `Ctrl+C`, then `docker compose down`.

While the stack is running you can also try the API manually from the host machine (that is what `ports: 3000:3000` is for):

```bash
curl http://localhost:3000/users
curl -X POST http://localhost:3000/users -H "Content-Type: application/json" -d "{\"name\":\"Ana\"}"
```

### Inspecting the database directly (pgAdmin / psql)

The `db` service is published on host port **5433** (not 5432, so it does not clash with a locally installed PostgreSQL — see problem #4 in the QA discussion). While the stack is running you can connect with:

| Setting  | Value       |
|----------|-------------|
| Host     | `localhost` |
| Port     | `5433`      |
| User     | `postgres`  |
| Password | `admin`     |
| Database | `db`        |

Or from the terminal, without any local tools, using psql inside the container:

```bash
docker compose exec db psql -U postgres -d db -c "SELECT * FROM users;"
```

## 10. Step 8 — GitHub Actions CI pipeline

`.github/workflows/test.yml`:

```yaml
name: QA pipeline
on:
  push:            # runs on every push
  pull_request:    # and on every pull request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start containers and run tests
        run: docker compose up --build --abort-on-container-exit --exit-code-from test
      - name: Stop containers
        if: always()
        run: docker compose down -v
```

What the pipeline does:

1. **Checkout** — fetches the repository code onto the CI machine
2. **Runs docker-compose** — exactly the same as locally (`up --build`)
3. **Runs the tests** — the test container executes
4. **Returns the result** — the test container's exit code becomes the pipeline status (green/red)
5. **Stops the containers** — `down -v` cleans everything up, even when tests fail (`if: always()`)

Key options:

- **`--abort-on-container-exit`** — as soon as one container exits (the test runner), compose stops all the others. Without this the API and the database would run forever and the CI job would never finish.
- **`--exit-code-from test`** — the pipeline status follows the exit code of the **test** service specifically. Without this the pipeline would stay green even when the tests fail.

## 11. Step 9 — Push to GitHub and run the pipeline

```bash
# 1. Create an EMPTY repository on github.com (New repository, without a README)
# 2. Connect and push:
git init
git add .
git commit -m "QA mini project: Docker + compose + CI"
git remote add origin https://github.com/<your-account>/<repo-name>.git
git branch -M main
git push -u origin main
```

The pipeline starts **automatically** after the push: on GitHub open the **Actions** tab → the **QA pipeline** workflow → click the run to see the logs of every step. A green checkmark = tests passed.

## 12. Step 10 — Adding a new test + Pull Request

The complete QA workflow, step by step:

```bash
# 1. New branch
git checkout -b add-new-test

# 2. Add a test to tests/api.test.js, e.g.:
#    test("second user is added to the list", async () => {
#      await axios.post(`${API}/users`, { name: "Marko" });
#      const response = await axios.get(`${API}/users`);
#      expect(response.data.map(u => u.name)).toContain("Marko");
#    });

# 3. Verify locally that everything passes
docker compose up --build --abort-on-container-exit --exit-code-from test
docker compose down

# 4. Commit and push the branch
git add tests/api.test.js
git commit -m "Add test for second user"
git push -u origin add-new-test
```

5. On GitHub click **Compare & pull request** → **Create pull request**
6. The pipeline runs automatically **on the PR** — the test status is visible directly in the PR
7. When the pipeline is green → **Merge pull request**

This is the essence of CI: **no change reaches main until the tests pass.**

## 13. QA discussion — where things can go wrong

| # | Problem | Symptom | Solution in this project |
|---|---------|---------|--------------------------|
| 1 | **Database not ready** when the API starts | `ECONNREFUSED` during API startup | Healthcheck on `db` (`pg_isready`) + `condition: service_healthy` + retry in `initDb()` |
| 2 | **Tests start too early**, before the API is listening | Tests fail even though the code is correct | Healthcheck on `app` + `waitForApi()` retry loop in the tests |
| 3 | **Env variables not set** | The API cannot connect to the database | `env_file: .env` in compose; valid default values in the repo |
| 4 | **Port conflict** — 3000 is taken on the host machine | `port is already allocated` | Change the mapping in `docker-compose.yml`, e.g. `"3001:3000"` (tests still work — they go through the docker network, not the host port) |
| 5 | **Old data in the volume** | The test expects 1 user but finds 2 | The tests reset the database before running; `docker compose down -v` deletes the volume |
| 6 | **Changed DB credentials but the old volume persists** | Authentication errors after changing `POSTGRES_PASSWORD` | PostgreSQL sets credentials only on first initialization — run `docker compose down -v` to recreate the database with the new values |

**Key lesson:** in a distributed system "started" ≠ "ready". Health checks and retry mechanisms are what make the setup stable — both locally and in CI.

## 14. Useful commands

```bash
docker compose up --build      # start everything (rebuilding the images)
docker compose down            # stop and remove containers and the network
docker compose down -v         # + remove the volume as well (fresh database)
docker compose logs            # logs of all services
docker compose logs app        # logs of the API only
docker compose ps              # status of running services
docker compose up --build --abort-on-container-exit --exit-code-from test
                               # "CI mode" locally: finishes with the test result
```

---

## What this project teaches

- **Docker basics** — Dockerfile, images, layer caching, containers
- **docker-compose** — multiple services, networking, `depends_on`, volumes, health checks
- **Environment variables** — configuration separated from code
- **CI pipeline** — GitHub Actions, triggers (push/PR), exit codes
- **Test automation** — end-to-end tests, retry mechanisms, test repeatability
- **QA practices** — same tests everywhere, PR + green pipeline before merge
