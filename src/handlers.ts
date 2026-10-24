import type postgres from "postgres";
import {
  computeNetBalances,
  equalSplits,
  minimizeTransactions,
} from "./balance";

type Db = postgres.Sql;
// biome-ignore lint/suspicious/noExplicitAny: postgres rows are untyped at runtime
type Row = Record<string, any>;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type SplitInput = { member_id: string; amount?: number; percent?: number };
type SplitPayload = { member_id: string; amount: number };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Returns computed splits payload, or an error message string. */
function computeSplits(
  amount: number,
  splitType: "equal" | "exact" | "percent",
  participants: string[],
  rawSplits: SplitInput[] | undefined,
  memberIdSet: Set<string>,
): SplitPayload[] | string {
  if (splitType === "equal") {
    const splitMap = equalSplits(amount, participants);
    return [...splitMap.entries()].map(([mid, amt]) => ({
      member_id: mid,
      amount: amt,
    }));
  }

  if (splitType === "exact") {
    if (!rawSplits?.length) return "splits array required for exact split";
    const splitMap = new Map(
      rawSplits.map((s) => [s.member_id, s.amount ?? 0]),
    );
    const invalid = [...splitMap.keys()].find((id) => !memberIdSet.has(id));
    if (invalid) return `Member ${invalid} is not in this group`;
    const total = [...splitMap.values()].reduce((a, b) => a + b, 0);
    if (Math.abs(total - amount) > 0.01) {
      return `Split amounts sum to ${total.toFixed(2)} but expense total is ${amount.toFixed(2)}`;
    }
    return [...splitMap.entries()].map(([mid, amt]) => ({
      member_id: mid,
      amount: amt,
    }));
  }

  if (splitType === "percent") {
    if (!rawSplits?.length) return "splits array required for percent split";
    const totalPct = rawSplits.reduce((a, s) => a + (s.percent ?? 0), 0);
    if (Math.abs(totalPct - 100) > 0.01) {
      return `Percentages sum to ${totalPct.toFixed(2)}%, must equal 100%`;
    }
    const invalid = rawSplits.find((s) => !memberIdSet.has(s.member_id));
    if (invalid) return `Member ${invalid.member_id} is not in this group`;
    const amountCents = Math.round(amount * 100);
    const amounts = rawSplits.map((s) => ({
      member_id: s.member_id,
      cents: Math.round((amountCents * (s.percent ?? 0)) / 100),
    }));
    const sumCents = amounts.reduce((a, b) => a + b.cents, 0);
    amounts[amounts.length - 1].cents += amountCents - sumCents;
    return amounts.map((a) => ({
      member_id: a.member_id,
      amount: a.cents / 100,
    }));
  }

  return `Unknown split_type: ${splitType}`;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1

function randomCode(): string {
  return Array.from(
    { length: 6 },
    () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
  ).join("");
}

async function uniqueJoinCode(db: Db): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    const [existing] = await db<
      Row[]
    >`SELECT id FROM groups WHERE join_code = ${code}`;
    if (!existing) return code;
  }
  throw new Error("Failed to generate unique join code after 10 attempts");
}

async function assertMemberInGroup(
  db: Db,
  memberId: string,
  groupId: string,
): Promise<Row | null> {
  const [member] = await db<Row[]>`
    SELECT id, display_name FROM members
    WHERE id = ${memberId}::uuid AND group_id = ${groupId}::uuid
  `;
  return member ?? null;
}

export async function createGroup(
  db: Db,
  args: { name: string; display_name: string; currency?: string },
): Promise<ToolResult> {
  const { name, display_name, currency = "USD" } = args;

  if (!name?.trim()) return err("Group name is required");
  if (!display_name?.trim()) return err("Display name is required");

  const join_code = await uniqueJoinCode(db);

  const [group] = await db<Row[]>`
    INSERT INTO groups (name, join_code, currency)
    VALUES (${name.trim()}, ${join_code}, ${currency})
    RETURNING id, name, join_code, currency
  `;
  const [member] = await db<Row[]>`
    INSERT INTO members (group_id, display_name)
    VALUES (${group.id}::uuid, ${display_name.trim()})
    RETURNING id, display_name
  `;

  return ok({
    group_id: group.id,
    group_name: group.name,
    join_code: group.join_code,
    currency: group.currency,
    member_id: member.id,
    display_name: member.display_name,
    message: `Group "${group.name}" created. Share join code ${group.join_code} with friends.`,
  });
}

