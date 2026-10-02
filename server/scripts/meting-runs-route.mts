/**
 * Hermeting van `GET /api/issues/{id}/runs` met de methode van de nulmeting.
 *
 *   PAPERCLIP_API_URL=… PAPERCLIP_API_KEY=… tsx server/scripts/meting-runs-route.mts
 *
 * Formule: `curl -s -o /dev/null -w '%{time_total} %{http_code} %{size_download}'`,
 * mediaan van `--samples` (standaard 7) per issue, plus `/agents/me` als vloer. De
 * HTTP-status staat per cel, dus een 404 of 500 leest niet als een snelle route.
 *
 * Schrijft `--uit` als JSON en print de tabel. Geef `--vergelijk vorige.json` mee
 * om de vóór- en nástand naast elkaar te zetten; zonder die vergelijking is een
 * getal op zichzelf geen uitspraak.
 */
import { readFileSync, writeFileSync } from "node:fs";

const arg = (naam: string, fallback: string) => {
  const i = process.argv.indexOf(`--${naam}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const apiUrl = (process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/api\/?$/, "");
const token = process.env.PAPERCLIP_API_KEY ?? "";
const samples = Number(arg("samples", "7"));
const uitPad = arg("uit", "");
const vergelijkPad = arg("vergelijk", "");

// De vier issues van de nulmeting in [REK-471], met hun uuid en het aantal runs
// dat de nulmeting telde. De uuid staat erbij omdat de identifier in de URL mag
// wisselen en de uuid niet.
const CELLEN = [
  { ref: "REK-234", uuid: "30eb269e-83a9-4459-a7b3-aa97b7835964", nulRuns: 173 },
  { ref: "REK-311", uuid: "6a532b58-c775-434c-80ac-ed226813fab3", nulRuns: 20 },
  { ref: "REK-470", uuid: "71a55a37-35a6-4f56-b9e8-b7f1b9e72e19", nulRuns: 4 },
  { ref: "REK-469", uuid: "d607a942-15a0-4fc7-a79e-436ccaf09853", nulRuns: 3 },
];

// `--cel REF=uuid` overschrijft één uuid. Dat is er voor de negatieve toets: een
// cel met een uuid die niet bestaat geeft HTTP 404 en ~30 ms, en zonder de
// overschrijving zou die poort nooit te zien krijgen.
const celOverride = arg("cel", "");
if (celOverride) {
  const [ref, uuid] = celOverride.split("=");
  const cel = CELLEN.find((c) => c.ref === ref);
  if (!cel) {
    console.error(`onbekende cel: ${ref}. Bekend: ${CELLEN.map((c) => c.ref).join(", ")}`);
    process.exit(2);
  }
  if (!uuid) {
    console.error(`--cel ${ref}= verwacht een uuid`);
    process.exit(2);
  }
  cel.uuid = uuid;
}

/**
 * Meet `samples` keer en geef de mediaan terug, maar alleen over de samples die
 * HTTP 200 waren.
 *
 * Die filter is geen cosmetiek. Gemeten 2026-10-02: een cel die 404 geeft
 * antwoordt binnen ~30 ms met 27 bytes, en die 30 ms is een *gemiddelde* dat
 * door de mediaan zou lopen als het er allemaal 200 waren. Dan leest een
 * doodgeslagen route als de snelste van de tabel, en dat is precies de vorm
 * van de claim die dit issue verbiedt. Zie `verify-200-vlag.mjs` voor de
 * negatieve toets.
 */
async function meet(url: string) {
  const metingen: { ms: number; http: string; bytes: number }[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.arrayBuffer();
    metingen.push({
      ms: Math.round(performance.now() - t0),
      http: String(res.status),
      bytes: body.byteLength,
    });
  }
  const goed = metingen.filter((m) => m.http === "200");
  const tijd = goed.map((m) => m.ms).sort((a, b) => a - b);
  return {
    mediaan: tijd.length ? tijd[Math.floor(tijd.length / 2)] : null,
    min: tijd.length ? tijd[0] : null,
    max: tijd.length ? tijd[tijd.length - 1] : null,
    http: goed.length ? "200" : [...new Set(metingen.map((m) => m.http))].join(","),
    bytes: goed.length ? goed[0].bytes : null,
    goedeSamples: goed.length,
    alleSamples: metingen.length,
    fouten: metingen.filter((m) => m.http !== "200").map((m) => `${m.http}/${m.bytes}B`),
  };
}

const poort: string[] = [];
const rijen: Record<string, unknown>[] = [];
for (const cel of CELLEN) {
  const url = `${apiUrl}/api/issues/${cel.uuid}/runs`;
  const eerst = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await eerst.text();
  const lijst = eerst.status === 200 ? JSON.parse(body) : null;
  const m = await meet(url);
  const runs = Array.isArray(lijst) ? lijst.length : null;
  // De run-teller hoort bij de meting van dezelfde cel. Zonder deze poort kan
  // een lijst stiller worden terwijl de route even snel blijft, en dan
  // vergelijk je twee verschillende dingen.
  const tellerKlopt = runs !== null && runs > 0;
  if (!tellerKlopt) poort.push(`${cel.ref}: geen bruikbare run-lijst (HTTP ${eerst.status}, ${body.length}B)`);
  else if (m.mediaan === null) poort.push(`${cel.ref}: geen van de ${samples} samples was HTTP 200 (${m.fouten.join(", ")})`);
  rijen.push({ ref: cel.ref, uuid: cel.uuid, runs, nulRuns: cel.nulRuns, ...m });
  console.log(`${cel.ref.padEnd(8)} runs=${String(runs ?? "?").padStart(4)}  mediaan ${String(m.mediaan ?? "?").padStart(6)} ms  (min ${m.min}, max ${m.max})  HTTP ${m.http}  ${m.bytes} bytes`);
}

const vloer = await meet(`${apiUrl}/api/agents/me`);
console.log(`${"(vloer)"}  ${"".padStart(19)}  mediaan ${String(vloer.mediaan).padStart(6)} ms  (min ${vloer.min}, max ${vloer.max})  HTTP ${vloer.http}  ${vloer.bytes} bytes`);

if (vergelijkPad) {
  try {
    const vorige = JSON.parse(readFileSync(vergelijkPad, "utf8")) as { rijen?: Record<string, unknown>[] };
    console.log();
    console.log("issue    vóór      na      verschil");
    for (const rij of rijen) {
      const v = vorige.rijen?.find((x) => x.ref === rij.ref) as { mediaan?: number } | undefined;
      if (!v?.mediaan) continue;
      const d = Math.round(((rij.mediaan as number) - v.mediaan) / v.mediaan * 100);
      console.log(`${String(rij.ref).padEnd(8)} ${String(v.mediaan).padStart(6)} ms ${String(rij.mediaan).padStart(6)} ms  ${d > 0 ? "+" : ""}${d}%`);
    }
  } catch (e) {
    console.log(`vergelijking overgeslagen: ${(e as Error).message}`);
  }
}

if (uitPad) {
  writeFileSync(uitPad, JSON.stringify({ gemetenOp: new Date().toISOString(), samples, rijen, vloer, poort }, null, 2));
  console.log(`\nweggeschreven: ${uitPad}`);
}

// De uitkomst van deze meting is pas bruikbaar als elke cel echt is gemeten.
// Een 404 levert ~30 ms en 27 bytes op, en die zou als "de route is nu snel"
// lezen. Daarom stopt het script hier in plaats van een tabel te schrijven.
if (poort.length > 0) {
  console.error("");
  for (const regel of poort) console.error(`  ${regel}`);
  console.error(`\nROOD: ${poort.length} cellen zijn niet bruikbaar. Er is geen vergelijkingstabel.`);
  process.exit(1);
}
console.log("\nGROEN: elke cel heeft een bruikbare run-lijst en minstens één HTTP 200.");