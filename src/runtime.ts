import { type Cause, Context, Effect, Exit, Layer, Runtime } from 'effect';
import { mapDatabaseError } from './error-mapper';
import type { DatabaseError } from './errors';

export interface TransactionRunner<TTransaction> {
  transaction<TResult>(callback: (transaction: TTransaction) => PromiseLike<TResult>): PromiseLike<TResult>;
}

export type DatabaseContextValue<TClient, TTransaction> = TClient | TTransaction;
export type DatabaseQueryCallback<TContext, TResult> = (context: TContext) => PromiseLike<TResult>;
export type DatabaseTransactionEffect<TResult, TError, TRequirements> = Effect.Effect<TResult, TError, TRequirements>;

export type ScopedDatabaseLayerOptions<TResource, TContext, TAcquireError, TAcquireRequirements, TReleaseRequirements> = {
  readonly acquire: Effect.Effect<TResource, TAcquireError, TAcquireRequirements>;
  readonly context: (resource: TResource) => TContext;
  readonly release: (resource: TResource) => Effect.Effect<void, never, TReleaseRequirements>;
};

export type DatabaseService<TContext> = {
  readonly run: <TResult>(
    cb: DatabaseQueryCallback<TContext, TResult>,
  ) => Effect.Effect<TResult, DatabaseError>;
  readonly transaction: <TResult, TError, TRequirements>(
    eff: DatabaseTransactionEffect<TResult, TError, TRequirements>,
  ) => Effect.Effect<TResult, TError | DatabaseError, TRequirements>;
};

export type TransactionBoundaryService<TContext> = {
  readonly execute: <TResult, TError, TRequirements>(
    eff: Effect.Effect<TResult, TError, TRequirements>,
  ) => Effect.Effect<TResult, TError | DatabaseError, DatabaseClass<TContext> | TRequirements>;
};

export interface DatabaseContextClass<TContext>
  extends Context.TagClass<
    DatabaseContextClass<TContext>,
    '@codeva-dev/effect-drizzle/DatabaseContext',
    TContext
  > {
  layer(context: TContext): Layer.Layer<DatabaseContextClass<TContext>>;
}

export interface DatabaseClass<TContext>
  extends Context.Tag<DatabaseClass<TContext>, DatabaseService<TContext>> {
  readonly key: '@codeva-dev/effect-drizzle/Database';
  readonly Default: Layer.Layer<DatabaseClass<TContext>>;
}

export interface TransactionBoundaryClass<TContext>
  extends Context.Tag<TransactionBoundaryClass<TContext>, TransactionBoundaryService<TContext>> {
  readonly key: '@codeva-dev/effect-drizzle/TransactionBoundary';
  readonly Default: Layer.Layer<TransactionBoundaryClass<TContext>>;
  readonly execute: <TResult, TError, TRequirements>(
    eff: Effect.Effect<TResult, TError, TRequirements>,
  ) => Effect.Effect<TResult, TError | DatabaseError, DatabaseClass<TContext> | TRequirements>;
}

export type DatabaseRuntime<TClient, TTransaction> = {
  readonly DatabaseContext: DatabaseContextClass<DatabaseContextValue<TClient, TTransaction>>;
  readonly Database: DatabaseClass<DatabaseContextValue<TClient, TTransaction>>;
  readonly TransactionBoundary: TransactionBoundaryClass<DatabaseContextValue<TClient, TTransaction>>;
  readonly layer: (
    context: DatabaseContextValue<TClient, TTransaction>,
  ) => Layer.Layer<
    | DatabaseContextClass<DatabaseContextValue<TClient, TTransaction>>
    | DatabaseClass<DatabaseContextValue<TClient, TTransaction>>
    | TransactionBoundaryClass<DatabaseContextValue<TClient, TTransaction>>
  >;
  readonly layerScoped: <TResource, TAcquireError = never, TAcquireRequirements = never, TReleaseRequirements = never>(
    options: ScopedDatabaseLayerOptions<
      TResource,
      DatabaseContextValue<TClient, TTransaction>,
      TAcquireError,
      TAcquireRequirements,
      TReleaseRequirements
    >,
  ) => Layer.Layer<
    | DatabaseContextClass<DatabaseContextValue<TClient, TTransaction>>
    | DatabaseClass<DatabaseContextValue<TClient, TTransaction>>
    | TransactionBoundaryClass<DatabaseContextValue<TClient, TTransaction>>,
    TAcquireError,
    TAcquireRequirements | TReleaseRequirements
  >;
};