export async function joinGroup(
  db: Db,
  args: { join_code: string; display_name?: string },
): Promise<ToolResult> {
  const { join_code, display_name } = args;

  if (!join_code?.trim()) return err("Join code is required");

  const code = join_code.trim().toUpperCase();

  const [group] = await db<Row[]>`
    SELECT id, name, currency FROM groups WHERE join_code = ${code}
  `;
  if (!group) return err(`No group found with join code ${code}`);

  const members = await db<Row[]>`
    SELECT id, display_name FROM members
    WHERE group_id = ${group.id}::uuid
    ORDER BY joined_at
  `;

  if (!display_name?.trim()) {
    return ok({
      group_id: group.id,
      group_name: group.name,
      currency: group.currency,
      pending: true,
      members,
      message:
        members.length > 0
          ? `Group "${group.name}" has these members: ${members.map((m: Row) => m.display_name).join(", ")}. ` +
            `Are you one of them? Call claim_member with their member_id, or call join_group again with a display_name to join as someone new.`
          : `Group "${group.name}" has no members yet. Call join_group with a display_name to be the first.`,
    });
  }

  const existing = members.find(
    (m: Row) =>
      m.display_name.toLowerCase() === display_name.trim().toLowerCase(),
  );

  if (existing) {
    return ok({
      group_id: group.id,
      group_name: group.name,
      currency: group.currency,
      member_id: existing.id,
      display_name: existing.display_name,
      members,
      rejoined: true,
      message: `Welcome back, ${existing.display_name}!`,
    });
  }

  const [member] = await db<Row[]>`
    INSERT INTO members (group_id, display_name)
    VALUES (${group.id}::uuid, ${display_name.trim()})
    RETURNING id, display_name
  `;

  return ok({
    group_id: group.id,
    group_name: group.name,
    currency: group.currency,
    member_id: member.id,
    display_name: member.display_name,
    members: [...members, { id: member.id, display_name: member.display_name }],
    message: `Joined "${group.name}" as ${member.display_name}.`,
  });
}

