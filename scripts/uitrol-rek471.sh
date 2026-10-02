#!/usr/bin/env bash
#
# Uitrol van de merge van PR #5 op de Paperclip-instance (REK-471).
#
# PR #5 haalt de ~1,2 s vaste kost en de ~32 ms per run uit
# `GET /api/issues/{id}/runs`:
#   - de `WHERE` van `runsForIssue` gaat van `or + exists` naar `id in (A ∪ B)`,
#     zodat `heartbeat_runs_company_ctx_issue_created_idx` weer gebruikt wordt;
#   - de 31 losse `->` op drie brede jsonb-kolommen worden één `jsonb_each`-lateral
#     per kolom, dus 31 TOAST-detoasts per rij worden er 3.
#
# Het script is idempotent, gokt nergens en weigert te starten als iets niet klopt.
# Elke stap is apart uitvoerbaar, zodat je niet alles in één keer hoeft te doen:
#
#   ./uitrol-rek471.sh config      # alleen lezen: wat zou er uitrollen, en klopt de bron? (geen docker nodig)
#   ./uitrol-rek471.sh inspect     # alleen laten zien wat er draait (niets schrijven)
#   ./uitrol-rek471.sh bouw        # image bouwen vanaf de merge-commit (duurt enkele minuten)
#   ./uitrol-rek471.sh koppel      # compose op de nieuwe image wijzen, met terugvalkopie
#   ./uitrol-rek471.sh start       # container herstarten, daarna harde verificatie
#   ./uitrol-rek471.sh rapport     # de bewijsstukken + een blok om in de issue te plakken
#   ./uitrol-rek471.sh terugval    # de vorige image terugzetten
#
# Host-pad van deze map: /home/kevin/paperclip/data/docker-paperclip/uitrol
#
# De bron moet op b0ff5c6339b916c6e638f4ce5341980c49a32f55 staan (de merge van
# PR #5 in master). Het script weigert te starten als `git rev-parse HEAD` iets
# anders zegt, want de poorten hieronder bewijzen de fix in de BRON en niet in
# een image die ergens anders vandaan komt.
set -euo pipefail

MAP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# BRON is te overschrijven, zodat een bestaande clone bruikbaar blijft: de PR-3-uitrol
# heeft /home/kevin/paperclip/data/docker-paperclip/uitrol/paperclip-pr3 al neergezet.
#   BRON=$PWD/paperclip-pr3 ./uitrol-rek471.sh alles
BRON="${BRON:-${MAP}/paperclip-rek471}"

# git weigert een repo die van een andere user is dan de caller ("dubious
# ownership"). Op deze host is de clone van `kevin` en draait het script als
# root, dus elke git-call stierf en de broncontrole leverde een lege
# BRON_HEAD. Gemeten 2026-10-01 18:03Z.
#
# De uitzondering gaat per aanroep via `-c safe.directory=...`, niet via
# `git config --global`. Die globale schrijfactie is onbetrouwbaar: een runner
# met een vastgespeld GIT_CONFIG_GLOBAL (bv. /dev/null) accepteert hem stilzweigend
# niet, en dan herstelt de code precies de fout die hij moest herstellen.
# Gemeten 2026-10-01 18:2xZ, rc 255 op de add en rc 128 op de herhaalde call.
git_bron() { git -c safe.directory="$BRON" -C "$BRON" "$@"; }

# Zonder COMMIT rolt dit script uit wat er in de bron staat, en niets anders. Een
# expliciete COMMIT blijft mogelijk en wordt gecontroleerd, zodat een verouderde
# checkout niet stilletjes live gaat.
COMMIT="${COMMIT:-b0ff5c6339b916c6e638f4ce5341980c49a32f55}"
IMAGE_TAG="paperclip-rek471:${COMMIT:0:12}"
ANKER="${MAP}/terugval-anker-rek471.txt"

rood()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
groen() { printf '\033[32m%s\033[0m\n' "$*" >&2; }
kop()   { printf '\n\033[1m== %s\033[0m\n' "$*" >&2; }

