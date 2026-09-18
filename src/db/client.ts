import postgres, { type Sql } from 'postgres';

export type Db = Sql<Record<string, never>>;

export function createDb(connectionString: string): Db {
  if (!connectionString) throw new Error('DATABASE_URL or Hyperdrive connection string is required');
  return postgres(connectionString, { prepare: false }) as Db;
}
