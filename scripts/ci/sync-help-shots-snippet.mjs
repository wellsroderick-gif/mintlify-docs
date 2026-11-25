/**
 * Embeds `help-shots.manifest.json` into `snippets/Shot.jsx` (Mintlify disallows nested
 * snippet imports and JSON imports in snippets).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(repoRoot, "help-shots.manifest.json");
const outPath = path.join(repoRoot, "snippets/Shot.jsx");

const raw = fs.readFileSync(manifestPath, "utf8");
const parsed = JSON.parse(raw);
if (!Array.isArray(parsed)) {
  console.error("sync-help-shots-snippet: manifest must be a JSON array");
  process.exit(1);
}

const body = `/**
 * Shared <Shot id="…" /> component (WR-32543). The \`helpShotsManifest\` block is generated from
 * \`help-shots.manifest.json\` by scripts/ci/sync-help-shots-snippet.mjs — do not hand-edit it.
 */
export const helpShotsManifest = ${JSON.stringify(parsed, null, 2)};

/**
 * @param {{ id: string }} props
 */
export function Shot({ id }) {
  const entry = helpShotsManifest.find((row) => row.id === id);
  if (!entry) {
    return (
      <p>
        <strong>Missing screenshot manifest entry:</strong> <code>{id}</code>
      </p>
    );
  }

  const file = String(entry.file ?? "").replace(/^\\/+/, "");
  if (!file.startsWith("images/screenshots/")) {
    return (
      <p>
        <strong>Invalid promoted path for</strong> <code>{id}</code>: <code>{file}</code> must live
        under <code>images/screenshots/</code>.
      </p>
    );
  }

  const src = \`/\${file}\`;
  const alt = entry.alt ?? "";

  return (
    <Frame caption={alt}>
      <img src={src} alt={alt} />
    </Frame>
  );
}
`;

fs.writeFileSync(outPath, body);
console.log(`sync-help-shots-snippet: embedded ${parsed.length} manifest entries in ${outPath}`);