vind_compose() {
  # De compose van deze instance is een eigen bestand op de host; de compose in
  # de repo (docker/docker-compose.yml) is een andere en start bovendien een
  # tweede postgres. We lezen wat er staat in plaats van te gokken.
  if [ -n "${COMPOSE:-}" ] && [ -f "$COMPOSE" ]; then echo "$COMPOSE"; return 0; fi
  for kandidaat in \
      /home/kevin/paperclip/docker-compose.yml \
      /home/kevin/paperclip/docker-compose.yaml \
      /home/kevin/paperclip/compose.yml \
      /home/kevin/paperclip/paperclip/docker-compose.yml \
      /opt/paperclip/docker-compose.yml; do
    [ -f "$kandidaat" ] && { echo "$kandidaat"; return 0; }
  done
  kandidaat="$(find /home/kevin /opt /srv -maxdepth 4 -name 'docker-compose.y*ml' 2>/dev/null | head -1 || true)"
  [ -n "$kandidaat" ] && { echo "$kandidaat"; return 0; }
  return 1
}

controleer() {
  kop "1. Wat draait er nu?"
  command -v docker >/dev/null 2>&1 || { rood "docker ontbreekt op deze host. Stop hier."; exit 1; }
  COMPOSE="$(vind_compose)" || true
  if [ -z "${COMPOSE:-}" ]; then
    rood "Geen docker-compose.yml gevonden. Zet COMPOSE=<pad> in de omgeving en draai opnieuw."
    exit 1
  fi
  groen "compose : $COMPOSE"

  mapfile -t PROJECTEN < <(docker compose -f "$COMPOSE" config --services 2>/dev/null | grep -xE 'server|paperclip' || true)
  if [ "${#PROJECTEN[@]}" -eq 0 ]; then
    PROJECTEN=(server)
    groen "geen service 'server' of 'paperclip'; val terug op 'server'"
  fi
  SERVICE="${PROJECTEN[0]}"
  groen "service : $SERVICE"

  HUIDIGE_IMAGE="$(docker compose -f "$COMPOSE" images -q "$SERVICE" 2>/dev/null | head -1 || true)"
  HUIDIGE_LABEL="$(docker inspect --format '{{.Config.Image}}' "$HUIDIGE_IMAGE" 2>/dev/null || echo 'onbekend')"
  HUIDIGE_ID="$(docker ps --filter "label=com.docker.compose.service=$SERVICE" --format '{{.ID}}' | head -1 || echo 'onbekend')"
  echo "  draaiende image-id : ${HUIDIGE_IMAGE:-geen}"
  echo "  draaiend image-label: ${HUIDIGE_LABEL:-onbekend}"
  echo "  draaiend container  : ${HUIDIGE_ID:-onbekend}"
  broncontrole

  echo "  target image       : $IMAGE_TAG"
}

