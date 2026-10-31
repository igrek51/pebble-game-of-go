#!/usr/bin/env bash
#
# Build the KataGo server for the target architecture, push it to the GitLab registry,
# then pull it and recreate the container on the target host. No image is streamed over
# SSH. Stateless: no database to copy.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOST="${DEPLOY_HOST:-titan}"
# Relative to the login user's home, so no sudo is needed on the server.
REMOTE_DIR="${REMOTE_DIR:-katago}"
IMAGE="${IMAGE:-registry.gitlab.com/igrek51/registry/katago:latest}"
REGISTRY="${IMAGE%%/*}"

echo "==> logging in to ${REGISTRY}"
docker login "$REGISTRY"

echo "==> checking ${HOST}"
if ! REMOTE_ARCH=$(ssh "$HOST" 'command -v docker >/dev/null && docker version --format "{{.Server.Arch}}"'); then
    echo "error: Docker Engine + Compose v2 must be installed and usable" >&2
    echo "       without sudo by the ${HOST} SSH user" >&2
    exit 1
fi

LOCAL_ARCH="$(docker version --format '{{.Server.Arch}}')"
PLATFORM="${PLATFORM:-linux/${REMOTE_ARCH}}"
TARGET_ARCH="${PLATFORM#linux/}"
TARGET_ARCH="${TARGET_ARCH%%/*}"

case "$TARGET_ARCH" in
    amd64) BINFMT_ARCH=x86_64 ;;
    arm64) BINFMT_ARCH=aarch64 ;;
    *) BINFMT_ARCH="$TARGET_ARCH" ;;
esac

if [[ "$TARGET_ARCH" != "$LOCAL_ARCH" ]] && ! compgen -G "/proc/sys/fs/binfmt_misc/qemu-${BINFMT_ARCH}*" >/dev/null; then
    echo "error: cannot build ${PLATFORM} on ${LOCAL_ARCH} without binfmt emulation" >&2
    echo "       run once, then retry:" >&2
    echo "       docker run --privileged --rm tonistiigi/binfmt --install ${TARGET_ARCH}" >&2
    exit 1
fi

case "$TARGET_ARCH" in
    arm64) DOCKERFILE="${DOCKERFILE:-Dockerfile.arm64}" ;;
    *) DOCKERFILE="${DOCKERFILE:-Dockerfile}" ;;
esac

echo "==> building ${IMAGE} for ${PLATFORM} (${DOCKERFILE})"
docker build --platform "$PLATFORM" -f "$DOCKERFILE" -t "$IMAGE" .

BUILT_ARCH="$(docker image inspect "$IMAGE" --format '{{.Architecture}}')"
if [[ "$BUILT_ARCH" != "$TARGET_ARCH" ]]; then
    echo "error: built image is ${BUILT_ARCH}, expected ${TARGET_ARCH}" >&2
    exit 1
fi

echo "==> pushing ${IMAGE}"
docker push "$IMAGE"

echo "==> preparing ${HOST}:${REMOTE_DIR}"
ssh "$HOST" "mkdir -p '$REMOTE_DIR'"

echo "==> copying compose file"
scp -q compose.yaml "$HOST:$REMOTE_DIR/compose.yaml"

echo "==> pulling ${IMAGE} on ${HOST}"
if ! ssh "$HOST" "cd '$REMOTE_DIR' && KATAGO_IMAGE='$IMAGE' docker compose pull katago"; then
    echo "error: pull failed; log in on ${HOST} with:" >&2
    echo "       ssh -t ${HOST} docker login ${REGISTRY}" >&2
    exit 1
fi

echo "==> recreating container"
ssh "$HOST" "cd '$REMOTE_DIR' && KATAGO_IMAGE='$IMAGE' docker compose up -d --force-recreate --remove-orphans"

echo "==> container status"
ssh "$HOST" "cd '$REMOTE_DIR' && KATAGO_IMAGE='$IMAGE' docker compose ps"

echo "==> done: http://${HOST}:2718/ (nginx: https://katago.igrek.dev)"
