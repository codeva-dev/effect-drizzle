import { describe, expect, it } from 'vitest';
import { createDrizzleMockClient } from '../src';

type MockConfig = {
  readonly schema: {
    readonly users: unknown;
  };
};

type DriverClient = {
  readonly query: {
    readonly users: {
      readonly findMany: () => Promise<Array<{ id: number }>>;
    };
  };
};

const makeDriver = () => {
  let calls = 0;

  const drizzle = {
    mock: (_config?: MockConfig): DriverClient => {
      calls += 1;
      return {
        query: {
          users: {
            findMany: async () => [{ id: calls }],
          },
        },
      };
    },
  };

  return {
    drizzle,
    calls: () => calls,
  };
};

describe('createDrizzleMockClient', () => {
  it('uses a driver drizzle.mock factory and keeps the client shape', async () => {
    const { drizzle, calls } = makeDriver();
    const client = createDrizzleMockClient(drizzle, { schema: { users: {} } });

    expect(calls()).toBe(1);
    await expect(client.query.users.findMany()).resolves.toEqual([{ id: 1 }]);
  });

  it('adds nested transaction support to driver mock clients', async () => {
    const { drizzle, calls } = makeDriver();
    const client = createDrizzleMockClient(drizzle, { schema: { users: {} } });

    const result = await client.transaction((tx1) =>
      tx1.transaction(async (tx2) => {
        expect(tx1.$effectDrizzleMock.depth).toBe(1);
        expect(tx2.$effectDrizzleMock.depth).toBe(2);
        return tx2.query.users.findMany();
      }),
    );

    expect(result).toEqual([{ id: 3 }]);
    expect(calls()).toBe(3);
    expect(client.$effectDrizzleMock.transactions).toEqual([{ depth: 0 }, { depth: 1 }]);
  });
});