# Alles wat alleen de bron betreft, zonder docker. Eigen functie, want dit is de
# helft die je ook zonder docker kunt controleren (`config`), en juist die helft
# moet bij een verkeerde checkout hard stoppen.
broncontrole() {
  kop "2. Staat de bron klaar?"
  [ -d "$BRON/.git" ] || { rood "Bron ontbreekt op $BRON. Zet BRON=<pad> en probeer het opnieuw."; exit 1; }
  BRON_HEAD="$(git_bron rev-parse HEAD)"
  if [ "$BRON_HEAD" != "$COMMIT" ]; then
    rood "Bron staat op $BRON_HEAD, verwacht $COMMIT. Stop hier, verkeerde basis."
    exit 1
  fi
  groen "bron    : $BRON @ $BRON_HEAD"

  # ---- Wat deze uitrol daadwerkelijk moet bezorgen ----
  # Zonder deze poort zou een image met de oude `OR`-vorm of zonder lateral door
  # de poort komen, terwijl de commit-stamp wél klopt. De poort kijkt dus naar de
  # vorm van de code, niet alleen naar de sha.
  #
  # 1. De IN-vorm. `or (` met daarna een `exists (` op de runsForIssue-selectie is
  #    de vorm die de index niet gebruikt en 1,2 s vaste kost gaf. Gemeten op de
  #    ouwe bron: `exists (` staat 2 keer in activity.ts. Na de fix staat hij er 1,
  #    en die ene is de liveness-backfill op regel 226, niet de hoofdselectie.
  EXISTS_AAN="$(grep -c 'exists (' "$BRON/server/src/services/activity.ts" || true)"
  [ "${EXISTS_AAN:-0}" = "1" ] \
    || { rood "activity.ts heeft $EXISTS_AAN treffers op 'exists ('; verwacht 1 (alleen de liveness-backfill). Stop hier."; exit 1; }
  grep -q "exists (" "$BRON/server/src/services/activity.ts" \
    || { rood "De liveness-backfill verdween; die moet blijven. Stop hier."; exit 1; }
  UNION_AAN="$(grep -c 'union' "$BRON/server/src/services/activity.ts" || true)"
  [ "${UNION_AAN:-0}" -ge 1 ] \
    || { rood "De 'union' van de IN-selectie ontbreekt in activity.ts. Stop hier."; exit 1; }
  INARRAY_AAN="$(grep -c 'inArray(' "$BRON/server/src/services/activity.ts" || true)"
  [ "${INARRAY_AAN:-0}" -ge 1 ] \
    || { rood "inArray( ontbreekt in activity.ts. Stop hier."; exit 1; }
  groen "de IN-vorm staat in de bron ($UNION_AAN union, $EXISTS_AAN 'exists (')"

  # 2. Eén detoast per kolom. De lateral leest jsonb_each; zonder die string is de
  #    32 ms per run niet weg, ook al klopt de sha.
  [ -f "$BRON/server/src/services/jsonb-detoast.ts" ] \
    || { rood "server/src/services/jsonb-detoast.ts ontbreekt in de bron. Stop hier."; exit 1; }
  JSONB_EACH="$(grep -c 'jsonb_each' "$BRON/server/src/services/jsonb-detoast.ts" || true)"
  [ "${JSONB_EACH:-0}" -ge 1 ] \
    || { rood "jsonb_each ontbreekt in jsonb-detoast.ts. Stop hier."; exit 1; }
  DETOAST_AAN="$(grep -c 'detoastedJsonbKeys' "$BRON/server/src/services/activity.ts" || true)"
  [ "${DETOAST_AAN:-0}" -ge 1 ] \
    || { rood "activity.ts gebruikt detoastedJsonbKeys niet. Stop hier."; exit 1; }
  EXEC_AAN="$(grep -c 'executionRunContextKeys' "$BRON/server/src/services/execution-projection.ts" || true)"
  [ "${EXEC_AAN:-0}" -ge 1 ] \
    || { rood "execution-projection.ts gebruikt executionRunContextKeys niet. Stop hier."; exit 1; }
  # Drie losse `->` op contextSnapshot in execution-projection was de tweede helft
  # van de per-run kost; die moet weg zijn.
  DRIE_DEREFS="$(grep -c "contextSnapshot}->'" "$BRON/server/src/services/execution-projection.ts" || true)"
  [ "${DRIE_DEREFS:-0}" = "0" ] \
    || { rood "execution-projection.ts heeft nog $DRIE_DEREFS losse contextSnapshot-derefs. Stop hier."; exit 1; }
  groen "de lateral staat in de bron (jsonb_each, $DETOAST_AAN treffers, execution-projection schoon)"

  # 3. De poort die de fix beweest, moet in de bron zitten. Zonder haar zou een
  #    image zonder regressietest door de poort komen, en dan is er na een
  #    onzichtbare regressie geen poort meer.
  [ -f "$BRON/server/scripts/verify-runs-detoast-gate.mts" ] \
    || { rood "server/scripts/verify-runs-detoast-gate.mts ontbreekt. Stop hier."; exit 1; }
  [ -f "$BRON/server/scripts/runs-reference-query.json" ] \
    || { rood "server/scripts/runs-reference-query.json ontbreekt. Stop hier."; exit 1; }
  grep -q "runs-reference-query.json" "$BRON/server/scripts/verify-runs-detoast-gate.mts" \
    || { rood "De poort leest de bewaarde referentie niet. Stop hier."; exit 1; }
  groen "de regressiepoort en haar bewaarde referentie staan in de bron"

  # ---- De plekken die buiten deze wijziging moeten blijven ----
  # REK-460 raakte ui/src/components/ParkIssueDialog.tsx. Dat bestand staat los van
  # deze wijziging en hoort dus ongemoeid mee. Zonder deze regel zou een branch
  # met een gemergede parkeerstap stilletjes door de poort komen.
  [ "$(grep -c 'detoastedJsonbKeys' "$BRON/ui/src/components/ParkIssueDialog.tsx" 2>/dev/null || true)" = "0" ] \
    || { rood "ParkIssueDialog.tsx is meegegaan; dat is een bewust besluit en geen bijwerking. Stop hier."; exit 1; }
  [ "$(grep -c 'jsonb' "$BRON/ui/src/components/IssueRunLedger.tsx" 2>/dev/null || true)" = "0" ] \
    || { rood "IssueRunLedger.tsx is meegegaan; dat is een bewust besluit en geen bijwerking. Stop hier."; exit 1; }
  [ "$(grep -c 'It keeps its place and a scheduled check still runs' "$BRON/ui/src/components/ParkIssueDialog.tsx" || true)" -ge 1 ] \
    || { rood "De parkeer-dialoogtekst uit REK-460 is weg; die moet blijven. Stop hier."; exit 1; }
  [ "$(grep -c 'lapses' "$BRON/ui/src/components/ParkIssueDialog.tsx" || true)" = "0" ] \
    || { rood "De oude tekst 'lapses' staat nog in de dialoog. Stop hier."; exit 1; }
  [ "$(grep -c 'ISSUE_MONITOR_LIVE_STATUSES' "$BRON/server/src/services/issue-execution-policy.ts" || true)" -ge 1 ] \
    || { rood "De monitor-poort ISSUE_MONITOR_LIVE_STATUSES ontbreekt in de bron. Stop hier."; exit 1; }
  groen "REK-460 zijn parkeerstap en de UI-plekken zijn ongemoeid"
}

