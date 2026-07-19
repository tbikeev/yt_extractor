FROM python:3.12-slim

# Node is required by modern yt-dlp YouTube extraction (EJS / JS challenge).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
         -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /out
ENTRYPOINT ["yt-dlp"]
