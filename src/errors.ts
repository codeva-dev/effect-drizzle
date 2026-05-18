import { Schema } from 'effect';

export const SqlDialect = Schema.Literal('postgres', 'mysql', 'sqlite', 'unknown');
export type SqlDialect = Schema.Schema.Type<typeof SqlDialect>;

const DatabaseErrorFields = {
  cause: Schema.Unknown,
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  constraint: Schema.optional(Schema.String),
  table: Schema.optional(Schema.String),
  column: Schema.optional(Schema.String),
  dialect: Schema.optional(SqlDialect),
};

export class UniqueConstraintError extends Schema.TaggedError<UniqueConstraintError>()(
  'UniqueConstraintError',
  DatabaseErrorFields,
) {}

export class ForeignKeyConstraintError extends Schema.TaggedError<ForeignKeyConstraintError>()(
  'ForeignKeyConstraintError',
  DatabaseErrorFields,
) {}

export class NotNullConstraintError extends Schema.TaggedError<NotNullConstraintError>()(
  'NotNullConstraintError',
  DatabaseErrorFields,
) {}

export class CheckConstraintError extends Schema.TaggedError<CheckConstraintError>()(
  'CheckConstraintError',
  DatabaseErrorFields,
) {}

export class DatabaseConnectionError extends Schema.TaggedError<DatabaseConnectionError>()(
  'DatabaseConnectionError',
  DatabaseErrorFields,
) {}

export class DatabaseTimeoutError extends Schema.TaggedError<DatabaseTimeoutError>()(
  'DatabaseTimeoutError',
  DatabaseErrorFields,
) {}

export class DatabaseTransactionError extends Schema.TaggedError<DatabaseTransactionError>()(
  'DatabaseTransactionError',
  DatabaseErrorFields,
) {}

export class UnknownSqlError extends Schema.TaggedError<UnknownSqlError>()('UnknownSqlError', DatabaseErrorFields) {}

export const DatabaseError = Schema.Union(
  UniqueConstraintError,
  ForeignKeyConstraintError,
  NotNullConstraintError,
  CheckConstraintError,
  DatabaseConnectionError,
  DatabaseTimeoutError,
  DatabaseTransactionError,
  UnknownSqlError,
);

export type DatabaseError = Schema.Schema.Type<typeof DatabaseError>;