export async function getGroup(
  db: Db,
  args: { group_id: string },
): Promise<ToolResult> {
  const { group_id } = args;

  const [group] = await db<Row[]>`
    SELECT id, name, join_code, currency, created_at FROM groups
    WHERE id = ${group_id}::uuid
  `;
  if (!group) return err("Group not found");

  const members = await db<Row[]>`
    SELECT id, display_name, joined_at FROM members
    WHERE group_id = ${group_id}::uuid
    ORDER BY joined_at
  `;

  const [{ count }] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM expenses
    WHERE group_id = ${group_id}::uuid AND deleted_at IS NULL
  `;

  return ok({ ...group, members, expense_count: count });
}

export async function addExpense(
  db: Db,
  args: {
    group_id: string;
    member_id: string;
    paid_by: string;
    description: string;
    amount: number;
    currency?: string;
    split_type?: "equal" | "exact" | "percent";
    split_with?: string[];
    splits?: SplitInput[];
    date?: string;
    receipt_note?: string;
    original_amount?: number;
    original_currency?: string;
  },
): Promise<ToolResult> {
  const {
    group_id,
    member_id,
    paid_by,
    description,
    amount,
    currency = "USD",
    split_type = "equal",
    split_with,
    splits: rawSplits,
    date,
    receipt_note,
    original_amount,
    original_currency,
  } = args;

  if (!description?.trim()) return err("Description is required");
  if (!amount || amount <= 0) return err("Amount must be greater than 0");

  const allMembers = await db<Row[]>`
    SELECT id, display_name FROM members WHERE group_id = ${group_id}::uuid
  `;
  const memberMap = new Map(
    allMembers.map((m: Row) => [m.id as string, m as Row]),
  );

  const requester = memberMap.get(member_id);
  if (!requester) return err("You are not a member of this group");
  const payer = memberMap.get(paid_by);
  if (!payer) return err("The member who paid is not in this group");

  const memberIdSet = new Set(memberMap.keys());

  let participants: string[];
  if (split_with && split_with.length > 0) {
    const invalid = split_with.find((id) => !memberIdSet.has(id));
    if (invalid) return err(`Member ${invalid} is not in this group`);
    participants = split_with;
  } else {
    participants = [...memberIdSet];
  }

  if (participants.length === 0) return err("No participants for split");

  const splitsPayload = computeSplits(
    amount,
    split_type,
    participants,
    rawSplits,
    memberIdSet,
  );
  if (typeof splitsPayload === "string") return err(splitsPayload);

  const [{ expense_id: expenseId }] = await db<{ expense_id: string }[]>`
    SELECT create_expense_with_splits(
      ${group_id}::uuid,
      ${paid_by}::uuid,
      ${member_id}::uuid,
      ${description.trim()},
      ${amount}::numeric,
      ${currency},
      ${receipt_note ?? null},
      ${db.json(splitsPayload)}::jsonb,
      ${original_amount ?? null}::numeric,
      ${original_currency?.toUpperCase() ?? null},
      ${date ?? null}::date
    ) AS expense_id
  `;

  const nameMap = new Map(
    allMembers.map((m: Row) => [m.id as string, m.display_name as string]),
  );
  const splitSummary = splitsPayload.map((s) => ({
    member: nameMap.get(s.member_id),
    amount: s.amount,
  }));

  return ok({
    expense_id: expenseId,
    description: description.trim(),
    amount,
    currency,
    paid_by: { id: paid_by, display_name: payer.display_name },
    date: date ?? new Date().toISOString().slice(0, 10),
    splits: splitSummary,
    receipt_note: receipt_note ?? null,
    ...(original_amount && original_currency
      ? {
          original: {
            amount: original_amount,
            currency: original_currency.toUpperCase(),
          },
        }
      : {}),
    message:
      original_amount && original_currency
        ? `Expense logged: "${description.trim()}" for ${original_currency.toUpperCase()} ${original_amount.toFixed(2)} → ${currency} ${amount.toFixed(2)}, paid by ${payer.display_name}`
        : `Expense logged: "${description.trim()}" for ${currency} ${amount.toFixed(2)}, paid by ${payer.display_name}`,
  });
}

export async function listExpenses(
  db: Db,
  args: {
    group_id: string;
    limit?: number;
    offset?: number;
    paid_by?: string;
  },
): Promise<ToolResult> {
  const { group_id, limit = 20, offset = 0, paid_by } = args;
  const lim = Math.min(limit, 100);

  const paidByFilter = paid_by ? db`AND paid_by = ${paid_by}::uuid` : db``;

  const expenses = await db<Row[]>`
    SELECT id, description, amount, currency, original_amount, original_currency,
           date, receipt_note, created_at, paid_by, created_by
    FROM expenses
    WHERE group_id = ${group_id}::uuid AND deleted_at IS NULL
    ${paidByFilter}
    ORDER BY created_at DESC
    LIMIT ${lim} OFFSET ${offset}
  `;

  const [{ count }] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM expenses
    WHERE group_id = ${group_id}::uuid AND deleted_at IS NULL
    ${paidByFilter}
  `;

  if (!expenses.length) return ok({ expenses: [], total: 0, has_more: false });

  const expenseIds = expenses.map((e: Row) => e.id as string);
  const splits = await db<Row[]>`
    SELECT expense_id, member_id, amount FROM expense_splits
    WHERE expense_id = ANY(${db.array(expenseIds)}::uuid[])
  `;

  const members = await db<Row[]>`
    SELECT id, display_name FROM members WHERE group_id = ${group_id}::uuid
  `;

  const nameMap = new Map(
    members.map((m: Row) => [m.id as string, m.display_name as string]),
  );
  const splitsByExpense = new Map<
    string,
    Array<{ member: string; amount: number }>
  >();
  for (const s of splits) {
    if (!splitsByExpense.has(s.expense_id))
      splitsByExpense.set(s.expense_id, []);
    splitsByExpense.get(s.expense_id)?.push({
      member: nameMap.get(s.member_id) ?? s.member_id,
      amount: parseFloat(s.amount),
    });
  }

  const result = expenses.map((e: Row) => ({
    id: e.id,
    description: e.description,
    date: e.date,
    amount: parseFloat(e.amount),
    currency: e.currency,
    ...(e.original_amount
      ? {
          original: {
            amount: parseFloat(e.original_amount),
            currency: e.original_currency,
          },
        }
      : {}),
    paid_by: {
      id: e.paid_by,
      display_name: nameMap.get(e.paid_by) ?? e.paid_by,
    },
    splits: splitsByExpense.get(e.id) ?? [],
    receipt_note: e.receipt_note,
    created_at: e.created_at,
    logged_by: nameMap.get(e.created_by) ?? e.created_by,
  }));

  return ok({
    expenses: result,
    total: count,
    has_more: offset + expenses.length < count,
  });
}

