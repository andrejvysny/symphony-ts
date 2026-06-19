// Dependency-free bin launcher. It enforces the Node version BEFORE the bundled app's heavy static
// imports evaluate (the SDK/fastify/undici stack can fail to even load on older Node), then hands
// off to the real entry. The dynamic import uses a runtime-computed URL so tsup leaves it external
// and it resolves to the sibling dist/main.js at run time (same trick as stdio-tracker-server.js).
const major = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(major) && major < 22) {
  process.stderr.write(
    `symphony requires Node >= 22 (you are on ${process.versions.node}). ` +
      `Please upgrade Node and re-run.\n`,
  );
  process.exit(1);
}

await import(new URL('./main.js', import.meta.url).href);
