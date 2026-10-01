#!/usr/bin/env bash
#
# Uitrol van REK-439 op de Paperclip-instance.
#
# Commit f6ece823 voegt de parkeerstap toe: een mens zet een taak zelf in
# "In afwachting", ook zonder blokkerende issue. UI-only, geen migratie, de 422
# op `blocked` blijft staan.
#
# Het script is idempotent, gokt nergens en weigert te starten als iets niet klopt.
# Elke stap is apart uitvoerbaar, zodat je niet alles in één keer hoeft te doen:
#
#   ./uitrol-rek439.sh config      # alleen lezen: wat zou er uitrollen, en klopt de bron? (geen docker nodig)
#   ./uitrol-rek439.sh alles       # de volledige rit in één keer, met rapport; vraagt om het woord UITROL
#   ./uitrol-rek439.sh inspect     # alleen laten zien wat er draait (niets schrijven)
#   ./uitrol-rek439.sh bouw        # image bouwen vanaf de commit (duurt enkele minuten)
#   ./uitrol-rek439.sh koppel      # compose op de nieuwe image wijzen, met terugvalkopie
#   ./uitrol-rek439.sh start       # container herstarten, daarna harde verificatie
#   ./uitrol-rek439.sh rapport     # de vijf bewijsstukken + een blok om in de issue te plakken
#   ./uitrol-rek439.sh terugval    # de vorige image terugzetten
#
# De bron moet op de host klaarstaan op f6ece823, samen met dit script en
# koppel-pr3.awk, in /home/kevin/paperclip/data/docker-paperclip/uitrol.
#
# Host-pad van deze map: /home/kevin/paperclip/data/docker-paperclip/uitrol
set -euo pipefail

MAP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# BRON is te overschrijven, zodat een bestaande clone bruikbaar blijft: de PR-3-uitrol
# heeft /home/kevin/paperclip/data/docker-paperclip/uitrol/paperclip-pr3 al neergezet.
#   BRON=$PWD/paperclip-pr3 ./uitrol-rek439.sh alles
BRON="${BRON:-${MAP}/paperclip-rek439}"
# Zonder COMMIT rolt dit script uit wat er in de bron staat, en niets anders. Een
# expliciete COMMIT blijft mogelijk en wordt gecontroleerd, zodat een verouderde
# checkout niet stilletjes live gaat.
COMMIT="${COMMIT:-$(git -C "$BRON" rev-parse HEAD 2>/dev/null || true)}"
COMMIT="${COMMIT:-f6ece823ab1bba35c016c9fdb869ab6c5ba0ed90}"
IMAGE_TAG="paperclip-rek439:${COMMIT:0:12}"
# Het anker hoort naast de clone, niet erin: anders komt de working tree van de
# host vol te staan met een bestand dat er niet in hoort, en een volgende
# `git pull` ziet onverwachte wijzigingen.
REPO_ROOT="$(git -C "$MAP" rev-parse --show-toplevel 2>/dev/null || echo "$MAP")"
ANKER="${ANKER:-$(dirname "$REPO_ROOT")/terugval-anker-rek439.txt}"

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
  BRON_HEAD="$(git -C "$BRON" rev-parse HEAD)"
  if [ "$BRON_HEAD" != "$COMMIT" ]; then
    rood "Bron staat op $BRON_HEAD, verwacht $COMMIT. Stop hier, verkeerde basis."
    exit 1
  fi
  groen "bron    : $BRON @ $BRON_HEAD"

  LABEL="$(grep -c 'In afwachting' "$BRON/ui/src/lib/issue-status-labels.ts" || true)"
  [ "${LABEL:-0}" -ge 1 ] || { rood "De statusnaam 'In afwachting' ontbreekt in de bron. Stop hier."; exit 1; }
  groen "statuslabel in de bron ($LABEL treffers)"

  # Wat deze uitrol daadelijk moet bezorgen. Zonder deze poort zou een image met
  # de oude parkeerstap of zonder parkeerstap door de poort komen.
  [ -f "$BRON/ui/src/lib/park-issue.ts" ] \
    || { rood "ui/src/lib/park-issue.ts ontbreekt in de bron. Stop hier."; exit 1; }
  [ "$(grep -c 'No agent picks it up while it waits' "$BRON/ui/src/components/ParkIssueDialog.tsx" || true)" -ge 1 ] \
    || { rood "De parkeer-dialoog ontbreekt in de bron. Stop hier."; exit 1; }
  groen "de parkeerstap staat in de bron"

  # De plekken die buiten deze wijziging moeten blijven, en de diagnosezinnen die
  # StatusIcon.tsx uit REK-425 in ere hield. Die laatste staan in het bestand dat
  # deze uitrol aanraakt, dus ze horen hier.
  [ "$(grep -c 'In afwachting' "$BRON/ui/src/lib/external-objects.ts" || true)" = "0" ] \
    || { rood "external-objects.ts is meegegaan; dat is een bewust besluit en geen bijwerking. Stop hier."; exit 1; }
  [ "$(grep -c 'In afwachting' "$BRON/ui/src/components/IssueRunLedger.tsx" || true)" = "0" ] \
    || { rood "IssueRunLedger.tsx is meegegaan; dat is een bewust besluit en geen bijwerking. Stop hier."; exit 1; }
  [ "$(grep -c 'Blocked ·' "$BRON/ui/src/components/StatusIcon.tsx" || true)" -ge 4 ] \
    || { rood "De diagnosezinnen 'Blocked · …' zijn weg; die moeten blijven. Stop hier."; exit 1; }
  groen "de uitgesloten plekken zijn ongemoeid, de diagnosezinnen staan er nog"
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
    echo "# terugval 1 (als er een compose-backup ligt): ./uitrol-rek439.sh terugval"
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
  BACKUP="${COMPOSE}.bak-rek439-$(date -u +%Y%m%dT%H%M%SZ)"
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
  awk -v svc="$SERVICE" -v img="$IMAGE_TAG" -f "$MAP/koppel-pr3.awk" "$COMPOSE" > "${COMPOSE}.tmp-rek439"
  RC=$?
  set -e

  case "$RC" in
    0) groen "de image-regel in het blok van '$SERVICE' is vervangen" ;;
    2) rood "het blok van '$SERVICE' had geen image-regel (wel build:); er is een toegevoegd. Controleer 5b." ;;
    4)
      rm -f "${COMPOSE}.tmp-rek439"
      rood "het blok van '$SERVICE' heeft noch een image:- noch een build:-regel."
      rood "Het blok staat hierboven. Er is niets geschreven; plak het even, dan schrijf ik de poort voor die vorm."
      exit 1
      ;;
    *)
      rm -f "${COMPOSE}.tmp-rek439"
      rood "onbekende uitgang van de awk (exit $RC); er is niets geschreven."
      exit 1
      ;;
  esac

  # Regel 2 uit de eerdere versie is weg: die kon nooit lopen, omdat de awk toen al
  # exit deed op precies de voorwaarde die die regel afhandelde. Dat is de oorzaak
  # van de mislukking van 07:07Z.

  mv "${COMPOSE}.tmp-rek439" "$COMPOSE"

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
  ERRF="${MAP}/5b-stderr-rek439.txt"
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
      groen "klaar. Nu: ./uitrol-rek439.sh start"
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
  groen "klaar. Nu: ./uitrol-rek439.sh start"
}

