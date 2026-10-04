# Verus node (verusd) + web dashboard for umbrelOS.
# The daemon comes from the official VerusCoin release tarballs, pinned by sha256.

FROM debian:bookworm-slim AS verus

ARG TARGETARCH
ARG VERUS_VERSION=1.2.18
# sha256 of the release .tgz assets on https://github.com/VerusCoin/VerusCoin/releases
ARG VERUS_SHA256_AMD64=3c8a749a2d18059988bafcff37e72175bb8b2853caa356f820ad1e75c8189cb0
ARG VERUS_SHA256_ARM64=30c85f1b02236b42ff4bd55196fda7e0c8a2c1b47f975b39d4b318b656009a01

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl jq \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/verus

RUN set -eux; \
	case "${TARGETARCH}" in \
		amd64) arch="x86_64"; sha="${VERUS_SHA256_AMD64}" ;; \
		arm64) arch="arm64"; sha="${VERUS_SHA256_ARM64}" ;; \
		*) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
	esac; \
	name="Verus-CLI-Linux-v${VERUS_VERSION}-${arch}"; \
	curl -fsSL -o "${name}.tgz" "https://github.com/VerusCoin/VerusCoin/releases/download/v${VERUS_VERSION}/${name}.tgz"; \
	echo "${sha}  ${name}.tgz" | sha256sum -c -; \
	tar -xzf "${name}.tgz"; \
	# The release wraps a second tarball plus the hash the Verus Coin Foundation signed for it.
	echo "$(jq -r .hash "${name}.tar.gz.signature.txt")  ${name}.tar.gz" | sha256sum -c -; \
	tar -xzf "${name}.tar.gz"; \
	install -D -m 0755 verus-cli/verusd /out/verusd; \
	install -D -m 0755 verus-cli/verus /out/verus

FROM node:22-bookworm-slim

ARG VERUS_VERSION=1.2.18

# verusd shells out to curl/tar for -bootstrap
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=verus /out/verusd /out/verus /usr/local/bin/
COPY server /app

ENV NODE_ENV=production \
	HOME=/data \
	VERUS_VERSION=${VERUS_VERSION}

WORKDIR /app
USER 1000:1000
EXPOSE 3000 27485 27486
VOLUME /data

CMD ["node", "server.js"]
