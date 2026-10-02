/**
 * Poort: elke stap van `scripts/uitrol-rek471.sh` moet los kunnen draaien.
 *
 *   node server/scripts/verify-uitrol-zelfstandig.mjs <pad-naar-script>
 *
 * De fout waar dit voor bestaat, opgemeten 2026-10-02 om 19:1xZ. `terugval` is de
 * stap die je gebruikt als er iets mis is, en die stierf op twee manieren zodra hij
 * zonder voorafgaande stap draaide:
 *
 *   $ ./uitrol-rek471.sh terugval
 *   ./uitrol-rek471.sh: line 657: COMPOSE: unbound variable      (exit 1)
 *
 *   $ COMPOSE=<bestaand> ./uitrol-rek471.sh terugval
 *   ./uitrol-rek471.sh: line 679: SERVICE: unbound variable     (exit 1)
 *
 * `SERVICE` was de regel die PR #13 toevoegde: de poort op de terugval-image
 * gebruikt `$SERVICE`, en `terugval` riep `controleer` nooit aan. De poort die de
 * uitrol beschermt blokkeerde dus zelf de terugval. En de ergste helft: de `mv` van
 * de terugvalkopie was al gebeurd, dus de compose stond terug en de container was
 * niet herstart — met `unbound variable` als laatste regel in beeld.
 *
 * `set -u` maakt dit geen cosmetische fout maar een dode uitgang, dus de poort meet
 * gedrag en geen tekst: zij zet een nep-docker en een nep-compose op en draait elke
 * lees- en terugvalstap los.
 *
 * `bouw`, `koppel` en `start` horen er niet bij: die bouwen, schrijven of
 * herstarten de container. `rapport` en `terugval` wel — je moet 's nachts een
 * rapport of een terugval kunnen vragen zonder eerst de hele rit te draaien.
 *
 * De eerste versie van deze poort haalde regels uit het script met een regex om de
 * bronpoorten te overslaan, en die brak het script: elke stap gaf `exit 2` met
 * `syntax error near unexpected token 'fi'`, en de poort zei GROEN. Een poort die
 * groen is op een kapot script is de gevaarlijkste vorm van een poort. Daarom draait
 * deze poort het **ongemodificeerde** script en eist ze per stap een gemeten exitcode.
 *
 * De uitkomst is een momentopname van het script zoals het op schijf staat, niet een
 * garantie voor een script dat iemand morgen's verandert. Daarom staat de uitkomst
 * ook in de PR.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const pad = process.argv[2];
if (!pad) {
  console.error("gebruik: node server/scripts/verify-uitrol-zelfstandig.mjs <pad-naar-script>");
  process.exit(2);
}

const scriptAbs = resolve(pad);
const bron = readFileSync(scriptAbs, "utf8");

// BRON moet de repo zijn, want `broncontrole` leest daaruit. Vandaar: de map twee
// niveaus omhoog vanaf scripts/. Dat is de enige manier om het script te draaien
// zonder hem aan te passen, en aanpassen zou de poort blind maken.
const bronMap = resolve(dirname(scriptAbs), "..");

// Stappen die niets bouwen, schrijven of herstarten, met de exitcode die ze moeten
// geven als ze los kunnen draaien. `controleer` is bewust niet in de lijst: dat is
// een functie, geen schermnaam, en `verify-functieaanroepen.mjs` bewaakt die grens.
const STAPPEN = [
  { naam: "config", wil: 0 },
  { naam: "inspect", wil: 0 },
  { naam: "rapport", wil: 0 },
  { naam: "terugval", wil: 0 },
];

const dir = mkdtempSync(join(tmpdir(), "uitrol-zelfstandig-"));
const bin = join(dir, "bin");
mkdirSync(bin, { recursive: true });

// Een nep-docker met precies de lezingen die deze stappen doen: het servicenaam-
// veld, het etiket, de lokale image, `up -d` en `exec cat build-info.json`.
writeFileSync(
  join(bin, "docker"),
  `#!/usr/bin/env bash
if [ "$1" = "compose" ]; then
  shift; for a in "$@"; do case "$a" in up|ps|config|images|build) sub="$a"; break;; esac; done
  for a in "$@"; do
    case "$a" in --services) echo "paperclip"; exit 0 ;; esac
  done
  case "$sub" in
    up) echo "NEP-UP"; exit 0 ;;
    ps) echo "paperclip  Up  1 minuut" ;;
    *)  exit 0 ;;
  esac
fi
case "$1" in
  image)   exit 0 ;;
  ps)      echo "ctr0000000001" ;;
  exec)    case "$*" in *build-info.json*) echo "{\\"commit\\":\\"$NEP_COMMIT\\"}";; *) echo "3";; esac; exit 0 ;;
  inspect) echo "paperclip-rek471:nep"; exit 0 ;;
  *) exit 0 ;;
esac
`,
  { mode: 0o755 },
);

const compose = [
  "services:",
  "  paperclip:",
  "    image: paperclip-rek471:vorige000000",
  "    build:",
  "      context: .",
  "      dockerfile: Dockerfile",
  "",
].join("\n");
const composePad = join(dir, "docker-compose.yml");
writeFileSync(composePad, compose);
// Een terugvalkopie, want anders stopt `terugval` terecht met "geen terugvalkopie".
writeFileSync(join(dir, "docker-compose.yml.bak-rek471-20260101T000000Z"), compose);

// De sha van de bron, zodat `broncontrole` zijn eigen vergelijking slaagt zonder git.
const head = spawnSync("git", ["-C", bronMap, "rev-parse", "HEAD"], { encoding: "utf8" });
const commit = head.status === 0 ? head.stdout.trim() : "";

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  // `BASH_ENV` van de runner zet PATH terug; zonder dit is de nep-docker onvindbaar.
  // Gemeten 2026-10-02: de eerste versie van deze poort vond docker niet en gaf
  // exit 2 op elke stap, en meldde dat als "ok".
  BASH_ENV: "/dev/null",
  COMPOSE: composePad,
  BRON: bronMap,
  HOME: dir,
  NEP_COMMIT: commit,
  // Zonder deze wacht roept `broncontrole` deze poort aan terwijl de poort juist
  // `config` draait, en dat is een oneindige lus. Gemeten 2026-10-02: exit 124.
  UITROL_GATE_ZELFSTANDIG: "1",
  ...(commit ? { COMMIT: commit } : {}),
};

console.log(`script   : ${scriptAbs}`);
console.log(`bron     : ${bronMap} @ ${commit ? commit.slice(0, 12) : "onbekend"}`);
console.log(`tijdelijk: ${dir}`);
console.log();

const fouten = [];
for (const { naam, wil } of STAPPEN) {
  const r = spawnSync("bash", [scriptAbs, naam], { env, encoding: "utf8", timeout: 120_000 });
  const uit = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const regels = uit.trim().split("\n").filter(Boolean);
  const laatste = regels[regels.length - 1] ?? "";
  const code = r.status;

  // De drie manieren waarop een stap dood kan gaan zonder iets te doen. De eerste
  // twee zijn de fout van 19:1xZ, de derde is uit PR #9 (`alles` riep `inspect` aan).
  const dood = [
    { patroon: "unbound variable", reden: "de stap leest een variabele die `set -u` niet kent" },
    { patroon: "command not found", reden: "de stap roept een naam aan die geen functie is" },
    { patroon: "syntax error", reden: "het script is niet parseerbaar" },
  ].find((p) => uit.includes(p.patroon));

  if (dood) {
    fouten.push({ naam, reden: dood.reden, regel: laatste });
    console.log(`  ROOD   ${naam.padEnd(10)} ${dood.patroon} — ${laatste}`);
    continue;
  }
  if (code !== wil) {
    fouten.push({ naam, reden: `verwachtte exit ${wil}, kreeg ${code}`, regel: laatste });
    console.log(`  ROOD   ${naam.padEnd(10)} exit ${code}, verwacht ${wil} — ${laatste}`);
    continue;
  }
  console.log(`  ok     ${naam.padEnd(10)} exit ${code}`);
}

rmSync(dir, { recursive: true, force: true });

if (fouten.length > 0) {
  console.error();
  for (const f of fouten) console.error(`  ${f.naam}: ${f.reden}\n    ${f.regel}`);
  console.error(
    `\nROOD: ${fouten.length} stap(pen) kunnen niet los draaien. Een terugval die niet begint, is een dode uitgang.`,
  );
  process.exit(1);
}
console.log(
  "\nGROEN: elke lees- en terugvalstap draait los, met de gemeten exitcode die ze verdient",
);