# tvh-controller

Centralized [tvheadend](https://tvheadend.org/) controller: one dashboard for
several tvheadend instances, centrally managed autorec rules, tuner-conflict
prediction for upcoming recordings, and Google Drive archiving via rclone.

## Features

### Overview & recordings
- **Dashboard** per instance: upcoming/finished/failed counts, next
  recordings (with a live recording marker), tuner inputs with signal stats,
  active subscriptions. Input and subscription data updates sub-second via
  tvheadend's comet WebSocket push; everything else streams over SSE.
- **Unified Recordings view** across all instances: the same broadcast
  recorded on multiple zones appears once (matched by channel + time
  overlap, robust to over-the-air EIT title/time revisions), with
  per-instance status, size, and explicit `stream · data` error counts side
  by side. A copy missing on one zone is flagged. Failures are deliberately
  NOT merged — each failure is its own row with its instance.
  Sortable grid, exact-match filters (rule / channel / date) that are
  URL-shareable, and expandable per-instance detail subrows.

### Centralized autorec rules — controller is master
- Rules are edited in the controller and pushed to instances via in-place
  `idnode/save` (scheduled recordings survive edits). Instance-local
  channel/tag/profile references are mapped **by name**; a push is blocked
  when a name doesn't exist on the target (tvheadend would silently clear
  it, turning the rule into an all-channels recorder).
- **Per-rule instance scoping**: a rule targets all instances (`all` tracks
  instances added later) or an explicit list. Removing an instance from the
  scope deletes the rule there (with confirmation — tvheadend cancels its
  scheduled entries).
- **Linked clones** for per-zone variants (e.g. the same show recorded from
  a different channel per zone): a clone inherits every property from its
  parent and overrides only the fields set in its overlay. Editing the
  parent flips clones to `pending` automatically. Depth 1; parent deletion
  is blocked while clones exist.
- **Drift detection**: changes made directly on an instance surface with
  field-level diffs and one-click reconciliation — overwrite from master,
  import into master, **split into linked clone** (models an intentional
  per-zone variant without touching tvheadend), adopt/ignore/delete for
  unmanaged rules. A **bootstrap import** adopts an existing rule set from
  one instance and auto-binds matching rules on the others.
- **Soft delete**: deleting a rule removes it from the instances but parks
  the master in a *Deleted* tab; restore pushes it back, purge removes it
  permanently.
- **Manual integrity check**: a baseline-free, field-by-field comparison
  (names included) of every rule against fresh instance state — catches
  desync the drift baselines tolerate, plus structural problems (stale
  bindings, missing parents, unmanaged rules).
- **Zero-match warning**: enabled rules with no upcoming recordings on any
  targeted instance get a badge (and a one-click filter) — computed from the
  already-polled grids, costing no extra tvheadend requests.
- Editor with channel autocomplete (channel numbers + per-instance
  availability) and broadcast-time hints.

### Broadcast (EIT) time display
- tvheadend interprets autorec time windows in its **server** timezone,
  which often differs from the broadcast zone (e.g. UTC hosts recording JST
  broadcasts). The controller reads each network's *EIT time offset* from
  tvheadend (resolved per channel) and auto-detects the server offset via
  the co-located rclone rcd, then displays rule start windows in broadcast
  time using TV-schedule notation (`27:30` = 03:30 next day). Stored values
  stay in server time; hover shows them.

### Tuner conflict prediction
- Upcoming recordings are mapped channel → services → muxes → networks and
  matched against available frontends (recordings on the same mux share a
  tuner; IPTV networks use `max_streams`). Warns on `conflict` (infeasible)
  and `low margin` (zero spare tuners), as badges on entries and a
  per-network conflict timeline.

### Google Drive archiving
- Uploads run through **`rclone rcd`** on each tvheadend host — no agent,
  no Node on the hosts. The remote path mirrors the local recording layout
  relative to the DVR profile's storage root.
- A shared ledger prevents the same broadcast (recorded by several zones)
  from being uploaded twice; the upload button picks the **best copy**
  (fewest errors, then largest file) with per-copy manual override.
- Verification is **size-based** via `operations/stat` (rclone already
  checksum-verifies in flight), which keeps old rcd versions without
  `operations/hashsum` working and survives both controller and rcd
  restarts — in-flight rclone jobs are re-attached, lost ones re-verified.
  A wrong-host guard refuses to upload a file whose size doesn't match the
  recording. One transfer at a time per host.
- **Auto-upload** (`autoUpload` in config.yaml): every finished recording's
  best copy is archived automatically. It waits while any instance is still
  recording its copy of the same broadcast, ignores failed copies, never
  second-guesses manual uploads, and never auto-retries a failed upload.
  If an instance is unreachable at decision time the pick is marked
  *incomplete*; once the instance returns, the pick is re-evaluated and a
  strictly better copy replaces the archived one (the old remote object is
  deleted only after the replacement verifies).

## Layout

| Package | What |
|---|---|
| `packages/shared` | Types & schemas shared by controller and web (tvheadend API shapes, master rule schema, content identity) |
| `packages/controller` | Fastify server: tvh client (Basic/Digest/anonymous auth), pollers + comet push, sync engine, capacity analysis, upload dispatcher, REST + SSE, serves the built SPA |
| `packages/web` | Svelte 5 + Vite SPA (pushState routing, deep-linkable filters) |
| `deploy/` | Dockerfile, k8s manifests, `rclone-rcd.service` template for the hosts |
| `scripts/` | Dev tools: mock tvheadend, SSE probe, reconcile CLI |

