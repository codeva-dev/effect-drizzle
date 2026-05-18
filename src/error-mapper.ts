import {
  CheckConstraintError,
  DatabaseConnectionError,
  DatabaseTimeoutError,
  DatabaseTransactionError,
  type DatabaseError,
  type SqlDialect,
  ForeignKeyConstraintError,
  NotNullConstraintError,
  UniqueConstraintError,
  UnknownSqlError,
} from './errors';

export type DatabaseOperation = 'query' | 'transaction';

type ErrorMetadata = {
  readonly cause: unknown;
  readonly message?: string;
  readonly code?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly dialect?: SqlDialect;
};

type ErrorRecord = Record<string, unknown>;

const postgresConnectionCodes = new Set(['08000', '08001', '08003', '08004', '08006', '08007', '08P01', '53300']);
const postgresTimeoutCodes = new Set(['57014', '55P03']);
const mysqlConnectionCodes = new Set(['1040', '1042', '1043', '1045', '2002', '2003', '2006', '2013']);
const mysqlTimeoutCodes = new Set(['1205', '1213']);
const sqliteConnectionCodes = new Set(['SQLITE_CANTOPEN', 'SQLITE_IOERR', '14', '10']);
const sqliteTimeoutCodes = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', '5', '6']);

export function mapDatabaseError(cause: unknown, operation: DatabaseOperation = 'query'): DatabaseError | undefined {
  const metadata = extractErrorMetadata(cause);
  if (!metadata) return undefined;

  if (operation === 'transaction' && isTransactionOnlyError(metadata)) {
    return new DatabaseTransactionError(metadata);
  }

  if (isUniqueConstraint(metadata)) return new UniqueConstraintError(metadata);
  if (isForeignKeyConstraint(metadata)) return new ForeignKeyConstraintError(metadata);
  if (isNotNullConstraint(metadata)) return new NotNullConstraintError(metadata);
  if (isCheckConstraint(metadata)) return new CheckConstraintError(metadata);
  if (isConnectionError(metadata)) return new DatabaseConnectionError(metadata);
  if (isTimeoutError(metadata)) return new DatabaseTimeoutError(metadata);

  return new UnknownSqlError(metadata);
}

export function isSqlError(cause: unknown): boolean {
  return extractErrorMetadata(cause) !== undefined;
}

function extractErrorMetadata(cause: unknown): ErrorMetadata | undefined {
  const visited = new Set<unknown>();
  const record = findSqlErrorRecord(cause, visited);
  if (!record) return undefined;

  const code = firstString(record.code, record.errno, record.sqlState, record.sqlstate);
  const dialect = detectDialect(record, code);

  return compactMetadata({
    cause,
    message: findMessage(cause, record),
    code,
    constraint: firstString(record.constraint, record.constraint_name),
    table: firstString(record.table, record.table_name),
    column: firstString(record.column, record.column_name),
    dialect,
  });
}

function findSqlErrorRecord(value: unknown, visited: Set<unknown>): ErrorRecord | undefined {
  if (!isRecord(value) || visited.has(value)) return undefined;
  visited.add(value);

  if (hasSqlMarker(value)) return value;

  const cause = value.cause;
  if (cause !== undefined) {
    const nested = findSqlErrorRecord(cause, visited);
    if (nested) return nested;
  }

  return undefined;
}

function hasSqlMarker(record: ErrorRecord): boolean {
  const code = firstString(record.code, record.errno, record.sqlState, record.sqlstate);
  if (!code) return false;

  return (
    record.constraint !== undefined ||
    record.table !== undefined ||
    record.column !== undefined ||
    record.routine !== undefined ||
    record.sql !== undefined ||
    record.sqlMessage !== undefined ||
    record.sqlState !== undefined ||
    record.sqlstate !== undefined ||
    code.startsWith('SQLITE_') ||
    /^[0-9A-Z]{5}$/.test(code) ||
    /^\d+$/.test(code)
  );
}

function detectDialect(record: ErrorRecord, code?: string): SqlDialect {
  if (typeof code === 'string' && code.startsWith('SQLITE_')) return 'sqlite';
  if (record.sqlMessage !== undefined || record.sqlState !== undefined || record.errno !== undefined) return 'mysql';
  if (record.routine !== undefined || record.schema !== undefined || record.constraint !== undefined) return 'postgres';
  if (typeof code === 'string' && /^\d+$/.test(code)) return 'mysql';
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return 'postgres';
  return 'unknown';
}

function isUniqueConstraint(metadata: ErrorMetadata): boolean {
  return (
    metadata.code === '23505' ||
    metadata.code === '1062' ||
    metadata.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    metadata.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    metadata.code === '2067' ||
    metadata.code === '1555'
  );
}

function isForeignKeyConstraint(metadata: ErrorMetadata): boolean {
  return (
    metadata.code === '23503' ||
    metadata.code === '1451' ||
    metadata.code === '1452' ||
    metadata.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    metadata.code === '787'
  );
}

function isNotNullConstraint(metadata: ErrorMetadata): boolean {
  return (
    metadata.code === '23502' ||
    metadata.code === '1048' ||
    metadata.code === 'SQLITE_CONSTRAINT_NOTNULL' ||
    metadata.code === '1299'
  );
}

function isCheckConstraint(metadata: ErrorMetadata): boolean {
  return (
    metadata.code === '23514' ||
    metadata.code === '3819' ||
    metadata.code === 'SQLITE_CONSTRAINT_CHECK' ||
    metadata.code === '275'
  );
}

function isConnectionError(metadata: ErrorMetadata): boolean {
  if (!metadata.code) return false;
  return (
    postgresConnectionCodes.has(metadata.code) ||
    mysqlConnectionCodes.has(metadata.code) ||
    sqliteConnectionCodes.has(metadata.code)
  );
}

function isTimeoutError(metadata: ErrorMetadata): boolean {
  if (!metadata.code) return false;
  return postgresTimeoutCodes.has(metadata.code) || mysqlTimeoutCodes.has(metadata.code) || sqliteTimeoutCodes.has(metadata.code);
}

function isTransactionOnlyError(metadata: ErrorMetadata): boolean {
  return metadata.code === '25000' || metadata.code === '25001' || metadata.code === '25006' || metadata.code === '25P02';
}

function compactMetadata(metadata: ErrorMetadata): ErrorMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) as ErrorMetadata;
}

function findMessage(cause: unknown, record: ErrorRecord): string | undefined {
  if (typeof record.message === 'string') return record.message;
  if (isRecord(cause) && typeof cause.message === 'string') return cause.message;
  return undefined;
}

function firstString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is ErrorRecord {
  return typeof value === 'object' && value !== null;
}
