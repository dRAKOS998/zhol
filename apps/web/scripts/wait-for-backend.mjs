// Runs before a production build on Vercel: waits until the VPS has deployed this commit, so a new
// frontend never goes live ahead of the backend it needs. If the backend does not catch up the build
// fails and the current frontend stays live. Everywhere else (local, previews) it does nothing.
// Set SKIP_BACKEND_WAIT=1 to redeploy an older commit or to deploy while the VPS is unavailable.
const { VERCEL_ENV, VERCEL_GIT_COMMIT_SHA: commit, VITE_SERVER_URL: backend, SKIP_BACKEND_WAIT } = process.env;
const TIMEOUT_MS = Number(process.env.BACKEND_WAIT_TIMEOUT_MS ?? 5 * 60_000);
const POLL_MS = Number(process.env.BACKEND_WAIT_POLL_MS ?? 10_000);

if (VERCEL_ENV !== 'production' || !commit || !backend || SKIP_BACKEND_WAIT === '1') process.exit(0);

const url = `${backend.replace(/\/$/, '')}/deployed-commit`;
const deadline = Date.now() + TIMEOUT_MS;
let seen = 'nothing yet';
console.log(`Waiting for the backend to deploy ${commit} (${url})`);

while (Date.now() < deadline) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(POLL_MS) });
    seen = res.ok ? (await res.text()).trim() : `HTTP ${res.status}`;
    if (seen === commit) {
      console.log('Backend is ready.');
      process.exit(0);
    }
  } catch (err) {
    seen = err instanceof Error ? err.message : String(err);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

console.error(`Backend did not deploy ${commit} in time (last saw: ${seen}).`);
console.error('On the VPS: journalctl -u zhol-autodeploy -n 50');
process.exit(1);