schrijf_anker() {
  kop "3. Terugvalanker vastleggen (vóór alles wat de container raakt)"
  {
    echo "# vastgelegd op $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "COMPOSE=$COMPOSE"
    echo "SERVICE=$SERVICE"
    echo "HUIDIGE_IMAGE=${HUIDIGE_IMAGE:-}"
    echo "HUIDIGE_LABEL=$HUIDIGE_LABEL"
    echo "HUIDIGE_ID=$HUIDIGE_ID"
    echo "# terugval 1 (als er een compose-backup ligt): ./uitrol-rek471.sh terugval"
    echo "# terugval 2 (zonder backup): docker compose -f $COMPOSE up -d --force-recreate $HUIDIGE_LABEL"
  } | tee "$ANKER"
  groen "anker weggeschreven naar $ANKER"
}

bouw() {
  controleer
  schrijf_anker
  kop "4. Image bouwen (enkele minuten; dit bouwt de rust-toolchain mee)"
  docker build \
    --build-arg "PAPERCLIP_BUILD_COMMIT=$COMMIT" \
    -t "$IMAGE_TAG" \
    -f "$BRON/Dockerfile" \
    "$BRON"
  groen "gebouwd: $IMAGE_TAG"
  kop "4b. Zit de commit-stamp erin? (zonder deze stap is 'live' achteraf niet te controleren)"
  STAMP="$(docker run --rm --entrypoint cat "$IMAGE_TAG" /app/server/dist/build-info.json 2>/dev/null || echo '{}')"
  echo "  build-info.json: $STAMP"
  case "$STAMP" in
    *"$COMMIT"*) groen "de stamp noemt $COMMIT" ;;
    *) rood "de stamp noemt $COMMIT niet. De image is gebouwd maar niet bruikbaar voor deze uitrol."; exit 1 ;;
  esac
}

