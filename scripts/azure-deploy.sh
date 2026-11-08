#!/usr/bin/env bash
# Create or update the notifications Container App. Pinned to exactly one replica
# because live rooms are in memory (ADR-0005). Secrets come from the environment
# and are never echoed. Required: IMAGE, GHCR_USERNAME, GHCR_PULL_TOKEN,
# DATABASE_URL, SMTP_USER, SMTP_PASSWORD, API_TOKEN, GATEWAY_SECRET and the
# plain SMTP_HOST, SMTP_PORT, APP_EMAIL_SENDER[_NAME], MARKETING_EMAIL_SENDER[_NAME].
set -euo pipefail

RG="${AZURE_RESOURCE_GROUP:-rg-brenraphaels}"
ENV_NAME="${AZURE_CONTAINERAPPS_ENV:-cae-brenraphaels}"
APP="${AZURE_APP_NAME:-notifications}"

for v in IMAGE GHCR_USERNAME GHCR_PULL_TOKEN DATABASE_URL SMTP_USER SMTP_PASSWORD \
  API_TOKEN GATEWAY_SECRET SMTP_HOST SMTP_PORT APP_EMAIL_SENDER MARKETING_EMAIL_SENDER; do
  [ -n "${!v:-}" ] || { echo "Missing required value: $v" >&2; exit 1; }
done

SECRETS=(
  "database-url=$DATABASE_URL" "smtp-user=$SMTP_USER" "smtp-password=$SMTP_PASSWORD"
  "api-token=$API_TOKEN" "gateway-secret=$GATEWAY_SECRET" "ghcr-pull-token=$GHCR_PULL_TOKEN"
)
ENVVARS=(
  "PORT=8080" "SMTP_HOST=$SMTP_HOST" "SMTP_PORT=$SMTP_PORT"
  "APP_EMAIL_SENDER=$APP_EMAIL_SENDER" "APP_EMAIL_SENDER_NAME=${APP_EMAIL_SENDER_NAME:-Bren Raphael's}"
  "MARKETING_EMAIL_SENDER=$MARKETING_EMAIL_SENDER"
  "MARKETING_EMAIL_SENDER_NAME=${MARKETING_EMAIL_SENDER_NAME:-Bren Raphael's}"
  "DATABASE_URL=secretref:database-url" "SMTP_USER=secretref:smtp-user"
  "SMTP_PASSWORD=secretref:smtp-password" "API_TOKEN=secretref:api-token"
  "GATEWAY_SECRET=secretref:gateway-secret"
)

if az containerapp show -n "$APP" -g "$RG" >/dev/null 2>&1; then
  az containerapp secret set -n "$APP" -g "$RG" --secrets "${SECRETS[@]}" >/dev/null
  az containerapp registry set -n "$APP" -g "$RG" --server ghcr.io \
    --username "$GHCR_USERNAME" --password "$GHCR_PULL_TOKEN" >/dev/null
  az containerapp update -n "$APP" -g "$RG" --image "$IMAGE" \
    --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --set-env-vars "${ENVVARS[@]}" >/dev/null
else
  az containerapp create -n "$APP" -g "$RG" --environment "$ENV_NAME" --image "$IMAGE" \
    --registry-server ghcr.io --registry-username "$GHCR_USERNAME" \
    --registry-password "$GHCR_PULL_TOKEN" \
    --ingress external --target-port 8080 --transport auto \
    --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --secrets "${SECRETS[@]}" --env-vars "${ENVVARS[@]}" >/dev/null
fi

# Health probes (startup, liveness, readiness) on /health. They need YAML; the
# exported app template holds no secret values (only secretref names).
YAML=$(mktemp)
trap 'rm -f "$YAML"' EXIT
az containerapp show -n "$APP" -g "$RG" -o json > "$YAML"
python3 - "$YAML" <<'PY'
import json, sys
path = sys.argv[1]
app = json.load(open(path))
def probe(kind, **kw):
    return {"type": kind, "httpGet": {"path": "/health", "port": 8080, "scheme": "HTTP"},
            "timeoutSeconds": 5, **kw}
app["properties"]["template"]["containers"][0]["probes"] = [
    probe("Startup", periodSeconds=5, failureThreshold=30, initialDelaySeconds=2),
    probe("Liveness", periodSeconds=30, failureThreshold=3, initialDelaySeconds=10),
    probe("Readiness", periodSeconds=10, failureThreshold=3, initialDelaySeconds=2),
]
json.dump(app, open(path, "w"))
PY
az containerapp update -n "$APP" -g "$RG" --yaml "$YAML" >/dev/null

FQDN=$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)
echo "Deployed https://$FQDN"
echo "fqdn=$FQDN" >> "${GITHUB_OUTPUT:-/dev/null}"
