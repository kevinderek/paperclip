/**
 * Controleert dat elk aanroep van een functie in een bash-script ook echt een
 * functie is.
 *
 *   node server/scripts/verify-functieaanroepen.mjs <pad-naar-script>
 *
 * De fout waar dit voor bestaat: in `scripts/uitrol-rek471.sh` riep `alles` de
 * naam `inspect` aan, en dat is alleen een naam in het dispatch-blok, geen
 * functie. Het script stopte met exit 127 op de regel na het kopje, dus de poort
 * die vóór elke write hoort te staan stond ná niets. Gemeten 2026-10-02.
 *
 * De dispatch-regel `inspect)  controleer ;;` is géén fout: daar is `inspect`
 * de schermnaam en `controleer` de functie. Daarom wordt het hele regelpaar
 * gelezen en gevraagd naar de functie rechts van de `)`.
 *
 * De naam is `verify-` en niet `check-`, omdat `.gitignore` regel 27 `check-*.mjs`
 * overal negeert en alleen voor `scripts/` en `.github/scripts/` een uitzondering
 * maakt. Een poort in `server/scripts/` die `check-` heet staat niet in de repo,
 * en een poort die niet in de repo staat is geen poort. Gemeten 2026-10-02.
 *
 * Dit is een poort op tekst, dus de regel die waarschuwt dat een meting over
 * tekst een momentopname is geldt hier ook:
 * de set aanroepen is een momentopname van het script zoals het op schijf staat,
 * niet een garantie voor een script dat iemand morgen's verandert. Daarom staat
 * de uitkomst ook in de PR en niet alleen in een groene exitcode.
 */
import { readFileSync } from "node:fs";

const pad = process.argv[2];
if (!pad) {
  console.error("gebruik: node server/scripts/verify-functieaanroepen.mjs <pad-naar-script>");
  process.exit(2);
}
const regels = readFileSync(pad, "utf8").split("\n");

const functies = new Set();
for (const regel of regels) {
  const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\(\) \{$/.exec(regel.trim());
  if (m) functies.add(m[1]);
}

// Woorden die in een functieblok op een regel van hun eigen kunnen staan zonder
// een functieaanroep te zijn: shell-sleutelwoorden en de built-ins die dit
// script gebruikt. Zonder deze lijst zou `echo` op een regel van zijn eigen als
// een functieaanroep gelden en gaf de poort vier rooden op een gezond script —
// gemeten 2026-10-02, en dat is het omgekeerde van wat een poort hoort te doen.
const SHELL = new Set([
  "esac", "then", "do", "else", "elif", "fi", "done", "in", "{", "}", ";;",
  "echo", "printf", "break", "continue", "exit", "return", "read", "local",
  "export", "set", "unset", "shift", "test", "true", "false", "sleep", "cd",
  "mkdir", "cp", "mv", "rm", "chmod", "awk", "grep", "sed", "seq", "tr", "cut",
  "sort", "uniq", "wc", "cat", "ls", "docker", "curl", "git",
]);

const aanroepen = [];
const dispatch = [];
let inCase = false;

regels.forEach((regel, i) => {
  const nr = i + 1;
  if (/^case "\$\{1:-/.test(regel)) inCase = true;

  if (inCase) {
    // `naam)  functie ;;`
    const d = /^\s+([a-z][a-z0-9]*)\)\s+([a-z][a-z0-9]*)\s*;;/.exec(regel);
    if (d) dispatch.push({ schermnaam: d[1], fn: d[2], nr });
    return;
  }

  // Een commando op een regel van zijn eigen, met niets erop.
  const a = /^\s+([a-z_][a-z0-9_]*)\s*$/.exec(regel);
  if (a && !SHELL.has(a[1])) aanroepen.push({ fn: a[1], nr });
});

const fouten = [];
for (const { fn, nr } of aanroepen) {
  if (!functies.has(fn)) fouten.push({ wat: "aanroep", naam: fn, nr });
}
for (const { schermnaam, fn, nr } of dispatch) {
  if (!functies.has(fn)) fouten.push({ wat: "dispatch", naam: `${schermnaam} -> ${fn}`, nr });
}

console.log(`script        : ${pad}`);
console.log(`functies      : ${functies.size} — ${[...functies].sort().join(", ")}`);
console.log(`aanroepen     : ${aanroepen.length}`);
console.log(`dispatch-regels: ${dispatch.length}`);
console.log();
for (const { schermnaam, fn, nr } of dispatch) {
  console.log(`  ${functies.has(fn) ? "ok      " : "ONBEVIND"} ${schermnaam.padEnd(10)} -> ${fn.padEnd(12)} (regel ${nr})`);
}

if (fouten.length > 0) {
  console.error();
  for (const f of fouten) console.error(`  ONBEVIND ${f.naam} — ${f.wat}, regel ${f.nr}`);
  console.error(`\nROOD: ${fouten.length} aanroepen hebben geen functie`);
  process.exit(1);
}
console.log("\nGROEN: elke aanroep heeft een functie");
