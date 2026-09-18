import { createDb } from '../../src/db/client.ts';

function loadLocalEnv(): void {
  try {
    process.loadEnvFile('.dev.vars');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

function databaseTarget(value: string): string {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('TEST_DATABASE_URL must be a PostgreSQL URL');
  return `${url.protocol}//${url.hostname}:${url.port || '5432'}${url.pathname}`;
}

export function requireTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is required for database-backed tests; never use DATABASE_URL');
  if (env.CABINET_ALLOW_DB_RESET !== '1') throw new Error('CABINET_ALLOW_DB_RESET=1 is required because tests truncate all Cabinet tables');
  if (env.DATABASE_URL && databaseTarget(testUrl) === databaseTarget(env.DATABASE_URL)) throw new Error('TEST_DATABASE_URL must not target the same database as DATABASE_URL');
  databaseTarget(testUrl);
  return testUrl;
}

export function createTestDb() {
  loadLocalEnv();
  return createDb(requireTestDatabaseUrl());
}
