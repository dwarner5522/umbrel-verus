# umbrel-verus

Docker image for the **Verus Node** umbrelOS app: the official Verus daemon (`verusd`) plus a small web dashboard that manages it.

- `verusd` / `verus` come from the official [VerusCoin releases](https://github.com/VerusCoin/VerusCoin/releases), pinned by sha256 in the `Dockerfile` and checked against the hash signed by the Verus Coin Foundation inside each release archive.
- `server/server.js` supervises `verusd`, downloads the zk-SNARK parameters on first start, and serves the dashboard, its API and the Umbrel widgets. It has no npm dependencies.
- `server/public/` is the dashboard UI.
- `icon.svg` is the Umbrel app icon.

The Umbrel package that uses this image lives in `umbrel-apps/verus`.

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
| `PORT` | `3000` | dashboard port |

All state lives in `/data`: `/data/.komodo/VRSC` (blockchain, `wallet.dat`, `VRSC.conf`) and `/data/.zcash-params`.

## Run it locally

```sh
docker build -t umbrel-verus .
docker run --rm --init -p 3000:3000 -p 27485:27485 -e RPC_PASS=change-me -v verus-data:/data umbrel-verus
```

Then open http://localhost:3000.

## Publish

Pushing a `v*` tag runs `.github/workflows/build.yml`, which builds `linux/amd64` and `linux/arm64` and pushes `ghcr.io/<owner>/umbrel-verus:<tag>`. The workflow summary prints the full `image:tag@sha256:digest` reference to paste into `umbrel-apps/verus/docker-compose.yml`. Make the package public in GitHub's package settings so Umbrel can pull it.

```sh
git tag v1.2.18 && git push origin v1.2.18
```

## Updating Verus

Change `VERUS_VERSION` and the two `VERUS_SHA256_*` values in the `Dockerfile` (sha256 of the release `.tgz` assets), then tag a new release.

## Credits

The Verus logo is from [VerusCoin/Media-Assets](https://github.com/VerusCoin/Media-Assets) (MIT, © 2020 Max Theyse).