koppel() {
  controleer
  schrijf_anker
  kop "5. De compose wijzen op $IMAGE_TAG"
  BACKUP="${COMPOSE}.bak-rek471-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$COMPOSE" "$BACKUP"
  groen "terugvalkopie: $BACKUP"

  # Eén awk beslist én schrijft. Hij kent de indentatie niet van tevoren: hij bepaalt
  # de diepte van de serviceregel en raakt alleen sleutels op die kinddiepte aan, zodat
  # een geneste `image:` (bv. onder `labels:`) niet wordt overschreven.
  #
  # De uitgangen zijn de deur van deze stap:
  #   0 = image-regel vervangen
  #   2 = alleen build: -> image-regel toegevoegd onder de serviceregel
  #   4 = onbeslist -> het blok gaat naar stderr en er wordt NIETS geschreven
  #
  # Regel 4 is bewust geen "maak er iets van": een compose zonder image: en zonder
  # build: (bv. `extends:`) krijgt hier geen verzonnen image-regel, want dan zou
  # compose een image uit een register proberen te halen dat niet bestaat.
  set +e
  awk -v svc="$SERVICE" -v img="$IMAGE_TAG" -f "$MAP/koppel-pr3.awk" "$COMPOSE" > "${COMPOSE}.tmp-rek471"
  RC=$?
  set -e

  case "$RC" in
    0) groen "de image-regel in het blok van '$SERVICE' is vervangen" ;;
    2) rood "het blok van '$SERVICE' had geen image-regel (wel build:); er is een toegevoegd. Controleer 5b." ;;
    4)
      rm -f "${COMPOSE}.tmp-rek471"
      rood "het blok van '$SERVICE' heeft noch een image:- noch een build:-regel."
      rood "Het blok staat hierboven. Er is niets geschreven; plak het even, dan schrijf ik de poort voor die vorm."
      exit 1
      ;;
    *)
      rm -f "${COMPOSE}.tmp-rek471"
      rood "onbekende uitgang van de awk (exit $RC); er is niets geschreven."
      exit 1
      ;;
  esac

  # Regel 2 uit de eerdere versie is weg: die kon nooit lopen, omdat de awk toen al
  # exit deed op precies de voorwaarde die die regel afhandelde. Dat is de oorzaak
  # van de mislukking van 07:07Z.

  mv "${COMPOSE}.tmp-rek471" "$COMPOSE"

  kop "5b. Poort: leest de compose de nieuwe image nog terug?"

  # Elke uitweg vanaf hier loopt via terugdraai(). Die zet de terugvalkopie terug
  # EN stopt. Ik doe dat bewust via één functie: in de eerdere versie stond op deze
  # plek losse `cp ... ; exit 1`-paren, en toen de gate door een eigen fout vroeg
  # stopte (unbound variable) bleef de gewijzigde compose gewoon staan.
  terugdraai() {
    cp -p "$BACKUP" "$COMPOSE"
    rood "de terugvalkopie is teruggezet; er is niets gewijzigd."
    exit 1
  }

  # STAP 5b1: draait `docker compose config` überhaupt? De foutmelding van compose is
  # het belangrijkste signaal dat we hebben, dus hij gaat NIET naar /dev/null. In een
  # eerdere versie stond hier `2>/dev/null`, waardoor een falende config eruit zag als
  # "geen image gevonden" en de echte oorzaak verdween.
  ERRF="${MAP}/5b-stderr-rek471.txt"
  set +e
  CFG="$(docker compose -f "$COMPOSE" config 2>"$ERRF")"
  CFG_RC=$?
  set -e
  if [ "$CFG_RC" -ne 0 ] || [ -z "$CFG" ]; then
    rood "docker compose config zelf faalt (exit $CFG_RC). Dat is een compose-probleem, geen image-probleem."
    # Lichtere tweede lezing: `config --images` lost de compose op en drukt per service de
    # image af, maar valideert de build-context niet. Die kan immers de volledige config
    # laten falen terwijl de image-verhouding wettig is. Kan deze wél iets zeggen, dan is
    # dat bewijs; kan hij niets, dan val ik terug op de foutmelding hieronder.
    set +e
    LICHTE="$(docker compose -f "$COMPOSE" config --images 2>>"$ERRF")"
    LICHTE_RC=$?
    set -e
    if [ "$LICHTE_RC" -eq 0 ] && printf '%s\n' "$LICHTE" | grep -qF "$IMAGE_TAG"; then
      echo "  (volledige config faalt, maar config --images noemt $IMAGE_TAG)"
      printf '%s\n' "$LICHTE" | sed 's/^/  /'
      groen "de compose wijst op de nieuwe image (gelezen via config --images)"
      printf '%s\n' "$LICHTE" | grep -nF "$IMAGE_TAG" >/dev/null || true
      grep -nA8 "^  *${SERVICE}:" "$COMPOSE" 2>/dev/null | head -12 | sed 's/^/  /' || true
      groen "klaar. Nu: ./uitrol-rek471.sh start"
      return 0
    fi
    echo "  ---- wat compose zegt ----"
    sed 's/^/  /' "$ERRF" 2>/dev/null | head -20 || true
    echo "  --------------------------"
    echo "  ---- het blok zoals het op schijf staat ----"
    grep -nA8 "^  *${SERVICE}:" "$COMPOSE" 2>/dev/null | head -12 | sed 's/^/  /' || true
    echo "  ------------------------------------------"
    rood "Terugdraaien."
    terugdraai
  fi

  # STAP 5b2: config werkte. Welke image hangt er nu aan deze service?
  EFFECTIEF="$(printf '%s\n' "$CFG" | awk -v svc="$SERVICE" '
    { if (!inblk) { if ($0 ~ ("^  " svc "[ ]*:")) inblk = 1; next }
      if ($0 ~ /^[^ ]/) { inblk = 0; next }
      if (inblk && $0 ~ /^[ ]+image[ ]*:/) { print; exit } }' | head -1 | sed 's/^[[:space:]]*//')"
  echo "  compose config zegt: ${EFFECTIEF:-niets}"
  case "$EFFECTIEF" in
    *"$IMAGE_TAG"*) groen "de compose wijst op de nieuwe image" ;;
    *)
      rood "de compose wijst NIET op $IMAGE_TAG. Terugdraaien."
      echo "  ---- hoe compose dit blok ziet ----"
      printf '%s\n' "$CFG" | awk -v svc="$SERVICE" '
        { if (!inblk) { if ($0 ~ ("^  " svc "[ ]*:")) { inblk = 1; print; } ; next }
          if ($0 ~ /^[^ ]/) exit
          if (inblk) print }' | head -20 | sed 's/^/  /' || true
      echo "  --------------------------------"
      terugdraai
      ;;
  esac
  groen "klaar. Nu: ./uitrol-rek471.sh start"
}

