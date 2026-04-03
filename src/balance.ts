export interface NetBalance {
  member_id: string;
  display_name: string;
  net: number; // positive = owed money, negative = owes money
}

export interface SettlementSuggestion {
  from_id: string;
  from: string;
  to_id: string;
  to: string;
  amount: number;
}

export function computeNetBalances(
  members: Array<{ id: string; display_name: string }>,
  expenses: Array<{
    id: string;
    paid_by: string;
    amount: number;
    splits: Array<{ member_id: string; amount: number }>;
  }>,
  settlements: Array<{ paid_by: string; paid_to: string; amount: number }>,
): NetBalance[] {
  const net = new Map<string, number>();
  for (const m of members) net.set(m.id, 0);

  for (const e of expenses) {
    net.set(e.paid_by, (net.get(e.paid_by) ?? 0) + e.amount);
    for (const s of e.splits) {
      net.set(s.member_id, (net.get(s.member_id) ?? 0) - s.amount);
    }
  }

  for (const s of settlements) {
    net.set(s.paid_by, (net.get(s.paid_by) ?? 0) + s.amount);
    net.set(s.paid_to, (net.get(s.paid_to) ?? 0) - s.amount);
  }

  const nameMap = new Map(members.map((m) => [m.id, m.display_name]));
  return [...net.entries()].map(([member_id, rawNet]) => ({
    member_id,
    display_name: nameMap.get(member_id) ?? "Unknown",
    net: round2(rawNet),
  }));
}

/** Minimize transactions using greedy creditor/debtor matching. */
export function minimizeTransactions(
  netBalances: NetBalance[],
): SettlementSuggestion[] {
  const EPSILON = 0.005; // half a cent

  const creditors = netBalances
    .filter((b) => b.net > EPSILON)
    .map((b) => ({ id: b.member_id, name: b.display_name, amount: b.net }))
    .sort((a, b) => b.amount - a.amount);

  const debtors = netBalances
    .filter((b) => b.net < -EPSILON)
    .map((b) => ({ id: b.member_id, name: b.display_name, amount: -b.net }))
    .sort((a, b) => b.amount - a.amount);

  const transactions: SettlementSuggestion[] = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const credit = creditors[ci];
    const debt = debtors[di];
    const amount = round2(Math.min(credit.amount, debt.amount));

    transactions.push({
      from_id: debt.id,
      from: debt.name,
      to_id: credit.id,
      to: credit.name,
      amount,
    });

    credit.amount = round2(credit.amount - amount);
    debt.amount = round2(debt.amount - amount);

    if (credit.amount < EPSILON) ci++;
    if (debt.amount < EPSILON) di++;
  }

  return transactions;
}

/** Split amount equally in cents, distributing remainder to first N members. */
export function equalSplits(
  amount: number,
  memberIds: string[],
): Map<string, number> {
  const totalCents = Math.round(amount * 100);
  const n = memberIds.length;
  const baseCents = Math.floor(totalCents / n);
  const remainder = totalCents - baseCents * n;

  const splits = new Map<string, number>();
  memberIds.forEach((id, i) => {
    splits.set(id, (baseCents + (i < remainder ? 1 : 0)) / 100);
  });
  return splits;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
