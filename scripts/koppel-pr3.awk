# Herschrijft het blok van één compose-service zodat het op `img` wijst.
#
# Ontwerp: geen aanname over de indentatie of over de vorm van de sleutelregel. We
# bepalen de indentatie van de serviceregel zelf en raken daarna alleen sleutels die
# op KINDDIEPTE van het blok staan, zodat een geneste `image:` (bijv. onder
# `labels:` of `build:` → `args:`) niet wordt aangeraakt.
#
# De hele compose wordt gebufferd (deze bestanden zijn klein) zodat we eerst kunnen
# bepalen WAT er moet gebeuren en pas daarna schrijven. Zo is "niets te bepalen"
# echt "niets geschreven", en niet "half geschreven".
#
# Uitgangen (AWK): 0 = image-regel vervangen, 2 = image-regel toegevoegd direct
# onder de serviceregel, 4 = niet te bepalen -> het blok gaat naar stderr en er wordt
# niets geschreven.

function count_indent(s,   t) { t = s; sub(/[^ ].*$/, "", t); return length(t) }

function key_name(s, ind,   rest, name) {
  rest = substr(s, ind + 1)
  if (rest !~ /^[A-Za-z0-9_.-]+[ ]*:/) return ""
  name = rest
  sub(/[ ]*:.*$/, "", name)
  return name
}

# Komt regel s overeen met de serviceregel? Zet IND.
# Toegestaan zijn `paperclip:`, `"paperclip":` en een trailing comment; een inline
# waarde (`paperclip: &anchor`) niet, want dat is geen blokkop.
function match_service(s,   re) {
  re = "^[ ]*(\"" svc "\"|" svc ")[ ]*:[ ]*(#.*)?$"
  if (s !~ re) return 0
  IND = count_indent(s)
  return 1
}

{ L[NR] = $0 }

END {
  # --- fase 1: het serviceregel vinden -------------------------------------
  for (i = 1; i <= NR; i++) if (match_service(L[i])) { keyline = i; break }
  if (!keyline) { print "kon de serviceregel voor '" svc "' niet vinden" > "/dev/stderr"; exit 4 }

  ind = IND
  # --- fase 2: het blok grenzen en de kinddiepte bepalen -------------------
  end = NR; child = -1
  for (i = keyline + 1; i <= NR; i++) {
    s = L[i]
    if (s ~ /^[ ]*$/ || s ~ /^[ ]*#/) continue
    ci = count_indent(s)
    if (ci <= ind) { end = i - 1; break }
    if (child < 0) child = ci
  }
  if (end < keyline) end = NR

  # --- fase 3: wat doen we? Alleen sleutels op kinddiepte tellen -----------
  imageline = 0; sawbuild = 0
  if (child > 0) {
    for (i = keyline + 1; i <= end; i++) {
      k = key_name(L[i], child)
      if (k == "image") { imageline = i; break }
      if (k == "build") sawbuild = 1
    }
  }

  if (!imageline && !sawbuild) {
    for (i = keyline; i <= end; i++) print L[i] > "/dev/stderr"
    exit 4
  }

  # --- fase 4: schrijven --------------------------------------------------
  pad = ""
  for (j = 0; j < (imageline ? child : child); j++) pad = pad " "
  for (i = 1; i <= NR; i++) {
    if (i == imageline) { print pad "image: " img; continue }
    print L[i]
    if (imageline == 0 && i == keyline) print pad "image: " img
  }
  exit (imageline ? 0 : 2)
}