class TxFailure<TErr> {
  constructor(readonly cause: Cause.Cause<TErr>) {}
}

export function makeDatabaseRuntime<
  TClient extends TransactionRunner<TTransaction>,
  TTransaction extends TransactionRunner<TTransaction>,
>(): DatabaseRuntime<TClient, TTransaction> {
  type TContext = DatabaseContextValue<TClient, TTransaction>;

  class DatabaseContext extends Context.Tag('@codeva-dev/effect-drizzle/DatabaseContext')<
    DatabaseContext,
    TContext
  >() {
    static layer(context: TContext): Layer.Layer<DatabaseContext> {
      return Layer.succeed(DatabaseContext, context);
    }
  }

  const run = Effect.fn(function* <TResult>(cb: DatabaseQueryCallback<TContext, TResult>) {
    const context = yield* DatabaseContext;

    return yield* Effect.async<TResult, DatabaseError>((resume) => {
      Promise.resolve(cb(context))
        .then((result) => resume(Effect.succeed(result)))
        .catch((cause) => {
          const mapped = mapDatabaseError(cause, 'query');
          resume(mapped ? Effect.fail(mapped) : Effect.die(cause));
        });
    });
  });

  const transaction = Effect.fn(function* <TResult, TError, TRequirements>(
    eff: DatabaseTransactionEffect<TResult, TError, TRequirements>,
  ) {
    const context = yield* DatabaseContext;
    const runtime = yield* Effect.runtime<TRequirements>();
    const runPromiseExit = Runtime.runPromiseExit(runtime);

    return yield* Effect.async<TResult, TError | DatabaseError, TRequirements>((resume) => {
      Promise.resolve(
        context.transaction(async (tx) => {
          const exit = await runPromiseExit(eff.pipe(Effect.provideService(DatabaseContext, tx)));
          if (Exit.isFailure(exit)) throw new TxFailure(exit.cause);
          return exit.value;
        }),
      )
        .then((result) => resume(Effect.succeed(result)))
        .catch((cause) => {
          if (cause instanceof TxFailure) {
            resume(Effect.failCause(cause.cause));
            return;
          }

          const mapped = mapDatabaseError(cause, 'transaction');
          resume(mapped ? Effect.fail(mapped) : Effect.die(cause));
        });
    });
  });

  class Database extends Effect.Service<Database>()('@codeva-dev/effect-drizzle/Database', {
    succeed: {
      run,
      transaction,
    },
  }) {}

  class TransactionBoundary extends Effect.Service<TransactionBoundary>()(
    '@codeva-dev/effect-drizzle/TransactionBoundary',
    {
      accessors: true,
      succeed: {
        execute: <TResult, TError, TRequirements>(eff: Effect.Effect<TResult, TError, TRequirements>) =>
          Effect.gen(function* () {
            const db = yield* Database;
            return yield* db.transaction(eff);
          }),
      },
    },
  ) {
    declare static readonly execute: <TResult, TError, TRequirements>(
      eff: Effect.Effect<TResult, TError, TRequirements>,
    ) => Effect.Effect<TResult, TError | DatabaseError, Database | TRequirements>;
  }

  const layer = (context: TContext) =>
    Layer.mergeAll(DatabaseContext.layer(context), Database.Default, TransactionBoundary.Default);

  const layerScoped = <
    TResource,
    TAcquireError = never,
    TAcquireRequirements = never,
    TReleaseRequirements = never,
  >(
    options: ScopedDatabaseLayerOptions<TResource, TContext, TAcquireError, TAcquireRequirements, TReleaseRequirements>,
  ) => {
    const contextLayer = Layer.scoped(
      DatabaseContext,
      Effect.acquireRelease(options.acquire, options.release).pipe(Effect.map(options.context)),
    );

    return Layer.mergeAll(contextLayer, Database.Default, TransactionBoundary.Default);
  };

  return {
    DatabaseContext,
    Database,
    TransactionBoundary,
    layer,
    layerScoped,
  } as unknown as DatabaseRuntime<TClient, TTransaction>;
}
