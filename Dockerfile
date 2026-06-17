# Eco-Travel Advisor — single-container image for Hugging Face Spaces (Docker SDK).
#
# One image runs the whole assistant: the Rasa REST server, the custom action
# server, and an nginx reverse proxy that serves the web UI and forwards API calls
# to Rasa. Everything sits behind port 7860 (the port Hugging Face Spaces routes to).
#
# Rasa 3.6.x requires Python 3.10.
FROM python:3.10-slim

# nginx serves the static UI and proxies the API. (psycopg2-binary ships as a
# wheel, so no C compiler is needed.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first for better Docker layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the project source (see .dockerignore for what is excluded).
COPY . .

# Train the assistant at build time so the container starts quickly. Training
# needs no secrets, so none are required during the build.
RUN rasa train

# Install the nginx site and make the entry point executable.
RUN cp deploy/nginx.conf /etc/nginx/sites-available/default \
    && chmod +x deploy/start.sh

# Hugging Face Spaces routes external traffic to this port.
EXPOSE 7860

CMD ["bash", "deploy/start.sh"]
