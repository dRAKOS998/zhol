import path from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  allowedOrigins: string[];
  publicWebUrl: string | null;
  databasePath: string;
  trustProxy: boolean;
  zholPenalty: number;
  testHarness: boolean;
  logRequests: boolean;
  /** Seconds a connected player may take per move before the computer plays it. 0 = no limit. */
  turnSeconds: number;
  /** Seconds a disconnected player is waited for before the computer plays for them. 0 = wait forever. */
  awaySeconds: number;
  /** Optional: built web app to serve from this process (single-service deploys). */
  webDistDir: string | null;
}

function parseBool(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true';
}

function parseOrigins(raw: string | undefined): string[] {
  const list = (raw ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  for (const o of list) {
    if (!/^https?:\/\/[^/\s]+$/.test(o)) throw new Error(`ALLOWED_ORIGINS entry is not an origin: ${o}`);
  }
  return list;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a valid port number');
  const zholPenalty = Number(env.ZHOL_UNLINKED_PENALTY ?? 20);
  if (!Number.isInteger(zholPenalty) || zholPenalty < 0 || zholPenalty > 100) {
    throw new Error('ZHOL_UNLINKED_PENALTY must be an integer between 0 and 100');
  }
  const seconds = (name: string, fallback: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 0 || n > 3600) throw new Error(`${name} must be an integer between 0 and 3600`);
    return n;
  };
  const testHarness = parseBool(env.ZHOL_TEST_HARNESS);
  if (testHarness && env.NODE_ENV === 'production') {
    throw new Error('ZHOL_TEST_HARNESS must never be enabled when NODE_ENV=production');
  }
  if (testHarness && env.NODE_ENV !== 'test') {
    throw new Error('ZHOL_TEST_HARNESS requires NODE_ENV=test');
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    publicWebUrl: env.PUBLIC_WEB_URL ? env.PUBLIC_WEB_URL.replace(/\/$/, '') : null,
    databasePath: path.resolve(env.DATABASE_PATH ?? './data/zhol.db'),
    trustProxy: parseBool(env.TRUST_PROXY),
    zholPenalty,
    testHarness,
    logRequests: env.LOG_LEVEL !== 'silent',
    turnSeconds: seconds('ZHOL_TURN_SECONDS', 90),
    awaySeconds: seconds('ZHOL_AWAY_SECONDS', 30),
    webDistDir: env.WEB_DIST_DIR ? path.resolve(env.WEB_DIST_DIR) : null,
  };
}
