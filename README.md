# umbrel-verus

Docker image for the **Verus Node** umbrelOS app: the official Verus daemon (`verusd`) plus a small web dashboard that manages it.

- `verusd` / `verus` come from the official [VerusCoin releases](https://github.com/VerusCoin/VerusCoin/releases), pinned by sha256 in the `Dockerfile` and checked against the hash signed by the Verus Coin Foundation inside each release archive.
- `server/server.js` supervises `verusd`, downloads the zk-SNARK parameters on first start, and serves the dashboard, its API and the Umbrel widgets. It has no npm dependencies.
- `server/public/` is the dashboard UI.
- `icon.svg` is the Umbrel app icon.

The Umbrel package that uses this image is `dwarner-verus` in [umbrel-app-store](https://github.com/dwarner5522/umbrel-app-store), where it runs next to the Electrum server image as one app.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_PASS` | required | `verusd` RPC password |
| `RPC_USER` | `umbrel` | `verusd` RPC username |
| `RPC_PORT` | `27486` | RPC port |
| `P2P_PORT` | `27485` | P2P port |
| `APPS_SUBNET` | none | extra `rpcallowip` range, e.g. `10.21.0.0/16` |
| `VERUSD_EXTRA_ARGS` | none | comma-delimited extra `verusd` flags |
| `DEVICE_DOMAIN_NAME` | none | hostname shown in the connect details |
| `ELECTRUM_STATUS_URL` | none | status page of an [umbrel-verus-electrum](https://github.com/dwarner5522/umbrel-verus-electrum) container, e.g. `http://electrum:3000`. When set, the dashboard also shows the Electrum server and serves its widget at `/api/widget/electrum` |
| `PBAAS_EXTRA_ARGS` | `-maxconnections=24,-dbcache=100` | comma-delimited `verusd` flags for each PBaaS chain daemon |
| `PORT` | `3000` | dashboard port |

All state lives in `/data`: `/data/.komodo/VRSC` (blockchain, `wallet.dat`, `VRSC.conf`) and `/data/.zcash-params`.

## PBaaS chains and merge mining

The dashboard can run the daemons of other chains of the Verus network (vARRR, vDEX, CHIPS and any
PBaaS chain launched from VRSC that the node knows about) next to `verusd`, each with a switch.
Their data lives in `/data/.verus/pbaas`, and the switches are remembered in `/data/pbaas-chains.json`.

With "Merge mine" on, the app sets the chain's mining distribution to the payout address and turns
mining on in that chain's daemon. The daemon then registers its blocks with the VRSC daemon, and
anyone mining VRSC through this node (for example with
[umbrel-verus-datum](https://github.com/dwarner5522/umbrel-verus-datum)) mines that chain with the
same hashes. Blocks whose coinbase pays the payout address are counted as found.

`VRSC.conf` in the data directory is kept in step with `RPC_USER`, `RPC_PASS` and `RPC_PORT`, because
that file is how a PBaaS daemon finds the VRSC daemon.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/chains` | the chains, their state and the payout address |
| `POST /api/chains/<name>` | `{"enabled": true}` runs or stops a chain, `{"mine": true}` switches its merge mining |
| `POST /api/payout` | `{"address": "R…"}` sets the address merge-mined rewards are paid to |
| `GET /api/chains/<name>/logs` | the end of that chain's `debug.log` |

## Run it locally

```sh
docker build -t umbrel-verus .
docker run --rm --init -p 3000:3000 -p 27485:27485 -e RPC_PASS=change-me -v verus-data:/data umbrel-verus
```

Then open http://localhost:3000.

## Publish

Pushing a `v*` tag runs `.github/workflows/build.yml`, which builds `linux/amd64` and `linux/arm64` and pushes `ghcr.io/<owner>/umbrel-verus:<tag>`. The workflow summary prints the full `image:tag@sha256:digest` reference to paste into `dwarner-verus/docker-compose.yml` in the app store. Make the package public in GitHub's package settings so Umbrel can pull it.

```sh
git tag v1.2.18 && git push origin v1.2.18
```

## Updating Verus

Change `VERUS_VERSION` and the two `VERUS_SHA256_*` values in the `Dockerfile` (sha256 of the release `.tgz` assets), then tag a new release.

## Credits

The Verus logo is from [VerusCoin/Media-Assets](https://github.com/VerusCoin/Media-Assets) (MIT, © 2020 Max Theyse).