export async function deleteExpense(
  db: Db,
  args: { expense_id: string; member_id: string },
): Promise<ToolResult> {
  const { expense_id, member_id } = args;

  const [expense] = await db<Row[]>`
    SELECT id, description, created_by FROM expenses
    WHERE id = ${expense_id}::uuid AND deleted_at IS NULL
  `;
  if (!expense) return err("Expense not found");
  if (expense.created_by !== member_id)
    return err("You can only delete expenses you logged");

  await db`UPDATE expenses SET deleted_at = now() WHERE id = ${expense_id}::uuid`;

  return ok({
    deleted: true,
    expense_id,
    message: `Expense "${expense.description}" has been deleted`,
  });
}

export async function getBalances(
  db: Db,
  args: { group_id: string },
): Promise<ToolResult> {
  const { group_id } = args;

  const [group] = await db<Row[]>`
    SELECT id, name, currency FROM groups WHERE id = ${group_id}::uuid
  `;
  if (!group) return err("Group not found");

  const [members, allExpenses, settlementRows] = await Promise.all([
    db<
      Row[]
    >`SELECT id, display_name FROM members WHERE group_id = ${group_id}::uuid`,
    db<
      Row[]
    >`SELECT id, paid_by, amount, currency FROM expenses WHERE group_id = ${group_id}::uuid AND deleted_at IS NULL`,
    db<
      Row[]
    >`SELECT paid_by, paid_to, amount FROM settlements WHERE group_id = ${group_id}::uuid`,
  ]);

  const expenseRows = allExpenses.filter(
    (e: Row) => e.currency === group.currency,
  );
  const foreignCount = allExpenses.length - expenseRows.length;

  const expenseIds = expenseRows.map((e: Row) => e.id as string);
  const splitRows =
    expenseIds.length > 0
      ? await db<Row[]>`
        SELECT expense_id, member_id, amount FROM expense_splits
        WHERE expense_id = ANY(${db.array(expenseIds)}::uuid[])
      `
      : [];

  const expenses = expenseRows.map((e: Row) => ({
    id: e.id as string,
    paid_by: e.paid_by as string,
    amount: parseFloat(e.amount),
    splits: (splitRows as Row[])
      .filter((s) => s.expense_id === e.id)
      .map((s) => ({
        member_id: s.member_id as string,
        amount: parseFloat(s.amount),
      })),
  }));

  const settlements = settlementRows.map((s: Row) => ({
    paid_by: s.paid_by as string,
    paid_to: s.paid_to as string,
    amount: parseFloat(s.amount),
  }));

  const membersList = members.map((m: Row) => ({
    id: m.id as string,
    display_name: m.display_name as string,
  }));
  const netBalances = computeNetBalances(membersList, expenses, settlements);
  const suggestions = minimizeTransactions(netBalances);

  return ok({
    group: { id: group.id, name: group.name, currency: group.currency },
    net_balances: netBalances,
    settlements_needed: suggestions,
    everyone_settled: suggestions.length === 0,
    ...(foreignCount > 0
      ? {
          warning: `${foreignCount} expense(s) in non-${group.currency} currency excluded from balances`,
        }
      : {}),
  });
}

export async function recordSettlement(
  db: Db,
  args: {
    group_id: string;
    paid_by: string;
    paid_to: string;
    amount: number;
    note?: string;
  },
): Promise<ToolResult> {
  const { group_id, paid_by, paid_to, amount, note } = args;

  if (!amount || amount <= 0) return err("Amount must be greater than 0");
  if (paid_by === paid_to) return err("paid_by and paid_to must be different");

  const payer = await assertMemberInGroup(db, paid_by, group_id);
  if (!payer) return err("Payer is not a member of this group");

  const payee = await assertMemberInGroup(db, paid_to, group_id);
  if (!payee) return err("Recipient is not a member of this group");

  await db`
    INSERT INTO settlements (group_id, paid_by, paid_to, amount, note)
    VALUES (${group_id}::uuid, ${paid_by}::uuid, ${paid_to}::uuid, ${amount}::numeric, ${note ?? null})
  `;

  return ok({
    recorded: true,
    message: `Recorded: ${payer.display_name} paid ${payee.display_name} ${amount.toFixed(2)}`,
    paid_by: payer.display_name,
    paid_to: payee.display_name,
    amount,
  });
}

