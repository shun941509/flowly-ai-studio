import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Authors own JSON batches. This compiler validates and indexes them; it never
// generates business problems by replacing names, numbers, or framework labels.
const directory = new URL("../domain/catalog/", import.meta.url);
await mkdir(directory, { recursive: true });
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const contractHash = seed => createHash("sha256").update(canonical(seed)).digest("hex");
export function validateSeed(seed, source) {
  const keys = ["id", "title", "category", "pattern", "problem", "input", "facts", "output", "rules", "failures"];
  if (!seed || typeof seed !== "object" || Array.isArray(seed) || Object.keys(seed).some(key => ![...keys,"outputSchema"].includes(key))) throw new Error(`Unknown catalog fields: ${source}`);
  for (const key of keys.slice(0, 8)) if (typeof seed[key] !== "string" || !seed[key].trim() || seed[key].length > 10000) throw new Error(`Invalid ${key}: ${source}`);
  if (!/^[-a-z0-9]{3,90}$/.test(seed.id) || !["agent", "rag", "team", "parallel", "review"].includes(seed.pattern)) throw new Error(`Invalid identity/pattern: ${source}`);
  for (const [key, count] of [["rules", 3], ["failures", 2]]) if (!Array.isArray(seed[key]) || seed[key].length < count || seed[key].some(value => typeof value !== "string" || !value.trim() || value.length > 2000) || new Set(seed[key]).size !== seed[key].length) throw new Error(`Invalid ${key}: ${source}/${seed.id}`);
  if (typeof seed.output !== "string" || !seed.output.trim()) throw new Error(`Missing output: ${source}`);
}
export const authoredSeeds = [];
const ids = new Set();
for (const area of (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const folder = new URL(`${area.name}/`, directory);
  for (const file of (await readdir(folder)).filter(file => file.endsWith(".json")).sort()) {
    const source = `${area.name}/${file}`;
    const rows = JSON.parse((await readFile(new URL(file, folder), "utf8")).replace(/^\uFEFF/, ""));
    if (!Array.isArray(rows)) throw new Error(`Expected an authored array: ${source}`);
    for (const seed of rows) {
      validateSeed(seed, source);
      if (ids.has(seed.id)) throw new Error(`Duplicate catalog ID: ${seed.id}`);
      ids.add(seed.id); authoredSeeds.push(seed);
    }
  }
}
// Contextually type bounded arrays instead of asking TypeScript to infer one
// multi-thousand-member union. Every authored object still receives type checking.
const batches=[];
for(let start=0;start<authoredSeeds.length;start+=100)batches.push(authoredSeeds.slice(start,start+100));
const generated = `// Generated from authored JSON batches by build-example-catalog.mjs.\nimport type { ExampleSeed } from '../example-seeds';\n${batches.map((batch,index)=>`const batch${index}:ExampleSeed[]=${JSON.stringify(batch)};`).join("\n")}\nexport const extendedExampleSeeds:ExampleSeed[]=[${batches.map((_,index)=>`...batch${index}`).join(",")}];\n`;
const target = new URL("index.ts", directory);
let previous = ""; try { previous = await readFile(target, "utf8"); } catch {}
if (previous !== generated) await writeFile(target, generated);
export const allSeeds = [...JSON.parse(await readFile(new URL("../domain/example-core.json", import.meta.url), "utf8")), ...authoredSeeds];
const allIds = new Set();
for (const seed of allSeeds) { validateSeed(seed, seed.id); if(allIds.has(seed.id))throw new Error(`Duplicate core/extended ID: ${seed.id}`); allIds.add(seed.id); }
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`Indexed ${authoredSeeds.length} authored contracts; no generated scenarios.`);