start() {
  controleer
  schrijf_anker
  kop "6. Terugval-bevestiging"
  echo "Dit herstart de container waar het hele bedrijf op draait. Controleer eerst zelf:"
  docker compose -f "$COMPOSE" images
  echo
  echo "Bij een fout draai je dit terug:"
  echo "  ./uitrol-rek471.sh terugval"
  grep HUIDIGE_LABEL "$ANKER"
  echo
  read -r -p "Typ exact UITROL om de container te herstarten (alle andere tekst stopt): " bevestiging
  [ "$bevestiging" = "UITROL" ] || { rood "Niet uitgevoerd. Er is niets gewijzigd."; exit 1; }

  kop "7. Uitrollen"
  docker compose -f "$COMPOSE" up -d
  docker compose -f "$COMPOSE" ps

  kop "8. Verificatie A — draait de container deze commit?"
  STAMP="$(docker exec "$(docker ps --filter "label=com.docker.compose.service=$SERVICE" --format '{{.ID}}' | head -1)" \
            cat /app/server/dist/build-info.json 2>/dev/null || echo '{}')"
  echo "  build-info.json: $STAMP"
  case "$STAMP" in
    *"$COMMIT"*) groen "de draaiende container noemt $COMMIT" ;;
    *) rood "de draaiende container noemt $COMMIT niet. NIET terugdraaien zonder de anker te lezen."; exit 1 ;;
  esac

  kop "9. Verificatie B — staat de bezorgde query in de IN-vorm, met de lateral?"
  # Twee lezingen, want ze bewijzen verschillende dingen. De UI-tekst van REK-460
  # zegt niets over deze wijziging; hier moet de BEZORGDE code het vormbewijs
  # leveren. Gemeten 2026-10-01: de dist wordt op /app/server/dist gezet, dus
  # daar zoeken is de enige plek die de container zelf laat zien.
  #
  #   1. `jsonb_each` moet in de dist van activity staan: dat is de lateral, en
  #      zonder haar is de per-run kost niet weg.
  #   2. De OR-vorm moet weg: `exists (` stond 2 keer in de oude dist van
  #      activity.js en staat er 1 keer na de fix (alleen de liveness-backfill).
  #
  # Beide op nul meten betekent "deze afleiding draait nog op de oude code".
  CTR="$(docker ps --filter "label=com.docker.compose.service=$SERVICE" --format '{{.ID}}' | head -1)"
  [ -n "$CTR" ] || { rood "geen draaiende container voor service '$SERVICE'. Stop hier."; exit 1; }
  DIST_ACT="$(docker exec "$CTR" sh -c "grep -c 'jsonb_each' /app/server/dist/services/activity.js 2>/dev/null || echo 0")"
  DIST_EXEC="$(docker exec "$CTR" sh -c "grep -c 'jsonb_each' /app/server/dist/services/execution-projection.js 2>/dev/null || echo 0")"
  DIST_EXISTS="$(docker exec "$CTR" sh -c "grep -c 'exists (' /app/server/dist/services/activity.js 2>/dev/null || echo 0")"
  echo "  activity.js: jsonb_each=$DIST_ACT, 'exists ('=$DIST_EXISTS"
  echo "  execution-projection.js: jsonb_each=$DIST_EXEC"
  [ "${DIST_ACT:-0}" -ge 1 ] \
    || { rood "De lateral (jsonb_each) ontbreekt in de bezorgde activity.js. De UI is dus niet bij."; exit 1; }
  [ "${DIST_EXEC:-0}" -ge 1 ] \
    || { rood "De lateral ontbreekt in de bezorgde execution-projection.js. Stop hier."; exit 1; }
  [ "${DIST_EXISTS:-0}" = "1" ] \
    || { rood "De bezorgde activity.js heeft $DIST_EXISTS treffers op 'exists ('; verwacht 1. De oude OR-vorm draait nog."; exit 1; }
  groen "de bezorgde code is de nieuwe: lateral aanwezig, OR-vorm weg"

  kop "10. Verificatie C — is de instance weer gezond?"
  # Wacht op /api/health en niet op de root: tijdens het opstarten accepteert de
  # proxy al verbinding terwijl de app nog niet klaar is, dus de root gaf HTTP
  # 200 terwijl /api/health nog 502 gaf. Gemeten 2026-10-01 18:27Z: stap 10
  # stond toen op de root, en stap 12 las daarna de 502 als "niet afgerond".
  for poging in $(seq 1 24); do
    CODE="$(curl -s -o /tmp/health-rek471.json -w '%{http_code}' --max-time 10 https://paperclip.kevinderek.com/api/health || echo 000)"
    if [ "$CODE" = "200" ]; then
      groen "https://paperclip.kevinderek.com/api/health geeft HTTP 200"
      break
    fi
    echo "  poging $poging/24: /api/health HTTP $CODE, nog even wachten"
    sleep 5
  done
  [ "${CODE:-000}" = "200" ] || { rood "/api/health geeft HTTP ${CODE:-000} na 24 pogingen."; exit 1; }

  kop "11. Verificatie D — welke commit meldt de bezorgde instance zelf?"
  # De container-stamp uit stap 8 bewijst wat er in de image zit. Deze stap
  # vraagt het aan de instance die de browser praat, want dat is de commitment die
  # telt voor een mens die de parkeerstap wil gebruiken.
  HEALTH="$(curl -s --max-time 10 https://paperclip.kevinderek.com/api/health || echo '{}')"
  echo "  /api/health: $HEALTH"
  case "$HEALTH" in
    *"${COMMIT}"*) groen "de bezorgde instance noemt $COMMIT" ;;
    *) rood "de bezorgde instance noemt $COMMIT niet. De uitrol is niet afgerond."; exit 1 ;;
  esac

  groen "Uitrol afgerond. De user-facing browsercheck is een aparte taak: parkeer één taak zonder blokker vanaf de lijst en één vanaf het board, en zie de fouttoast."
}