export async function getSettlementHistory(
  db: Db,
  args: { group_id: string; limit?: number },
): Promise<ToolResult> {
  const { group_id, limit = 20 } = args;

  const settlements = await db<Row[]>`
    SELECT id, paid_by, paid_to, amount, note, created_at FROM settlements
    WHERE group_id = ${group_id}::uuid
    ORDER BY created_at DESC
    LIMIT ${Math.min(limit, 100)}
  `;

  if (!settlements.length) return ok({ settlements: [] });

  const memberIds = [
    ...new Set(
      settlements.flatMap((s: Row) => [
        s.paid_by as string,
        s.paid_to as string,
      ]),
    ),
  ];
  const members = await db<Row[]>`
    SELECT id, display_name FROM members
    WHERE id = ANY(${db.array(memberIds)}::uuid[])
  `;

  const nameMap = new Map(
    members.map((m: Row) => [m.id as string, m.display_name as string]),
  );

  return ok({
    settlements: settlements.map((s: Row) => ({
      id: s.id,
      paid_by: { id: s.paid_by, display_name: nameMap.get(s.paid_by) },
      paid_to: { id: s.paid_to, display_name: nameMap.get(s.paid_to) },
      amount: parseFloat(s.amount),
      note: s.note,
      created_at: s.created_at,
    })),
  });
}

export async function addMember(
  db: Db,
  args: { group_id: string; member_id: string; display_name: string },
): Promise<ToolResult> {
  const { group_id, member_id, display_name } = args;

  if (!display_name?.trim()) return err("Display name is required");

  const requester = await assertMemberInGroup(db, member_id, group_id);
  if (!requester) return err("You are not a member of this group");

  const [conflict] = await db<Row[]>`
    SELECT id FROM members
    WHERE group_id = ${group_id}::uuid AND display_name = ${display_name.trim()}
  `;
  if (conflict)
    return err(`"${display_name}" is already a member of this group`);

  const [member] = await db<Row[]>`
    INSERT INTO members (group_id, display_name)
    VALUES (${group_id}::uuid, ${display_name.trim()})
    RETURNING id, display_name
  `;

  return ok({
    member_id: member.id,
    display_name: member.display_name,
    message: `${display_name} has been added. They can join using the group's join code and pick their name from the list.`,
  });
}

export async function claimMember(
  db: Db,
  args: { member_id: string },
): Promise<ToolResult> {
  const { member_id } = args;

  const [member] = await db<Row[]>`
    SELECT id, display_name, group_id FROM members WHERE id = ${member_id}::uuid
  `;
  if (!member) return err("Member not found");

  const [group] = await db<Row[]>`
    SELECT id, name, currency FROM groups WHERE id = ${member.group_id}::uuid
  `;

  return ok({
    member_id: member.id,
    display_name: member.display_name,
    group_id: member.group_id,
    group_name: group?.name,
    currency: group?.currency,
    message: `You are ${member.display_name} in ${group?.name}.`,
  });
}

export async function listMembers(
  db: Db,
  args: { group_id: string },
): Promise<ToolResult> {
  const members = await db<Row[]>`
    SELECT id, display_name, joined_at FROM members
    WHERE group_id = ${args.group_id}::uuid
    ORDER BY joined_at
  `;
  return ok({ members });
}

export async function getMember(
  db: Db,
  args: { member_id: string },
): Promise<ToolResult> {
  const { member_id } = args;

  const [member] = await db<Row[]>`
    SELECT id, display_name, joined_at, group_id FROM members WHERE id = ${member_id}::uuid
  `;
  if (!member) return err("Member not found");

  const [group] = await db<Row[]>`
    SELECT id, name, join_code, currency FROM groups WHERE id = ${member.group_id}::uuid
  `;

  return ok({
    member_id: member.id,
    display_name: member.display_name,
    joined_at: member.joined_at,
    group_id: member.group_id,
    group_name: group?.name,
    join_code: group?.join_code,
    currency: group?.currency,
  });
}

