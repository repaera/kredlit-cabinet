import { describe, expect, it } from 'vitest';
import { requireTestDatabaseUrl } from '../support/database.ts';

const testUrl = 'postgresql://test:test@example.test:5432/postal_test';

describe('destructive test database guard', () => {
  it('requires a dedicated test URL', () => {
    expect(() => requireTestDatabaseUrl({ CABINET_ALLOW_DB_RESET: '1' })).toThrow('TEST_DATABASE_URL is required');
  });

  it('requires explicit reset acknowledgement', () => {
    expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: testUrl })).toThrow('CABINET_ALLOW_DB_RESET=1 is required');
  });

  it('rejects the production database target even with different credentials', () => {
    expect(() => requireTestDatabaseUrl({
      DATABASE_URL: 'postgresql://prod:secret@example.test:5432/postal_test?sslmode=require',
      TEST_DATABASE_URL: testUrl,
      CABINET_ALLOW_DB_RESET: '1',
    })).toThrow('must not target the same database');
  });

  it('accepts an explicitly acknowledged disposable target', () => {
    expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: testUrl, CABINET_ALLOW_DB_RESET: '1' })).toBe(testUrl);
  });
});
