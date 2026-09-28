# Minimal KataGo HTTP server (CPU): KataGo v1.17.1 EigenAVX2 + b10c128
# main net + b18 Human SL net. Pinned URLs for reproducible builds.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates unzip p7zip-full \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# KataGo engine binary (release zip ships an AppImage: extract the payload,
# FUSE is unavailable at runtime)
RUN curl -sL -o /tmp/katago.zip \
      https://github.com/lightvector/KataGo/releases/download/v1.17.1/katago-v1.17.1-eigenavx2-linux-x64.zip \
    && unzip -o /tmp/katago.zip -d /opt/katago katago \
    && rm /tmp/katago.zip \
    && cd /opt/katago && 7z x -osquashfs-root katago >/dev/null \
    && mv squashfs-root/usr/bin/katago ./katago-bin \
    && mv squashfs-root/usr/lib ./katago-libs \
    && rm -rf squashfs-root katago && mv katago-bin katago \
    && chmod +x katago \
    && LD_LIBRARY_PATH=/opt/katago/katago-libs ./katago version
ENV LD_LIBRARY_PATH=/opt/katago/katago-libs

# Main net (b10c128, strong enough for score estimates on 9x9)
RUN curl -sL -o /tmp/main.zip \
      https://media.katagotraining.org/uploaded/networks/zips/kata1/kata1-b10c128-s41138688-d27396855.zip \
    && unzip -o /tmp/main.zip -d /tmp/main \
    && rm /tmp/main.zip \
    && f=$(find /tmp/main -name 'model.txt.gz' | head -1) \
    && mv "$f" /opt/katago/model.txt.gz \
    && rm -rf /tmp/main

# Human SL net (b18, ~99MB) for rank-profiled move sampling
RUN curl -sL -o /opt/katago/human.bin.gz \
      https://media.katagotraining.org/uploaded/networks/models_extra/b18c384nbt-humanv0.bin.gz

COPY server.py /app/server.py

ENV PORT=2718 \
    KATAGO_BIN=/opt/katago/katago \
    MODEL_PATH=/opt/katago/model.txt.gz \
    HUMAN_MODEL_PATH=/opt/katago/human.bin.gz \
    MOVE_VISITS=8 \
    SCORE_VISITS=150

EXPOSE 2718

CMD ["python3", "/app/server.py"]
