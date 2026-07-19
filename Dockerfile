FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
         -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend

ENV YT_EXTRACTOR_ROOT=/app
ENV DATA_DIR=/data
# yt-dlp is baked into this image; set USE_DOCKER=always + mount docker.sock
# to force the separate yt-extractor-downloader container instead.
ENV USE_DOCKER=never
ENV DOWNLOADER_IMAGE=yt-extractor-downloader
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080
VOLUME ["/data"]

CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8080"]