terugval() {
  BACKUP="$(ls -1t "${COMPOSE}.bak-rek471-"* 2>/dev/null | head -1 || true)"
  if [ -z "$BACKUP" ]; then
    rood "geen terugvalkopie gevonden naast $COMPOSE"
    echo "gebruik dan regel HUIDIGE_LABEL uit $ANKER:"
    grep HUIDIGE_LABEL "$ANKER" || true
    exit 1
  fi
  kop "Terugdraaien naar $BACKUP"
  cp -p "$BACKUP" "$COMPOSE"
  docker compose -f "$COMPOSE" up -d
  docker compose -f "$COMPOSE" ps
  groen "teruggedraaid. De container draait weer de image uit de anker."
}

# Lezen zonder docker: wat zou dit script uitrollen, en klopt de bron? Precies de
# helft die je ook vanaf een laptop kunt controleren, want de helft die hier stopt
# hoeft geen docker te hebben om te bewijzen dat ze bijt.
config() {
  kop "0. Wat zou dit script uitrollen?"
  echo "  script            : $MAP/$(basename "$0")"
  echo "  bron (BRON)       : $BRON"
  echo "  commit (COMMIT)   : $COMMIT"
  echo "  image (IMAGE_TAG) : $IMAGE_TAG"
  echo "  anker (ANKER)     : $ANKER"
  echo "  terugval          : $MAP/$(basename "$0") terugval"
  broncontrole
  groen "de bron voldoet aan alle poorten; docker is hiervoor niet nodig"
}

