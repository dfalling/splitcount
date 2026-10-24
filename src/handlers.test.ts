import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { handleToolCall } from "./handlers";
import { runMigrations } from "./migrate";

// Integration tests: require a disposable Postgres. Uses TEST_DATABASE_URL
// (never DATABASE_URL) so they can't accidentally run against a real database.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON blobs
type Json = Record<string, any>;

describe.skipIf(!TEST_DATABASE_URL)("add_expense / update_expense", () => {
  let sql: postgres.Sql;
  let groupId: string;
  let memberIds: string[];

  async function call(name: string, args: Json): Promise<Json> {
    const result = await handleToolCall(sql, name, args);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text);
  }

  async function storedSplits(expenseId: string) {
    const rows = await sql<{ member_id: string; amount: string }[]>`
      SELECT member_id, amount FROM expense_splits
      WHERE expense_id = ${expenseId}::uuid ORDER BY amount DESC, member_id
    `;
    return rows.map((r) => ({ member_id: r.member_id, amount: +r.amount }));
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL as string, { onnotice: () => {} });
    await runMigrations(sql);

    const group = await call("create_group", {
      name: `test-${crypto.randomUUID()}`,
      display_name: "Alice",
    });
    groupId = group.group_id;
    memberIds = [group.member_id];
    for (const name of ["Bob", "Carol", "Dave", "Erin"]) {
      const m = await call("add_member", {
        group_id: groupId,
        member_id: group.member_id,
        display_name: name,
      });
      memberIds.push(m.member_id);
    }
  });

  afterAll(async () => {
    if (groupId) {
      await sql`DELETE FROM expenses WHERE group_id = ${groupId}::uuid`;
      await sql`DELETE FROM groups WHERE id = ${groupId}::uuid`;
    }
    await sql?.end();
  });

  test("equal split across all members", async () => {
    const res = await call("add_expense", {
      group_id: groupId,
      member_id: memberIds[0],
      paid_by: memberIds[0],
      description: "Dinner",
      amount: 100,
    });
    const splits = await storedSplits(res.expense_id);
    expect(splits).toHaveLength(5);
    expect(splits.every((s) => s.amount === 20)).toBe(true);
  });

  test("equal split with explicit split_with", async () => {
    const res = await call("add_expense", {
      group_id: groupId,
      member_id: memberIds[0],
      paid_by: memberIds[1],
      description: "Groceries",
      amount: 10,
      split_type: "equal",
      split_with: memberIds,
    });
    const splits = await storedSplits(res.expense_id);
    expect(splits).toHaveLength(5);
    expect(splits.reduce((a, s) => a + s.amount, 0)).toBeCloseTo(10, 2);
  });

  test("exact split", async () => {
    const amounts = [10, 20, 30, 15.5, 4.5];
    const res = await call("add_expense", {
      group_id: groupId,
      member_id: memberIds[0],
      paid_by: memberIds[2],
      description: "Tickets",
      amount: 80,
      split_type: "exact",
      splits: memberIds.map((id, i) => ({ member_id: id, amount: amounts[i] })),
    });
    const splits = await storedSplits(res.expense_id);
    expect(splits).toEqual(
      memberIds
        .map((id, i) => ({ member_id: id, amount: amounts[i] }))
        .sort((a, b) => b.amount - a.amount),
    );
  });

  test("percent split", async () => {
    const res = await call("add_expense", {
      group_id: groupId,
      member_id: memberIds[0],
      paid_by: memberIds[3],
      description: "Hotel",
      amount: 200,
      split_type: "percent",
      splits: [
        { member_id: memberIds[0], percent: 50 },
        { member_id: memberIds[1], percent: 25 },
        { member_id: memberIds[2], percent: 25 },
      ],
    });
    const splits = await storedSplits(res.expense_id);
    expect(splits.map((s) => s.amount)).toEqual([100, 50, 50]);
  });

  test("update_expense replaces splits", async () => {
    const created = await call("add_expense", {
      group_id: groupId,
      member_id: memberIds[0],
      paid_by: memberIds[0],
      description: "Taxi",
      amount: 50,
    });
    await call("update_expense", {
      expense_id: created.expense_id,
      member_id: memberIds[0],
      amount: 30,
      split_type: "exact",
      splits: [
        { member_id: memberIds[0], amount: 10 },
        { member_id: memberIds[4], amount: 20 },
      ],
    });
    const splits = await storedSplits(created.expense_id);
    expect(splits).toEqual([
      { member_id: memberIds[4], amount: 20 },
      { member_id: memberIds[0], amount: 10 },
    ]);
  });
});
