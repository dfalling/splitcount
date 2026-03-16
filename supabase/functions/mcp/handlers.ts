import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  computeNetBalances,
  equalSplits,
  minimizeTransactions,
} from "./balance.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ── Join code ──────────────────────────────────────────────────────────────

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1

function randomCode(): string {
  return Array.from(
    { length: 6 },
    () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
  ).join("");
}

async function uniqueJoinCode(db: SupabaseClient): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    const { data } = await db
      .from("groups")
      .select("id")
      .eq("join_code", code)
      .maybeSingle();
    if (!data) return code;
  }
  throw new Error("Failed to generate unique join code after 10 attempts");
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function assertMemberInGroup(
  db: SupabaseClient,
  memberId: string,
  groupId: string,
): Promise<{ id: string; display_name: string } | null> {
  const { data } = await db
    .from("members")
    .select("id, display_name")
    .eq("id", memberId)
    .eq("group_id", groupId)
    .maybeSingle();
  return data;
}

// ── Tool handlers ──────────────────────────────────────────────────────────

export async function createGroup(
  db: SupabaseClient,
  args: { name: string; display_name: string; currency?: string },
): Promise<ToolResult> {
  const { name, display_name, currency = "USD" } = args;

  if (!name?.trim()) return err("Group name is required");
  if (!display_name?.trim()) return err("Display name is required");

  const join_code = await uniqueJoinCode(db);

  const { data: group, error: gErr } = await db
    .from("groups")
    .insert({ name: name.trim(), join_code, currency })
    .select()
    .single();

  if (gErr) return err(`Failed to create group: ${gErr.message}`);

  const { data: member, error: mErr } = await db
    .from("members")
    .insert({ group_id: group.id, display_name: display_name.trim() })
    .select()
    .single();

  if (mErr) return err(`Failed to add you as member: ${mErr.message}`);

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
  db: SupabaseClient,
  args: { join_code: string; display_name?: string },
): Promise<ToolResult> {
  const { join_code, display_name } = args;

  if (!join_code?.trim()) return err("Join code is required");

  const code = join_code.trim().toUpperCase();

  const { data: group, error: gErr } = await db
    .from("groups")
    .select("id, name, currency")
    .eq("join_code", code)
    .maybeSingle();

  if (gErr || !group) return err(`No group found with join code ${code}`);

  const { data: allMembers } = await db
    .from("members")
    .select("id, display_name")
    .eq("group_id", group.id)
    .order("joined_at");

  const members = allMembers ?? [];

  // No display_name provided — return member list for user to pick from
  if (!display_name?.trim()) {
    return ok({
      group_id: group.id,
      group_name: group.name,
      currency: group.currency,
      pending: true,
      members,
      message: members.length > 0
        ? `Group "${group.name}" has these members: ${members.map((m) => m.display_name).join(", ")}. ` +
          `Are you one of them? Call claim_member with their member_id, or call join_group again with a display_name to join as someone new.`
        : `Group "${group.name}" has no members yet. Call join_group with a display_name to be the first.`,
    });
  }

  // Name matches an existing member — return their identity (works for rejoin too)
  const existing = members.find(
    (m) => m.display_name.toLowerCase() === display_name.trim().toLowerCase(),
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

  // New member
  const { data: member, error: mErr } = await db
    .from("members")
    .insert({ group_id: group.id, display_name: display_name.trim() })
    .select()
    .single();

  if (mErr) return err(`Failed to join group: ${mErr.message}`);

  const { data: updatedMembers } = await db
    .from("members")
    .select("id, display_name")
    .eq("group_id", group.id)
    .order("joined_at");

  return ok({
    group_id: group.id,
    group_name: group.name,
    currency: group.currency,
    member_id: member.id,
    display_name: member.display_name,
    members: updatedMembers ?? [],
    message: `Joined "${group.name}" as ${member.display_name}.`,
  });
}

export async function getGroup(
  db: SupabaseClient,
  args: { group_id: string },
): Promise<ToolResult> {
  const { group_id } = args;

  const { data: group, error } = await db
    .from("groups")
    .select("id, name, join_code, currency, created_at")
    .eq("id", group_id)
    .maybeSingle();

  if (error || !group) return err(`Group not found`);

  const { data: members } = await db
    .from("members")
    .select("id, display_name, joined_at")
    .eq("group_id", group_id)
    .order("joined_at");

  const { count } = await db
    .from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("group_id", group_id)
    .is("deleted_at", null);

  return ok({
    ...group,
    members: members ?? [],
    expense_count: count ?? 0,
  });
}

export async function addExpense(
  db: SupabaseClient,
  args: {
    group_id: string;
    member_id: string;
    paid_by: string;
    description: string;
    amount: number;
    currency?: string;
    split_type?: "equal" | "exact" | "percent";
    split_with?: string[];
    splits?: Array<{ member_id: string; amount?: number; percent?: number }>;
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

  // Verify requester is in group
  const requester = await assertMemberInGroup(db, member_id, group_id);
  if (!requester) return err("You are not a member of this group");

  // Verify payer is in group
  const payer = await assertMemberInGroup(db, paid_by, group_id);
  if (!payer) return err("The member who paid is not in this group");

  // Get all group members
  const { data: allMembers, error: mErr } = await db
    .from("members")
    .select("id, display_name")
    .eq("group_id", group_id);

  if (mErr || !allMembers) return err("Failed to fetch group members");

  const memberIdSet = new Set(allMembers.map((m) => m.id));

  // Determine participants
  let participants: string[];
  if (split_with && split_with.length > 0) {
    const invalid = split_with.find((id) => !memberIdSet.has(id));
    if (invalid) return err(`Member ${invalid} is not in this group`);
    participants = split_with;
  } else {
    participants = allMembers.map((m) => m.id);
  }

  if (participants.length === 0) return err("No participants for split");

  // Compute split amounts
  let splitMap: Map<string, number>;

  if (split_type === "equal") {
    splitMap = equalSplits(amount, participants);
  } else if (split_type === "exact") {
    if (!rawSplits?.length) return err("splits array required for exact split");
    splitMap = new Map(rawSplits.map((s) => [s.member_id, s.amount ?? 0]));
    const invalid = [...splitMap.keys()].find((id) => !memberIdSet.has(id));
    if (invalid) return err(`Member ${invalid} is not in this group`);
    const total = [...splitMap.values()].reduce((a, b) => a + b, 0);
    if (Math.abs(total - amount) > 0.01) {
      return err(
        `Split amounts sum to ${total.toFixed(2)} but expense total is ${amount.toFixed(2)}`,
      );
    }
  } else if (split_type === "percent") {
    if (!rawSplits?.length) {
      return err("splits array required for percent split");
    }
    const totalPct = rawSplits.reduce((a, s) => a + (s.percent ?? 0), 0);
    if (Math.abs(totalPct - 100) > 0.01) {
      return err(`Percentages sum to ${totalPct.toFixed(2)}%, must equal 100%`);
    }
    const invalid = rawSplits.find((s) => !memberIdSet.has(s.member_id));
    if (invalid) return err(`Member ${invalid.member_id} is not in this group`);

    // Convert percents to amounts in cents then back
    const amountCents = Math.round(amount * 100);
    const amounts = rawSplits.map((s) => ({
      member_id: s.member_id,
      cents: Math.round(amountCents * (s.percent ?? 0) / 100),
    }));
    // Adjust last item for rounding
    const sumCents = amounts.reduce((a, b) => a + b.cents, 0);
    amounts[amounts.length - 1].cents += amountCents - sumCents;
    splitMap = new Map(amounts.map((a) => [a.member_id, a.cents / 100]));
  } else {
    return err(`Unknown split_type: ${split_type}`);
  }

  const splitsPayload = [...splitMap.entries()].map(([mid, amt]) => ({
    member_id: mid,
    amount: amt,
  }));

  const { data: expenseId, error: eErr } = await db.rpc(
    "create_expense_with_splits",
    {
      p_group_id: group_id,
      p_paid_by: paid_by,
      p_created_by: member_id,
      p_description: description.trim(),
      p_amount: amount,
      p_currency: currency,
      p_receipt_note: receipt_note ?? null,
      p_splits: splitsPayload,
      p_original_amount: original_amount ?? null,
      p_original_currency: original_currency?.toUpperCase() ?? null,
      p_date: date ?? null,
    },
  );

  if (eErr) return err(`Failed to save expense: ${eErr.message}`);

  const nameMap = new Map(allMembers.map((m) => [m.id, m.display_name]));
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
      ? { original: { amount: original_amount, currency: original_currency.toUpperCase() } }
      : {}),
    message: original_amount && original_currency
      ? `Expense logged: "${description.trim()}" for ${original_currency.toUpperCase()} ${original_amount.toFixed(2)} → ${currency} ${amount.toFixed(2)}, paid by ${payer.display_name}`
      : `Expense logged: "${description.trim()}" for ${currency} ${amount.toFixed(2)}, paid by ${payer.display_name}`,
  });
}

