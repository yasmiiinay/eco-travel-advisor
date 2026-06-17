#!/usr/bin/env bash
# Container entry point. Starts the three processes that make up the running
# assistant and keeps nginx in the foreground as the container's main process.
#
# Secrets (NEON_DATABASE_URL and the optional API keys) are read from the
# environment, which Hugging Face Spaces injects from the Space's Secrets panel.
# They are never printed here. With no secrets set, the assistant still runs on
# the curated seed data and stored emission factors.
set -e

# 1. Custom action server (port 5055) — runs the Python custom actions.
rasa run actions --port 5055 &

# 2. Rasa REST API (port 5005) — loads the trained model and exposes
#    /webhooks/rest/webhook for the frontend.
rasa run --enable-api --cors "*" --port 5005 &

# 3. nginx (port 7860) — serves the web UI and reverse-proxies the API.
#    Foreground process: if it exits, the container stops.
nginx -g 'daemon off;'
