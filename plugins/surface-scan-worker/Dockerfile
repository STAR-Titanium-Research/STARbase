FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt entrypoint.sh ./
RUN pip install --no-cache-dir -r requirements.txt && chmod +x entrypoint.sh

COPY app/ ./app/
COPY tests/ ./tests/

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"]

CMD ["./entrypoint.sh"]