export async function renameMember(
  db: Db,
  args: { member_id: string; display_name: string },
): Promise<ToolResult> {
  const { member_id, display_name } = args;

  if (!display_name?.trim()) return err("Display name is required");

  const [member] = await db<Row[]>`
    SELECT id, group_id, display_name FROM members WHERE id = ${member_id}::uuid
  `;
  if (!member) return err("Member not found");

  const [conflict] = await db<Row[]>`
    SELECT id FROM members
    WHERE group_id = ${member.group_id}::uuid
      AND display_name = ${display_name.trim()}
      AND id != ${member_id}::uuid
  `;
  if (conflict)
    return err(`Display name "${display_name}" is already taken in this group`);

  await db`UPDATE members SET display_name = ${display_name.trim()} WHERE id = ${member_id}::uuid`;

  return ok({
    member_id,
    old_display_name: member.display_name,
    new_display_name: display_name.trim(),
    message: `Name changed from "${member.display_name}" to "${display_name.trim()}"`,
  });
}

export async function updateExpense(
  db: Db,
  args: {
    expense_id: string;
    member_id: string;
    description?: string;
    amount?: number;
    currency?: string;
    paid_by?: string;
    date?: string;
    receipt_note?: string;
    original_amount?: number;
    original_currency?: string;
    split_type?: "equal" | "exact" | "percent";
    split_with?: string[];
    splits?: SplitInput[];
  },
): Promise<ToolResult> {
  const {
    expense_id,
    member_id,
    description,
    amount,
    currency,
    paid_by,
    date,
    receipt_note,
    original_amount,
    original_currency,
    split_type = "equal",
    split_with,
    splits: rawSplits,
  } = args;

  if ((original_amount !== undefined) !== (original_currency !== undefined)) {
    return err(
      "original_amount and original_currency must be provided together",
    );
  }

  const [expense] = await db<Row[]>`
    SELECT id, description, amount, currency, paid_by, created_by, group_id, date,
           receipt_note, original_amount, original_currency
    FROM expenses
    WHERE id = ${expense_id}::uuid AND deleted_at IS NULL
  `;
  if (!expense) return err("Expense not found");
  if (expense.created_by !== member_id)
    return err("You can only update expenses you logged");

  if (paid_by) {
    const payer = await assertMemberInGroup(db, paid_by, expense.group_id);
    if (!payer) return err("The member who paid is not in this group");
  }

  const effectiveAmount = amount ?? parseFloat(expense.amount);
  const splitsExplicitlyProvided =
    split_with !== undefined ||
    rawSplits !== undefined ||
    split_type !== "equal";
  const amountChanged =
    amount !== undefined && amount !== parseFloat(expense.amount);
  const needSplitRecompute = splitsExplicitlyProvided || amountChanged;

  let splitsPayload: SplitPayload[] | null = null;

  if (needSplitRecompute) {
    if (splitsExplicitlyProvided) {
      const allMembers = await db<Row[]>`
        SELECT id, display_name FROM members WHERE group_id = ${expense.group_id}::uuid
      `;
      const memberIdSet = new Set(allMembers.map((m: Row) => m.id as string));

      let participants: string[];
      if (split_with && split_with.length > 0) {
        const invalid = split_with.find((id) => !memberIdSet.has(id));
        if (invalid) return err(`Member ${invalid} is not in this group`);
        participants = split_with;
      } else {
        participants = [...memberIdSet];
      }
      if (participants.length === 0) return err("No participants for split");

      const result = computeSplits(
        effectiveAmount,
        split_type,
        participants,
        rawSplits,
        memberIdSet,
      );
      if (typeof result === "string") return err(result);
      splitsPayload = result;
    } else {
      // Only amount changed — re-split equally among existing participants
      const existingSplits = await db<Row[]>`
        SELECT member_id FROM expense_splits WHERE expense_id = ${expense_id}::uuid
      `;
      const existingParticipants = existingSplits.map(
        (s: Row) => s.member_id as string,
      );
      if (!existingParticipants.length)
        return err("No existing participants found");
      const splitMap = equalSplits(effectiveAmount, existingParticipants);
      splitsPayload = [...splitMap.entries()].map(([mid, amt]) => ({
        member_id: mid,
        amount: amt,
      }));
    }
  }

  const [{ expense_id: updatedId }] = await db<{ expense_id: string }[]>`
    SELECT update_expense_with_splits(
      ${expense_id}::uuid,
      ${description ?? null},
      ${amount ?? null}::numeric,
      ${currency ?? null},
      ${paid_by ?? null}::uuid,
      ${date ?? null}::date,
      ${receipt_note ?? null},
      ${original_amount ?? null}::numeric,
      ${original_currency?.toUpperCase() ?? null},
      ${false}::boolean,
      ${splitsPayload !== null ? db.json(splitsPayload) : null}::jsonb
    ) AS expense_id
  `;

  const effectivePaidBy: string = paid_by ?? expense.paid_by;

  const [updatedRows, finalSplits] = await Promise.all([
    db<Row[]>`
      SELECT id, description, amount, currency, paid_by, date, receipt_note, original_amount, original_currency
      FROM expenses WHERE id = ${updatedId}::uuid
    `,
    db<
      Row[]
    >`SELECT member_id, amount FROM expense_splits WHERE expense_id = ${expense_id}::uuid`,
  ]);
  const [updated] = updatedRows;

  const splitMemberIds = finalSplits.map((s: Row) => s.member_id as string);
  const [payerRows, splitMembers] = await Promise.all([
    db<
      Row[]
    >`SELECT id, display_name FROM members WHERE id = ${effectivePaidBy}::uuid`,
    splitMemberIds.length > 0
      ? db<
          Row[]
        >`SELECT id, display_name FROM members WHERE id = ANY(${db.array(splitMemberIds)}::uuid[])`
      : Promise.resolve([] as Row[]),
  ]);
  const [payerMember] = payerRows;

  const nameMap = new Map(
    (splitMembers as Row[]).map((m) => [
      m.id as string,
      m.display_name as string,
    ]),
  );
  const splitSummary = finalSplits.map((s: Row) => ({
    member: nameMap.get(s.member_id),
    amount: parseFloat(s.amount),
  }));

  const finalAmount = parseFloat(updated?.amount ?? expense.amount);
  const finalCurrency = updated?.currency ?? expense.currency;
  const finalOrigAmount = updated?.original_amount;
  const finalOrigCurrency = updated?.original_currency;

  return ok({
    expense_id: updatedId,
    description: updated?.description,
    amount: finalAmount,
    currency: finalCurrency,
    paid_by: { id: updated?.paid_by, display_name: payerMember?.display_name },
    date: updated?.date,
    splits: splitSummary,
    receipt_note: updated?.receipt_note ?? null,
    ...(finalOrigAmount && finalOrigCurrency
      ? {
          original: {
            amount: parseFloat(finalOrigAmount),
            currency: finalOrigCurrency,
          },
        }
      : {}),
    message: `Expense updated: "${updated?.description}"`,
  });
}

// biome-ignore lint/suspicious/noExplicitAny: MCP args are untyped JSON
type Args = Record<string, any>;

export async function handleToolCall(
  db: Db,
  name: string,
  args: Args,
): Promise<ToolResult> {
  // biome-ignore lint/suspicious/noExplicitAny: dispatch requires escape from union typing
  const a = args as any;
  switch (name) {
    case "create_group":
      return createGroup(db, a);
    case "join_group":
      return joinGroup(db, a);
    case "get_group":
      return getGroup(db, a);
    case "add_expense":
      return addExpense(db, a);
    case "list_expenses":
      return listExpenses(db, a);
    case "delete_expense":
      return deleteExpense(db, a);
    case "update_expense":
      return updateExpense(db, a);
    case "get_balances":
      return getBalances(db, a);
    case "record_settlement":
      return recordSettlement(db, a);
    case "get_settlement_history":
      return getSettlementHistory(db, a);
    case "add_member":
      return addMember(db, a);
    case "claim_member":
      return claimMember(db, a);
    case "list_members":
      return listMembers(db, a);
    case "get_member":
      return getMember(db, a);
    case "rename_member":
      return renameMember(db, a);
    default:
      return err(`Unknown tool: ${name}`);
  }
}