export async function listExpenses(
  db: SupabaseClient,
  args: {
    group_id: string;
    limit?: number;
    offset?: number;
    paid_by?: string;
  },
): Promise<ToolResult> {
  const { group_id, limit = 20, offset = 0, paid_by } = args;

  let query = db
    .from("expenses")
    .select(
      "id, description, amount, currency, original_amount, original_currency, date, receipt_note, created_at, paid_by, created_by",
      { count: "exact" },
    )
    .eq("group_id", group_id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + Math.min(limit, 100) - 1);

  if (paid_by) query = query.eq("paid_by", paid_by);

  const { data: expenses, error, count } = await query;
  if (error) return err(`Failed to fetch expenses: ${error.message}`);

  if (!expenses?.length) {
    return ok({ expenses: [], total: 0, has_more: false });
  }

  // Fetch splits for these expenses
  const expenseIds = expenses.map((e) => e.id);
  const { data: splits } = await db
    .from("expense_splits")
    .select("expense_id, member_id, amount")
    .in("expense_id", expenseIds);

  // Fetch member names
  const { data: members } = await db
    .from("members")
    .select("id, display_name")
    .eq("group_id", group_id);

  const nameMap = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const splitsByExpense = new Map<
    string,
    Array<{ member: string; amount: number }>
  >();
  for (const s of splits ?? []) {
    if (!splitsByExpense.has(s.expense_id)) {
      splitsByExpense.set(s.expense_id, []);
    }
    splitsByExpense.get(s.expense_id)!.push({
      member: nameMap.get(s.member_id) ?? s.member_id,
      amount: parseFloat(s.amount),
    });
  }

  const result = expenses.map((e) => ({
    id: e.id,
    description: e.description,
    date: e.date,
    amount: parseFloat(e.amount),
    currency: e.currency,
    ...(e.original_amount
      ? { original: { amount: parseFloat(e.original_amount), currency: e.original_currency } }
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
    total: count ?? 0,
    has_more: offset + expenses.length < (count ?? 0),
  });
}

export async function deleteExpense(
  db: SupabaseClient,
  args: { expense_id: string; member_id: string },
): Promise<ToolResult> {
  const { expense_id, member_id } = args;

  const { data: expense, error } = await db
    .from("expenses")
    .select("id, description, created_by")
    .eq("id", expense_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !expense) return err("Expense not found");

  if (expense.created_by !== member_id) {
    return err("You can only delete expenses you logged");
  }

  const { error: delErr } = await db
    .from("expenses")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", expense_id);

  if (delErr) return err(`Failed to delete expense: ${delErr.message}`);

  return ok({
    deleted: true,
    expense_id,
    message: `Expense "${expense.description}" has been deleted`,
  });
}

export async function getBalances(
  db: SupabaseClient,
  args: { group_id: string },
): Promise<ToolResult> {
  const { group_id } = args;

  const { data: group } = await db
    .from("groups")
    .select("id, name, currency")
    .eq("id", group_id)
    .maybeSingle();

  if (!group) return err("Group not found");

  const { data: members } = await db
    .from("members")
    .select("id, display_name")
    .eq("group_id", group_id);

  const { data: expenseRows } = await db
    .from("expenses")
    .select("id, paid_by, amount")
    .eq("group_id", group_id)
    .eq("currency", group.currency)
    .is("deleted_at", null);

  const expenseIds = (expenseRows ?? []).map((e) => e.id);
  const { data: splitRows } =
    expenseIds.length > 0
      ? await db
          .from("expense_splits")
          .select("expense_id, member_id, amount")
          .in("expense_id", expenseIds)
      : { data: [] };

  const { data: settlementRows } = await db
    .from("settlements")
    .select("paid_by, paid_to, amount")
    .eq("group_id", group_id);

  const expenses = (expenseRows ?? []).map((e) => ({
    id: e.id,
    paid_by: e.paid_by,
    amount: parseFloat(e.amount),
    splits: (splitRows ?? [])
      .filter((s) => s.expense_id === e.id)
      .map((s) => ({ member_id: s.member_id, amount: parseFloat(s.amount) })),
  }));

  const settlements = (settlementRows ?? []).map((s) => ({
    paid_by: s.paid_by,
    paid_to: s.paid_to,
    amount: parseFloat(s.amount),
  }));

  const netBalances = computeNetBalances(
    members ?? [],
    expenses,
    settlements,
  );

  const suggestions = minimizeTransactions(netBalances);
  const isSettled = suggestions.length === 0;

  // Flag non-default-currency expenses
  const { count: foreignCount } = await db
    .from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("group_id", group_id)
    .neq("currency", group.currency)
    .is("deleted_at", null);

  return ok({
    group: { id: group.id, name: group.name, currency: group.currency },
    net_balances: netBalances,
    settlements_needed: suggestions,
    everyone_settled: isSettled,
    ...(foreignCount && foreignCount > 0
      ? {
          warning: `${foreignCount} expense(s) in non-${group.currency} currency excluded from balances`,
        }
      : {}),
  });
}

export async function recordSettlement(
  db: SupabaseClient,
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

  const { error } = await db.from("settlements").insert({
    group_id,
    paid_by,
    paid_to,
    amount,
    note: note ?? null,
  });

  if (error) return err(`Failed to record settlement: ${error.message}`);

  return ok({
    recorded: true,
    message: `Recorded: ${payer.display_name} paid ${payee.display_name} ${amount.toFixed(2)}`,
    paid_by: payer.display_name,
    paid_to: payee.display_name,
    amount,
  });
}

export async function getSettlementHistory(
  db: SupabaseClient,
  args: { group_id: string; limit?: number },
): Promise<ToolResult> {
  const { group_id, limit = 20 } = args;

  const { data: settlements, error } = await db
    .from("settlements")
    .select("id, paid_by, paid_to, amount, note, created_at")
    .eq("group_id", group_id)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 100));

  if (error) return err(`Failed to fetch settlements: ${error.message}`);

  if (!settlements?.length) return ok({ settlements: [] });

  const memberIds = [
    ...new Set(settlements.flatMap((s) => [s.paid_by, s.paid_to])),
  ];
  const { data: members } = await db
    .from("members")
    .select("id, display_name")
    .in("id", memberIds);

  const nameMap = new Map((members ?? []).map((m) => [m.id, m.display_name]));

  return ok({
    settlements: settlements.map((s) => ({
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
  db: SupabaseClient,
  args: { group_id: string; member_id: string; display_name: string },
): Promise<ToolResult> {
  const { group_id, member_id, display_name } = args;

  if (!display_name?.trim()) return err("Display name is required");

  const requester = await assertMemberInGroup(db, member_id, group_id);
  if (!requester) return err("You are not a member of this group");

  const { data: conflict } = await db
    .from("members")
    .select("id")
    .eq("group_id", group_id)
    .eq("display_name", display_name.trim())
    .maybeSingle();

  if (conflict) return err(`"${display_name}" is already a member of this group`);

  const { data: member, error } = await db
    .from("members")
    .insert({ group_id, display_name: display_name.trim() })
    .select()
    .single();

  if (error) return err(`Failed to add member: ${error.message}`);

  return ok({
    member_id: member.id,
    display_name: member.display_name,
    message: `${display_name} has been added. They can join using the group's join code and pick their name from the list.`,
  });
}

export async function claimMember(
  db: SupabaseClient,
  args: { member_id: string },
): Promise<ToolResult> {
  const { member_id } = args;

  const { data: member, error } = await db
    .from("members")
    .select("id, display_name, group_id")
    .eq("id", member_id)
    .maybeSingle();

  if (error || !member) return err("Member not found");

  const { data: group } = await db
    .from("groups")
    .select("id, name, currency")
    .eq("id", member.group_id)
    .maybeSingle();

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
  db: SupabaseClient,
  args: { group_id: string },
): Promise<ToolResult> {
  const { data: members, error } = await db
    .from("members")
    .select("id, display_name, joined_at")
    .eq("group_id", args.group_id)
    .order("joined_at");

  if (error) return err(`Failed to fetch members: ${error.message}`);

  return ok({ members: members ?? [] });
}

export async function getMember(
  db: SupabaseClient,
  args: { member_id: string },
): Promise<ToolResult> {
  const { member_id } = args;

  const { data: member, error } = await db
    .from("members")
    .select("id, display_name, joined_at, group_id")
    .eq("id", member_id)
    .maybeSingle();

  if (error || !member) return err("Member not found");

  const { data: group } = await db
    .from("groups")
    .select("id, name, join_code, currency")
    .eq("id", member.group_id)
    .maybeSingle();

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
  db: SupabaseClient,
  args: { member_id: string; display_name: string },
): Promise<ToolResult> {
  const { member_id, display_name } = args;

  if (!display_name?.trim()) return err("Display name is required");

  const { data: member } = await db
    .from("members")
    .select("id, group_id, display_name")
    .eq("id", member_id)
    .maybeSingle();

  if (!member) return err("Member not found");

  const { data: conflict } = await db
    .from("members")
    .select("id")
    .eq("group_id", member.group_id)
    .eq("display_name", display_name.trim())
    .neq("id", member_id)
    .maybeSingle();

  if (conflict) {
    return err(`Display name "${display_name}" is already taken in this group`);
  }

  const { error } = await db
    .from("members")
    .update({ display_name: display_name.trim() })
    .eq("id", member_id);

  if (error) return err(`Failed to rename: ${error.message}`);

  return ok({
    member_id,
    old_display_name: member.display_name,
    new_display_name: display_name.trim(),
    message: `Name changed from "${member.display_name}" to "${display_name.trim()}"`,
  });
}

export async function updateExpense(
  db: SupabaseClient,
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
    splits?: Array<{ member_id: string; amount?: number; percent?: number }>;
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

  // Validate original_amount/original_currency pairing
  if (
    (original_amount !== undefined) !== (original_currency !== undefined)
  ) {
    return err("original_amount and original_currency must be provided together");
  }

  // Fetch expense
  const { data: expense, error: fetchErr } = await db
    .from("expenses")
    .select("id, description, amount, currency, paid_by, created_by, group_id, date, receipt_note, original_amount, original_currency")
    .eq("id", expense_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (fetchErr || !expense) return err("Expense not found");

  // Auth check
  if (expense.created_by !== member_id) {
    return err("You can only update expenses you logged");
  }

  // Validate paid_by if provided
  if (paid_by) {
    const payer = await assertMemberInGroup(db, paid_by, expense.group_id);
    if (!payer) return err("The member who paid is not in this group");
  }

  const effectiveAmount = amount ?? parseFloat(expense.amount);

  // Determine if splits need recomputation
  const splitsExplicitlyProvided = split_with !== undefined || rawSplits !== undefined || split_type !== "equal";
  const amountChanged = amount !== undefined && amount !== parseFloat(expense.amount);
  const needSplitRecompute = splitsExplicitlyProvided || amountChanged;

  let splitsPayload: Array<{ member_id: string; amount: number }> | null = null;

  if (needSplitRecompute) {
    // Fetch group members
    const { data: allMembers, error: mErr } = await db
      .from("members")
      .select("id, display_name")
      .eq("group_id", expense.group_id);

    if (mErr || !allMembers) return err("Failed to fetch group members");

    const memberIdSet = new Set(allMembers.map((m) => m.id));

    if (splitsExplicitlyProvided) {
      // Recompute from provided split params
      let participants: string[];
      if (split_with && split_with.length > 0) {
        const invalid = split_with.find((id) => !memberIdSet.has(id));
        if (invalid) return err(`Member ${invalid} is not in this group`);
        participants = split_with;
      } else {
        participants = allMembers.map((m) => m.id);
      }

      if (participants.length === 0) return err("No participants for split");

      let splitMap: Map<string, number>;

      if (split_type === "equal") {
        splitMap = equalSplits(effectiveAmount, participants);
      } else if (split_type === "exact") {
        if (!rawSplits?.length) return err("splits array required for exact split");
        splitMap = new Map(rawSplits.map((s) => [s.member_id, s.amount ?? 0]));
        const invalid = [...splitMap.keys()].find((id) => !memberIdSet.has(id));
        if (invalid) return err(`Member ${invalid} is not in this group`);
        const total = [...splitMap.values()].reduce((a, b) => a + b, 0);
        if (Math.abs(total - effectiveAmount) > 0.01) {
          return err(
            `Split amounts sum to ${total.toFixed(2)} but expense total is ${effectiveAmount.toFixed(2)}`,
          );
        }
      } else if (split_type === "percent") {
        if (!rawSplits?.length) return err("splits array required for percent split");
        const totalPct = rawSplits.reduce((a, s) => a + (s.percent ?? 0), 0);
        if (Math.abs(totalPct - 100) > 0.01) {
          return err(`Percentages sum to ${totalPct.toFixed(2)}%, must equal 100%`);
        }
        const invalid = rawSplits.find((s) => !memberIdSet.has(s.member_id));
        if (invalid) return err(`Member ${invalid.member_id} is not in this group`);

        const amountCents = Math.round(effectiveAmount * 100);
        const amounts = rawSplits.map((s) => ({
          member_id: s.member_id,
          cents: Math.round(amountCents * (s.percent ?? 0) / 100),
        }));
        const sumCents = amounts.reduce((a, b) => a + b.cents, 0);
        amounts[amounts.length - 1].cents += amountCents - sumCents;
        splitMap = new Map(amounts.map((a) => [a.member_id, a.cents / 100]));
      } else {
        return err(`Unknown split_type: ${split_type}`);
      }

      splitsPayload = [...splitMap.entries()].map(([mid, amt]) => ({
        member_id: mid,
        amount: amt,
      }));
    } else {
      // Only amount changed — re-split equally among existing participants
      const { data: existingSplits } = await db
        .from("expense_splits")
        .select("member_id")
        .eq("expense_id", expense_id);

      const existingParticipants = (existingSplits ?? []).map((s) => s.member_id);
      if (existingParticipants.length === 0) return err("No existing participants found");

      const splitMap = equalSplits(effectiveAmount, existingParticipants);
      splitsPayload = [...splitMap.entries()].map(([mid, amt]) => ({
        member_id: mid,
        amount: amt,
      }));
    }
  }

  // Call RPC
  const { data: updatedId, error: rpcErr } = await db.rpc(
    "update_expense_with_splits",
    {
      p_expense_id: expense_id,
      p_description: description ?? null,
      p_amount: amount ?? null,
      p_currency: currency ?? null,
      p_paid_by: paid_by ?? null,
      p_date: date ?? null,
      p_receipt_note: receipt_note ?? null,
      p_original_amount: original_amount ?? null,
      p_original_currency: original_currency?.toUpperCase() ?? null,
      p_clear_original: false,
      p_splits: splitsPayload !== null ? splitsPayload : null,
    },
  );

  if (rpcErr) return err(`Failed to update expense: ${rpcErr.message}`);

  // Fetch updated expense for response
  const { data: updated } = await db
    .from("expenses")
    .select("id, description, amount, currency, paid_by, date, receipt_note, original_amount, original_currency")
    .eq("id", updatedId)
    .maybeSingle();

  // Fetch paid_by display name
  const { data: payerMember } = await db
    .from("members")
    .select("id, display_name")
    .eq("id", updated?.paid_by ?? expense.paid_by)
    .maybeSingle();

  // Fetch splits for response
  const { data: finalSplits } = await db
    .from("expense_splits")
    .select("member_id, amount")
    .eq("expense_id", expense_id);

  const { data: splitMembers } = await db
    .from("members")
    .select("id, display_name")
    .in("id", (finalSplits ?? []).map((s) => s.member_id));

  const nameMap = new Map((splitMembers ?? []).map((m) => [m.id, m.display_name]));
  const splitSummary = (finalSplits ?? []).map((s) => ({
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
      ? { original: { amount: parseFloat(finalOrigAmount), currency: finalOrigCurrency } }
      : {}),
    message: `Expense updated: "${updated?.description}"`,
  });
}

// ── Dispatch ───────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Args = Record<string, any>;

export async function handleToolCall(
  db: SupabaseClient,
  name: string,
  args: Args,
): Promise<ToolResult> {
  switch (name) {
    case "create_group":
      return createGroup(db, args);
    case "join_group":
      return joinGroup(db, args);
    case "get_group":
      return getGroup(db, args);
    case "add_expense":
      return addExpense(db, args);
    case "list_expenses":
      return listExpenses(db, args);
    case "delete_expense":
      return deleteExpense(db, args);
    case "update_expense":
      return updateExpense(db, args);
    case "get_balances":
      return getBalances(db, args);
    case "record_settlement":
      return recordSettlement(db, args);
    case "get_settlement_history":
      return getSettlementHistory(db, args);
    case "add_member":
      return addMember(db, args);
    case "claim_member":
      return claimMember(db, args);
    case "list_members":
      return listMembers(db, args);
    case "get_member":
      return getMember(db, args);
    case "rename_member":
      return renameMember(db, args);
    default:
      return err(`Unknown tool: ${name}`);
  }
}
