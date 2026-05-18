import type { TransactionRunner } from './runtime';

export type DrizzleMockFactory<TConfig, TClient> = {
  readonly mock: (config?: TConfig) => TClient;
};

export type MockTransactionEvent = {
  readonly depth: number;
};

export type DrizzleMockClient<TClient> = TClient &
  TransactionRunner<DrizzleMockClient<TClient>> & {
    readonly $effectDrizzleMock: {
      readonly depth: number;
      readonly transactions: ReadonlyArray<MockTransactionEvent>;
    };
  };

export type CreateDrizzleMockClientOptions = {
  readonly transactions?: Array<MockTransactionEvent>;
  readonly depth?: number;
};

export function createDrizzleMockClient<TConfig, TClient>(
  drizzle: DrizzleMockFactory<TConfig, TClient>,
  config?: TConfig,
  options: CreateDrizzleMockClientOptions = {},
): DrizzleMockClient<TClient> {
  const transactions = options.transactions ?? [];
  const depth = options.depth ?? 0;
  const client = drizzle.mock(config) as DrizzleMockClient<TClient>;

  Object.defineProperty(client, '$effectDrizzleMock', {
    configurable: true,
    enumerable: false,
    value: {
      depth,
      transactions,
    },
  });

  Object.defineProperty(client, 'transaction', {
    configurable: true,
    enumerable: false,
    value: async <TResult>(callback: (transaction: DrizzleMockClient<TClient>) => Promise<TResult>) => {
      transactions.push({ depth });
      const transactionClient = createDrizzleMockClient(drizzle, config, {
        transactions,
        depth: depth + 1,
      });
      return callback(transactionClient);
    },
  });

  return client;
}
