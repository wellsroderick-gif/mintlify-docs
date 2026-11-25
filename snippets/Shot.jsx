/**
 * Shared <Shot id="…" /> component (WR-32543). The `helpShotsManifest` block is generated from
 * `help-shots.manifest.json` by scripts/ci/sync-help-shots-snippet.mjs — do not hand-edit it.
 */
export const helpShotsManifest = [];

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

  const file = String(entry.file ?? "").replace(/^\/+/, "");
  if (!file.startsWith("images/screenshots/")) {
    return (
      <p>
        <strong>Invalid promoted path for</strong> <code>{id}</code>: <code>{file}</code> must live
        under <code>images/screenshots/</code>.
      </p>
    );
  }

  const src = `/${file}`;
  const alt = entry.alt ?? "";

  return (
    <Frame caption={alt}>
      <img src={src} alt={alt} />
    </Frame>
  );
}