Everything is configured by a single `config.yaml` (instances, database DSN,
port, rclone remote). Lookup order: `$TVHC_CONFIG`, `./config.yaml`,
`/etc/tvhc/config.yaml`. State lives in MariaDB/MySQL (`database:` key —
omit it to run in overview-only mode); tables are created by migrations at
startup. An instance with an explicit `url: null` is a **tvh-less zone**: no
tvheadend machinery is created for it — it exists purely to host restreamer
nodes fed by m3u source catalogs, and every tvh-dependent feature (rule sync
scope `all`, recordings, EPG, uploads) cleanly excludes it.

## Development

```sh
pnpm install
pnpm -r build          # tsc + vite build
pnpm -r test           # vitest

cp config.example.yaml config.yaml         # edit instances + database DSN
pnpm --filter @tvhc/controller dev         # API + UI on :8080
pnpm --filter @tvhc/web dev                # optional: Vite dev server, proxies /api
```

Without real instances, run two mock tvheadends (plus optional mock
restreamer nodes for the Restreamer page) and point the controller at them:

```sh
node scripts/mock-tvh.mjs 19981 &
node scripts/mock-tvh.mjs 19982 &
node scripts/mock-restreamer.mjs --port 15801 --name zone1-node1 &
node scripts/mock-restreamer.mjs --port 15802 --name zone2-node1 &
TVHC_CONFIG=./config.mock.yaml node packages/controller/dist/main.js
node scripts/sse-probe.mjs http://localhost:8090/api/events 10   # watch live events
```

The mock restreamer speaks the daemon wire contract v1 and serves
fake-but-advancing HLS playlists at the paths a real node's nginx would
(`/<slug>/playlist.m3u8`, `/<slug>/<variant>/stream.m3u8`), with
`POST /__freeze` / `POST /__unfreeze` hooks to demo switcher failover.
Restreamer desired-state pushes need a `database:` in the config; without one
the node overview stays status-only.

Authentication is optional everywhere: leave out `username`/`password` when
tvheadend allows anonymous access (the anonymous user needs admin rights —
status endpoints require it), and leave out rclone `user`/`pass` when rcd
runs with `--rc-no-auth`. When credentials are configured, the client uses
Basic with a transparent Digest fallback for tvheadend. The controller
itself has **no auth** and must only be reachable over a trusted network.

**Deployment requirement**: the controller's HTTP API (port 8080) and every
`rclone rcd` endpoint it talks to (port 5572, typically started with
`--rc-no-auth` — see [`deploy/host/rclone-rcd.service`](deploy/host/rclone-rcd.service))
carry no authentication and no per-request authorization. Both rely entirely
on network-level isolation for safety. Only run this stack on a private
network or behind a VPN that only trusted operators and hosts can reach;
never expose either port to the public internet or to an untrusted LAN/VLAN,
and never put the controller behind a public reverse proxy without adding
your own auth layer in front of it. In Kubernetes, restrict ingress to the
controller Service with a `NetworkPolicy` (example in
[`deploy/k8s/controller.yaml`](deploy/k8s/controller.yaml)) rather than
relying on cluster network isolation alone.

## Deployment

1. **Hosts** (each tvheadend machine): install `rclone` (any version with
   `operations/stat`, i.e. ≥ 1.55), keep the existing `rclone.conf` with the
   Drive remote, install
   [`deploy/host/rclone-rcd.service`](deploy/host/rclone-rcd.service)
   (edit `User=` and the config path).
2. **Controller image**: CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
   tests and publishes `ghcr.io/koreapyj/tvh-controller` on every push to
   `main` (`latest` + `sha-…` tags) and on `v*` tags (semver tags). For a
   local build: `docker build -f deploy/controller.Dockerfile .`
3. Apply [`deploy/k8s/controller.yaml`](deploy/k8s/controller.yaml) with a
   filled-in [`secrets.example.yaml`](deploy/k8s/secrets.example.yaml).
   Keep `replicas: 1` (singleton pollers, in-process serialization).

## First run

1. Open the dashboard, verify the instances show **online**.
2. Go to **Autorec Rules** → *Bootstrap: import from…* your primary
   instance. This imports all rules as master rules and auto-binds matching
   rules on the other instances; divergent same-name rules appear under
   **Drift**, where *Split into linked clone* models intentional per-zone
   variants.
3. From then on, edit rules **only in the controller**. Instance-side edits
   are detected and reconciled under **Drift**; run the **integrity check**
   there whenever you want a full audit.

## Notes & caveats

- Deleting a rule cancels its scheduled recordings on the targeted
  instances (tvheadend behavior). The rule itself is soft-deleted and can
  be restored (which re-pushes it).
- Upload dedup assumes channel names are consistent across instances;
  titles and exact times may differ between zones (over-the-air EIT) and
  are tolerated.
- rclone rcd job ids reset when the daemon restarts; uploads recover via
  the size verification rather than relying on job state.
- A linked clone's controller-side name reaches the instance with the next
  push of that rule (shown as `pending` until then).
- The tvheadend reference source used during development is expected at
  `.claude/ref/tvheadend` (not part of the build).
