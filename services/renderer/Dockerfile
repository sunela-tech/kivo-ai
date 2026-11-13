# Kivo render service — Blender 5.2 LTS + ffmpeg.
#
#   docker build -t kivo-renderer services/renderer
#   docker run --rm -e KIVO_API_URL=https://<your-worker> -e KIVO_RENDER_TOKEN=<token> kivo-renderer
#
# CPU rendering works anywhere (Cycles). On an NVIDIA host add `--gpus all`
# and the worker switches Cycles to OptiX/CUDA automatically.
FROM python:3.13-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libgl1 libegl1 libxrender1 libxi6 libxkbcommon0 libxxf86vm1 libxfixes3 libsm6 libice6 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY kivo_renderer ./kivo_renderer

RUN useradd --create-home --uid 10001 kivo && mkdir -p /work && chown kivo /work
USER kivo
ENV KIVO_WORK_DIR=/work \
    PYTHONUNBUFFERED=1

# Fail the build early if Blender or the H.264 encoder is unusable in this image.
RUN python -c "import bpy; print('Blender', bpy.app.version_string)" \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264

CMD ["python", "-m", "kivo_renderer.worker"]