start() {
  controleer
  schrijf_anker
  kop "6. Terugval-bevestiging"
  echo "Dit herstart de container waar het hele bedrijf op draait. Controleer eerst zelf:"
  docker compose -f "$COMPOSE" images
  echo
  echo "Bij een fout draai je dit terug:"
  echo "  ./uitrol-rek439.sh terugval"
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

  kop "9. Verificatie B — staat de parkeerstap in het bezorgde UI-bestand?"
  TREFFERS="$(docker exec "$(docker ps --filter "label=com.docker.compose.service=$SERVICE" --format '{{.ID}}' | head -1)" \
              grep -rl 'No agent picks it up while it waits' /app/ui/dist 2>/dev/null | head -3 || true)"
  if [ -n "$TREFFERS" ]; then
    echo "$TREFFERS"
    groen "de parkeerstap zit in het bezorgde UI-bestand"
  else
    rood "de parkeerstap zit niet in /app/ui/dist. De UI is dus niet bij."
    exit 1
  fi

  kop "10. Verificatie C — is de instance weer gezond?"
  for poging in $(seq 1 12); do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://paperclip.kevinderek.com/ || echo 000)"
    if [ "$CODE" = "200" ]; then groen "https://paperclip.kevinderek.com geeft HTTP 200"; break; fi
    echo "  poging $poging/12: HTTP $CODE, nog even wachten"
    sleep 10
  done
  [ "${CODE:-000}" = "200" ] || { rood "de instance geeft HTTP ${CODE:-000} na 12 pogingen."; exit 1; }

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
  BACKUP="$(ls -1t "${COMPOSE}.bak-rek439-"* 2>/dev/null | head -1 || true)"
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
  kop "A1. Inspecteren (wat draait er, en klopt de bron)"
  controleer
  bouw
  koppel
  start
  rapport
}

# De vijf dingen die een geslaagde uitrol aantonen, plus een blok dat zo in de
# issue kan. Zonder dit rapport is een uitrol niet afgerond, alleen bewezen dat er
# iets gestart is.
rapport() {
  kop "12. Rapport (dit is wat de issue-comment nodig heeft)"
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
