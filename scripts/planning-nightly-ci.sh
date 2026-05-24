#!/bin/bash
# Pipeline nocturne Planning — 3 phases séquentielles (sous la limite idle Supabase ~150 s).
# Variables requises : SUPABASE_URL, SUPABASE_ANON_KEY, PLANNING_CRON_SECRET

set -euo pipefail

WORK_DIR="${WORK_DIR:-/tmp/planning-nightly-$$}"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

MAX_REPAIR_BATCHES="${MAX_REPAIR_BATCHES:-25}"
REPAIR_BATCH_SIZE="${REPAIR_BATCH_SIZE:-8}"
CURL_MAX_TIME="${CURL_MAX_TIME:-140}"

invoke_post() {
    local url="$1"
    local data="$2"
    local out="$3"
    local label="$4"
    local res body code
    res=$(curl -sS --max-time "$CURL_MAX_TIME" -w "\n%{http_code}" -X POST "$url" \
        -H "Authorization: Bearer ${PLANNING_CRON_SECRET}" \
        -H "apikey: ${SUPABASE_ANON_KEY}" \
        -H "Content-Type: application/json" \
        -d "$data")
    body=$(echo "$res" | sed '$d')
    code=$(echo "$res" | tail -n1)
    echo "$body" > "$out"
    echo "[$label] HTTP $code"
    if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
        echo "::error::[$label] HTTP $code — $body"
        exit 1
    fi
}

base="${SUPABASE_URL%/}"
nightly="${base}/functions/v1/planning-nightly"
bridge="${base}/functions/v1/calendar-bridge"

echo "=== Phase 1/3 : audit initial ==="
invoke_post "$nightly" '{"phase":"audit_before"}' "$WORK_DIR/audit_before.json" "audit_before"
jq -e '.ok == true and .phase == "audit_before"' "$WORK_DIR/audit_before.json" >/dev/null

echo "=== Phase 2/3 : réparation Google (lots de ${REPAIR_BATCH_SIZE}) ==="
echo '[]' > "$WORK_DIR/repair_batches.json"

batch=0
more=true
while [ "$more" = "true" ] && [ "$batch" -lt "$MAX_REPAIR_BATCHES" ]; do
    batch=$((batch + 1))
    repair_payload=$(jq -n --argjson n "$REPAIR_BATCH_SIZE" \
        '{action:"cron_repair_google_sync", maxMainRepair:$n, maxPoolRepair:$n}')
    invoke_post "$bridge" "$repair_payload" "$WORK_DIR/repair_${batch}.json" "repair_batch_${batch}"
    jq -e '.mode == "cron_repair_google_sync"' "$WORK_DIR/repair_${batch}.json" >/dev/null
    more=$(jq -r '.morePending // false' "$WORK_DIR/repair_${batch}.json")
    jq -s --argjson row "$(cat "$WORK_DIR/repair_${batch}.json")" '. + [$row]' "$WORK_DIR/repair_batches.json" \
        > "$WORK_DIR/repair_batches.tmp.json"
    mv "$WORK_DIR/repair_batches.tmp.json" "$WORK_DIR/repair_batches.json"
    echo "Lot $batch terminé — morePending=$more"
done

if [ "$more" = "true" ]; then
    echo "::error::Réparation interrompue après ${MAX_REPAIR_BATCHES} lots (morePending encore true)."
    exit 1
fi

repair_count=$(jq 'length' "$WORK_DIR/repair_batches.json")
echo "Réparation terminée en $repair_count lot(s)."

echo "=== Phase 3/3 : rapport final + e-mail ==="
report_payload=$(jq -n \
    --slurpfile audit "$WORK_DIR/audit_before.json" \
    --slurpfile repairs "$WORK_DIR/repair_batches.json" \
    --argjson it "$repair_count" \
    '{
        phase: "report",
        auditBefore: ($audit[0] | {
            checkedAt,
            horizonDays,
            futureEventsCount,
            poolAssignedCount,
            auditBefore,
            section3Html
        }),
        repairBatches: $repairs[0],
        repairIterations: $it
    }')

invoke_post "$nightly" "$report_payload" "$WORK_DIR/report.json" "report"
jq -e '.ok == true and .phase == "report" and .emailSent == true' "$WORK_DIR/report.json" >/dev/null

echo "Rapport nocturne envoyé à $(jq -r '.notifyEmail' "$WORK_DIR/report.json")."
jq '{ok, hasAnomalies, repairIterations, auditAfter, controls: [.controls[]? | {id, status, detail}]}' \
    "$WORK_DIR/report.json"
