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
] as const;

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
  const tijd = metingen.map((m) => m.ms).sort((a, b) => a - b);
  return {
    mediaan: tijd[Math.floor(tijd.length / 2)],
    min: tijd[0],
    max: tijd[tijd.length - 1],
    http: metingen[0].http,
    bytes: metingen[0].bytes,
    vloerHttp: [...new Set(metingen.map((m) => m.http))],
  };
}

const rijen: Record<string, unknown>[] = [];
for (const cel of CELLEN) {
  const url = `${apiUrl}/api/issues/${cel.uuid}/runs`;
  const lijst = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  const m = await meet(url);
  rijen.push({ ref: cel.ref, uuid: cel.uuid, runs: Array.isArray(lijst) ? lijst.length : null, nulRuns: cel.nulRuns, ...m });
  console.log(`${cel.ref.padEnd(8)} runs=${String(lijst.length).padStart(4)}  mediaan ${String(m.mediaan).padStart(6)} ms  (min ${m.min}, max ${m.max})  HTTP ${m.http}  ${m.bytes} bytes`);
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
  writeFileSync(uitPad, JSON.stringify({ gemetenOp: new Date().toISOString(), samples, rijen, vloer }, null, 2));
  console.log(`\nweggeschreven: ${uitPad}`);
}