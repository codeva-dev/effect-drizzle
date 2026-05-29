import { Effect, Exit } from 'effect';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { makeDatabaseRuntime, type TransactionRunner, UnknownSqlError } from '../src';

type MockContext = TransactionRunner<MockContext> & {
  readonly kind: string;
  readonly query: {
    readonly users: {
      findFirst: (id: number) => PromiseLike<{ id: number; context: string }>;
    };
  };
};

const makeContext = (kind: string, transactions: Array<string>): MockContext => ({
  kind,
  query: {
    users: {
      findFirst: async (id) => ({ id, context: kind }),
    },
  },
  async transaction(callback) {
    transactions.push(kind);
    return callback(makeContext(`${kind}:tx`, transactions));
  },
});

const Runtime = makeDatabaseRuntime<MockContext, MockContext>();

describe('Database runtime', () => {
  it('uses the currently provided database context for queries', async () => {
    const transactions: Array<string> = [];
    const client = makeContext('root', transactions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Runtime.Database;
        return yield* db.run((context) => context.query.users.findFirst(1));
      }).pipe(Effect.provide(Runtime.layer(client))),
    );

    expect(result).toEqual({ id: 1, context: 'root' });
    expect(transactions).toEqual([]);
  });

  it('provides the transaction context to queries inside a transaction', async () => {
    const transactions: Array<string> = [];
    const client = makeContext('root', transactions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Runtime.Database;
        return yield* db.transaction(
          Effect.gen(function* () {
            return yield* db.run((context) => context.query.users.findFirst(2));
          }),
        );
      }).pipe(Effect.provide(Runtime.layer(client))),
    );

    expect(result).toEqual({ id: 2, context: 'root:tx' });
    expect(transactions).toEqual(['root']);
  });

  it('opens a new transaction for nested transaction boundaries', async () => {
    const transactions: Array<string> = [];
    const client = makeContext('root', transactions);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Runtime.Database;
        return yield* db.transaction(
          Effect.gen(function* () {
            return yield* db.transaction(
              Effect.gen(function* () {
                return yield* db.run((context) => context.query.users.findFirst(3));
              }),
            );
          }),
        );
      }).pipe(Effect.provide(Runtime.layer(client))),
    );

    expect(result).toEqual({ id: 3, context: 'root:tx:tx' });
    expect(transactions).toEqual(['root', 'root:tx']);
  });

  it('preserves domain failures across transaction rollback', async () => {
    const transactions: Array<string> = [];
    const client = makeContext('root', transactions);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* Runtime.Database;
        return yield* db.transaction(Effect.fail('domain failure'));
      }).pipe(Effect.provide(Runtime.layer(client))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain('domain failure');
    }
  });

  it('maps SQL query failures to typed database errors', async () => {
    const client: MockContext = {
      ...makeContext('root', []),
      query: {
        users: {
          findFirst: async () => {
            throw { code: '99999', sql: 'select 1', message: 'known SQL-shaped error' };
          },
        },
      },
    };

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* Runtime.Database;
        return yield* db.run((context) => context.query.users.findFirst(1));
      }).pipe(Effect.provide(Runtime.layer(client))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain(UnknownSqlError.name);
    }
  });

  it('accepts promise-like query results', async () => {
    const client: MockContext = {
      ...makeContext('root', []),
      query: {
        users: {
          findFirst: (id) => Promise.resolve({ id, context: 'thenable' }) satisfies PromiseLike<{
            id: number;
            context: string;
          }>,
        },
      },
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Runtime.Database;
        return yield* db.run((context) => context.query.users.findFirst(5));
      }).pipe(Effect.provide(Runtime.layer(client))),
    );

    expect(result).toEqual({ id: 5, context: 'thenable' });
  });

  it('keeps the exact client type in query callbacks', () => {
    Effect.gen(function* () {
      const db = yield* Runtime.Database;
      yield* db.run((context) => {
        expectTypeOf(context.query.users.findFirst).parameter(0).toEqualTypeOf<number>();
        expectTypeOf(context.query.users.findFirst).returns.toEqualTypeOf<PromiseLike<{ id: number; context: string }>>();
        return context.query.users.findFirst(1);
      });
    });
  });

  it('acquires and releases scoped database resources', async () => {
    const events: Array<string> = [];
    const transactions: Array<string> = [];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Runtime.Database;
        return yield* db.run((context) => context.query.users.findFirst(4));
      }).pipe(
        Effect.provide(
          Runtime.layerScoped({
            acquire: Effect.sync(() => {
              events.push('acquire');
              return {
                client: makeContext('scoped', transactions),
              };
            }),
            context: ({ client }) => client,
            release: () =>
              Effect.sync(() => {
                events.push('release');
              }),
          }),
        ),
      ),
    );

    expect(result).toEqual({ id: 4, context: 'scoped' });
    expect(events).toEqual(['acquire', 'release']);
  });

  it('releases scoped database resources when the program fails', async () => {
    const events: Array<string> = [];

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* Runtime.Database;
        return yield* Effect.fail('boom');
      }).pipe(
        Effect.provide(
          Runtime.layerScoped({
            acquire: Effect.sync(() => {
              events.push('acquire');
              return {
                client: makeContext('scoped', []),
              };
            }),
            context: ({ client }) => client,
            release: () =>
              Effect.sync(() => {
                events.push('release');
              }),
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(events).toEqual(['acquire', 'release']);
  });
});
