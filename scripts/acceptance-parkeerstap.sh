#!/usr/bin/env bash
#
# Meet of de parkeerstap ("In afwachting" zonder blokker) echt bezorgd is.
#
#   ./scripts/acceptance-parkeerstap.sh [verwachte-commit]
#
# Leest uitsluitend. Raakt niets aan, schrijft niets, en draait prima vanaf een
# laptop of een run-scratch: alles gaat over HTTPS naar de bezorgde instance.
#
# Waarom niet alleen /api/health: dat bewijst dat de container de goede commit
# draait, niet dat de browser de parkeerstap krijgt. Deze meting haalt de
# bezorgde UI-chunk op en zoekt de tekst van de parkeer-dialoog erin. De
# commit-stamp en de UI zijn twee verschillende schijfschijven; wie ze samen
# meet, meet iets.
#
# Elke poort heeft hier een positieve controle in hetzelfde bestand, want een
# "niet gevonden" zonder tegenproef is geen meting:
#   poort 1  /api/health noemt de verwachte commit
#   poort 2  de bezorgde chunk bevat de parkeertekst        (tegenproef: 3)
#   poort 3  diezelfde chunk bevat de diagnosezin "Blocked ·"
#   poort 4  de chunk is geen lege of foutieve response
set -euo pipefail

INSTANTIE="${INSTANTIE:-https://paperclip.kevinderek.com}"
VERWACHT="${1:-}"
if [ -z "$VERWACHT" ]; then
  VERWACHT="$(git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" rev-parse HEAD 2>/dev/null || true)"
fi
[ -n "$VERWACHT" ] || { printf 'geen verwachte commit meegegeven en geen bron om HEAD uit te halen\n' >&2; exit 2; }

PARKERTEKST="No agent picks it up while it waits"
DIAGNOSEZIN="Blocked ·"

rood()  { printf '\033[31m%s\033[33m\n' "$*" >&2; }
groen() { printf '\033[32m%s\033[0m\n' "$*" >&2; }
kop()   { printf '\n== %s\n' "$*"; }

kop "1. Welke commit meldt de bezorgde instance?"
HEALTH="$(curl -fsS --max-time 15 "$INSTANTIE/api/health" || echo '{}')"
GEMELDEN="$(printf '%s' "$HEALTH" | sed -n 's/.*"commit":"\([0-9a-f]\{7,40\}\)".*/\1/p' | head -1)"
echo "  gemeten  : ${GEMELDEN:-geen}"
echo "  verwacht : $VERWACHT"
if [ "$GEMELDEN" != "$VERWACHT" ]; then
  rood "De bezorgde instance draait $GEMELDEN, niet $VERWACHT. De uitrol is niet afgerond."
  exit 1
fi
groen "de bezorgde instance noemt $GEMELDEN"

kop "2. Welke UI-chunk hoort bij de statusknop?"
INDEX="$(curl -fsS --max-time 20 "$INSTANTIE/" || echo '')"
CHUNK="$(printf '%s' "$INDEX" | grep -oE '/assets/StatusIcon-[A-Za-z0-9_-]+\.js' | head -1 || true)"
if [ -z "$CHUNK" ]; then
  rood "Geen StatusIcon-chunk gevonden in de index van $INSTANTIE. Poort 4: de index is leeg of onleesbaar ($(printf '%s' "$INDEX" | wc -c) tekens)."
  exit 1
fi
echo "  chunk    : $CHUNK"
UI="$(curl -fsS --max-time 20 "$INSTANTIE$CHUNK" || echo '')"
BYTES="$(printf '%s' "$UI" | wc -c)"
echo "  bytes    : $BYTES"
if [ "$BYTES" -lt 500 ]; then
  rood "De chunk is $BYTES bytes. Poort 4: dat is geen UI-bestand."
  exit 1
fi

kop "3. Tegenproef: is dit echt de chunk met de blocked-diagnose?"
if printf '%s' "$UI" | grep -qF "$DIAGNOSEZIN"; then
  groen "de diagnosezin staat erin, dus we lezen de juiste chunk"
else
  rood "de diagnosezin '$DIAGNOSEZIN' ontbreekt. Lees de verkeerde chunk; port 2 zou hier oneerlijk rood zijn."
  exit 1
fi

kop "4. Staat de parkeerstap in de bezorgde UI?"
if printf '%s' "$UI" | grep -qF "$PARKERTEKST"; then
  groen "de parkeerstap zit in de bezorgde UI"
else
  rood "de parkeerstap zit niet in de bezorgde UI. De container draait de commit wel, maar een mens krijgt de knop niet."
  exit 1
fi

printf '\n'
groen "BEVESTIGD: commit $GEMELDEN én de parkeerstap zijn beide bezorgd."
printf 'Controleer nu in een browser: een taak zonder blokker parkeren vanaf de lijst,\n'
printf 'een vanaf het board, en een afgewezen poging om de fouttoast te zien.\n'
