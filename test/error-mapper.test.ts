import { describe, expect, it } from 'vitest';
import {
  CheckConstraintError,
  DatabaseConnectionError,
  DatabaseTimeoutError,
  ForeignKeyConstraintError,
  isSqlError,
  mapDatabaseError,
  NotNullConstraintError,
  UniqueConstraintError,
  UnknownSqlError,
} from '../src';

describe('mapDatabaseError', () => {
  it('normalizes Postgres and Neon constraint errors', () => {
    expect(mapDatabaseError({ code: '23505', constraint: 'users_email_key' })).toBeInstanceOf(UniqueConstraintError);
    expect(mapDatabaseError({ code: '23503', constraint: 'orders_user_id_fk' })).toBeInstanceOf(
      ForeignKeyConstraintError,
    );
    expect(mapDatabaseError({ code: '23502', column: 'email' })).toBeInstanceOf(NotNullConstraintError);
    expect(mapDatabaseError({ code: '23514', constraint: 'positive_price' })).toBeInstanceOf(CheckConstraintError);
  });

  it('normalizes MySQL errors', () => {
    expect(mapDatabaseError({ errno: 1062, sqlMessage: 'Duplicate entry' })).toBeInstanceOf(UniqueConstraintError);
    expect(mapDatabaseError({ errno: 1452, sqlMessage: 'Cannot add or update child row' })).toBeInstanceOf(
      ForeignKeyConstraintError,
    );
    expect(mapDatabaseError({ errno: 1048, sqlMessage: 'Column cannot be null' })).toBeInstanceOf(
      NotNullConstraintError,
    );
    expect(mapDatabaseError({ errno: 3819, sqlMessage: 'Check constraint violated' })).toBeInstanceOf(
      CheckConstraintError,
    );
  });

  it('normalizes SQLite errors', () => {
    expect(mapDatabaseError({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBeInstanceOf(UniqueConstraintError);
    expect(mapDatabaseError({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })).toBeInstanceOf(ForeignKeyConstraintError);
    expect(mapDatabaseError({ code: 'SQLITE_CONSTRAINT_NOTNULL' })).toBeInstanceOf(NotNullConstraintError);
    expect(mapDatabaseError({ code: 'SQLITE_CONSTRAINT_CHECK' })).toBeInstanceOf(CheckConstraintError);
  });

  it('normalizes connection and timeout errors', () => {
    expect(mapDatabaseError({ code: '08006' })).toBeInstanceOf(DatabaseConnectionError);
    expect(mapDatabaseError({ errno: 2002, sqlMessage: 'Connection refused' })).toBeInstanceOf(DatabaseConnectionError);
    expect(mapDatabaseError({ code: 'SQLITE_BUSY' })).toBeInstanceOf(DatabaseTimeoutError);
  });

  it('returns UnknownSqlError for recognized but uncategorized SQL errors', () => {
    expect(mapDatabaseError({ code: '99999', sql: 'select 1', message: 'SQL-shaped error' })).toBeInstanceOf(
      UnknownSqlError,
    );
  });

  it('does not map non-SQL errors to typed database errors', () => {
    const cause = new Error('application error');

    expect(isSqlError(cause)).toBe(false);
    expect(mapDatabaseError(cause)).toBeUndefined();
  });

  it('does not map arbitrary code-shaped application errors to typed database errors', () => {
    const cause = { code: 'ABCDE', message: 'not a SQL error' };

    expect(isSqlError(cause)).toBe(false);
    expect(mapDatabaseError(cause)).toBeUndefined();
  });
});