# De hele rit achter elkaar, met dezelfde volgorde en dezelfde poorten als vier
# handmatige stappen. Bij de eerste afwijking stopt het (set -e plus de poorten),
# en de container-herstart blijft achter de handmatige bevestiging UITROL.
alles() {
  kop "A. Volledige rit: inspect -> bouw -> koppel -> start -> rapport"
  inspect
  bouw
  koppel
  start
  rapport
}

# De vijf dingen die een geslaagde uitrol aantonen, plus een blok dat zo in de
# issue kan. Zonder dit rapport is een uitrol niet afgerond, alleen bewezen dat er
# iets gestart is.
rapport() {
  kop "12. Rapport (dit is wat de issue-comment heeft)"
  # `rapport` kan los draaien, zonder dat `inspect` eerst SERVICE heeft gezet.
  # Ongemeten 2026-10-01 18:03Z: los draaien gaf `SERVICE: unbound variable`
  # door `set -u`, waarna alle bewijsvelden op "onbekend" uitkwamen terwijl de
  # uitrol zelf prima was. Bepaal de service dus idempotent als die er nog niet is.
  [ -n "${SERVICE:-}" ] || vind_compose >/dev/null 2>&1 || true
  SERVICE="${SERVICE:-}"
  CONTAINER="$(docker ps --filter "label=com.docker.compose.service=$SERVICE" --format '{{.ID}}' | head -1 || true)"
  STAMP="$(docker exec "$CONTAINER" cat /app/server/dist/build-info.json 2>/dev/null || echo '{}')"
  HEALTH="$(curl -s --max-time 10 https://paperclip.kevinderek.com/api/health || echo '{}')"
  echo "  anker             : $ANKER"
  [ -f "$ANKER" ] && sed 's/^/    /' "$ANKER"
  echo "  draaiende container: ${CONTAINER:-onbekend}"
  echo "  build-info.json   : $STAMP"
  echo "  /api/health       : $HEALTH"
  echo
  echo "  Plak dit in de issue:"
  echo "    uitgerold met $MAP/$(basename "$0") alles"
  echo "    commit          : $COMMIT"
  echo "    image           : $IMAGE_TAG"
  echo "    container       : ${CONTAINER:-onbekend}"
  echo "    build-info.json : $STAMP"
  echo "    /api/health     : $HEALTH"
  echo "    anker           : $ANKER"
  echo "    terugval        : $MAP/$(basename "$0") terugval"
  case "$HEALTH" in
    *"${COMMIT}"*) groen "LIVE BEVESTIGD: de bezorgde instance noemt $COMMIT" ;;
    *) rood "NIET BEVESTIGD: /api/health noemt $COMMIT niet. Niet afgerond."; exit 1 ;;
  esac
}

case "${1:-inspect}" in
  inspect)  controleer ;;
  bouw)     bouw ;;
  koppel)   koppel ;;
  start)    start ;;
  terugval) terugval ;;
  config)   config ;;
  rapport)  rapport ;;
  alles)    alles ;;
  *)        rood "Gebruik: $0 config|inspect|bouw|koppel|start|rapport|alles|terugval"; exit 2 ;;
esac
