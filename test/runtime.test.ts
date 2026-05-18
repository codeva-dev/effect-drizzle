import { Effect, Exit } from 'effect';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { makeDatabaseRuntime, type TransactionRunner, UnknownSqlError } from '../src';

type MockContext = TransactionRunner<MockContext> & {
  readonly kind: string;
  readonly query: {
    readonly users: {
      findFirst: (id: number) => Promise<{ id: number; context: string }>;
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
            throw { code: '99999', message: 'known SQL-shaped error' };
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

  it('keeps the exact client type in query callbacks', () => {
    Effect.gen(function* () {
      const db = yield* Runtime.Database;
      yield* db.run((context) => {
        expectTypeOf(context.query.users.findFirst).parameter(0).toEqualTypeOf<number>();
        expectTypeOf(context.query.users.findFirst).returns.toEqualTypeOf<Promise<{ id: number; context: string }>>();
        return context.query.users.findFirst(1);
      });
    });
  });
});
