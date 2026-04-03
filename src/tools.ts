export const TOOLS = [
  {
    name: "create_group",
    description:
      "Create a new expense-splitting group. Returns a 6-character join code to share with others and your member_id — save both.",
    inputSchema: {
      type: "object",
      required: ["name", "display_name"],
      properties: {
        name: {
          type: "string",
          description: "Human-readable group name (e.g. 'Cabo Trip 2026')",
        },
        display_name: {
          type: "string",
          description: "Your display name in this group",
        },
        currency: {
          type: "string",
          default: "USD",
          description: "ISO 4217 currency code (default: USD)",
        },
      },
    },
  },
  {
    name: "join_group",
    description:
      "Join a group using its 6-character join code. Call without display_name first — it returns the existing member list so the user can pick who they are or choose to join as someone new. Then either call claim_member to pick an existing member, or call join_group again with a display_name to create a new one.",
    inputSchema: {
      type: "object",
      required: ["join_code"],
      properties: {
        join_code: {
          type: "string",
          description: "6-character group join code (case-insensitive)",
        },
        display_name: {
          type: "string",
          description:
            "Provide this to create a new member. Omit on first call to see who's already in the group.",
        },
      },
    },
  },
  {
    name: "get_group",
    description: "Get group details, member list, and a balance summary.",
    inputSchema: {
      type: "object",
      required: ["group_id"],
      properties: {
        group_id: { type: "string", description: "Group UUID" },
      },
    },
  },
  {
    name: "add_expense",
    description:
      "Log a new expense. Supports equal splits, exact amounts, or percentages. To log from a receipt photo, read the image yourself, then call this with the extracted details.",
    inputSchema: {
      type: "object",
      required: ["group_id", "member_id", "paid_by", "description", "amount"],
      properties: {
        group_id: { type: "string", description: "Group UUID" },
        member_id: {
          type: "string",
          description: "Your member_id (who is logging this expense)",
        },
        paid_by: {
          type: "string",
          description: "member_id of who actually paid",
        },
        description: { type: "string", description: "What was the expense" },
        amount: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Total amount paid",
        },
        currency: {
          type: "string",
          default: "USD",
          description: "ISO 4217 currency code",
        },
        split_type: {
          type: "string",
          enum: ["equal", "exact", "percent"],
          default: "equal",
          description:
            "How to split: equal (default), exact amounts, or percentages",
        },
        split_with: {
          type: "array",
          items: { type: "string" },
          description:
            "member_ids to split among. If omitted, splits among all group members.",
        },
        splits: {
          type: "array",
          description:
            "Required for exact/percent. Array of { member_id, amount } or { member_id, percent }",
          items: {
            type: "object",
            properties: {
              member_id: { type: "string" },
              amount: { type: "number" },
              percent: { type: "number" },
            },
          },
        },
        date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description:
            "Date of the expense in YYYY-MM-DD format. Defaults to today if omitted. Use this for past expenses (e.g. logging a receipt from last week).",
        },
        receipt_note: {
          type: "string",
          description:
            "Summary of the receipt (e.g. 'Whole Foods receipt: milk, eggs, bread')",
        },
        original_amount: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "The amount in the original foreign currency, before conversion. Provide together with original_currency.",
        },
        original_currency: {
          type: "string",
          description:
            "ISO 4217 code of the original currency (e.g. 'EUR'). When provided, `amount` must be the converted value in the group's currency and `currency` must match the group's currency.",
        },
      },
    },
  },
  {
    name: "list_expenses",
    description: "List expenses for a group with split details.",
    inputSchema: {
      type: "object",
      required: ["group_id"],
      properties: {
        group_id: { type: "string", description: "Group UUID" },
        limit: {
          type: "integer",
          default: 20,
          maximum: 100,
          description: "Number of expenses to return",
        },
        offset: {
          type: "integer",
          default: 0,
          description: "Pagination offset",
        },
        paid_by: {
          type: "string",
          description: "Filter to expenses paid by this member_id",
        },
      },
    },
  },
  {
    name: "delete_expense",
    description:
      "Delete an expense. Only the member who logged it can delete it.",
    inputSchema: {
      type: "object",
      required: ["expense_id", "member_id"],
      properties: {
        expense_id: { type: "string", description: "Expense UUID" },
        member_id: { type: "string", description: "Your member_id" },
      },
    },
  },
  {
    name: "update_expense",
    description:
      "Update an existing expense. Only the member who logged it can update it. Changing amount without providing new splits re-splits equally among existing participants.",
    inputSchema: {
      type: "object",
      required: ["expense_id", "member_id"],
      properties: {
        expense_id: { type: "string", description: "Expense UUID to update" },
        member_id: {
          type: "string",
          description:
            "Your member_id (must be the member who logged the expense)",
        },
        description: { type: "string", description: "New description" },
        amount: {
          type: "number",
          exclusiveMinimum: 0,
          description: "New total amount",
        },
        currency: {
          type: "string",
          description: "ISO 4217 currency code",
        },
        paid_by: {
          type: "string",
          description: "member_id of who actually paid",
        },
        date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Date of the expense in YYYY-MM-DD format",
        },
        receipt_note: {
          type: "string",
          description: "Updated receipt summary",
        },
        original_amount: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Amount in the original foreign currency. Must be paired with original_currency.",
        },
        original_currency: {
          type: "string",
          description:
            "ISO 4217 code of the original currency. Must be paired with original_amount.",
        },
        split_type: {
          type: "string",
          enum: ["equal", "exact", "percent"],
          description: "How to split: equal, exact amounts, or percentages",
        },
        split_with: {
          type: "array",
          items: { type: "string" },
          description:
            "member_ids to split among (replaces existing participants)",
        },
        splits: {
          type: "array",
          description:
            "Required for exact/percent. Array of { member_id, amount } or { member_id, percent }",
          items: {
            type: "object",
            properties: {
              member_id: { type: "string" },
              amount: { type: "number" },
              percent: { type: "number" },
            },
          },
        },
      },
    },
  },
  {
    name: "get_balances",
    description:
      "Calculate current balances for all members. Shows net balances and the minimum set of payments needed to settle up.",
    inputSchema: {
      type: "object",
      required: ["group_id"],
      properties: {
        group_id: { type: "string", description: "Group UUID" },
      },
    },
  },
  {
    name: "record_settlement",
    description:
      "Record that one member paid another to settle a debt. Partial payments are allowed.",
    inputSchema: {
      type: "object",
      required: ["group_id", "paid_by", "paid_to", "amount"],
      properties: {
        group_id: { type: "string", description: "Group UUID" },
        paid_by: {
          type: "string",
          description: "member_id of who paid",
        },
        paid_to: {
          type: "string",
          description: "member_id of who received the payment",
        },
        amount: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Amount paid",
        },
        note: { type: "string", description: "Optional note" },
      },
    },
  },
  {
    name: "get_settlement_history",
    description: "View past settlements for a group.",
    inputSchema: {
      type: "object",
      required: ["group_id"],
      properties: {
        group_id: { type: "string", description: "Group UUID" },
        limit: { type: "integer", default: 20, maximum: 100 },
      },
    },
  },
  {
    name: "add_member",
    description:
      "Pre-add a member to the group by display name before they join. They will appear in the list when someone uses join_group, and can claim the slot as their own.",
    inputSchema: {
      type: "object",
      required: ["group_id", "member_id", "display_name"],
      properties: {
        group_id: { type: "string", description: "Group UUID" },
        member_id: {
          type: "string",
          description:
            "Your member_id (must be an existing member of the group)",
        },
        display_name: {
          type: "string",
          description: "Display name for the new member",
        },
      },
    },
  },
  {
    name: "claim_member",
    description:
      "Identify as an existing member of a group. Use this after join_group returns a member list and the user picks which one they are. No credentials required — just the member_id.",
    inputSchema: {
      type: "object",
      required: ["member_id"],
      properties: {
        member_id: {
          type: "string",
          description: "The member_id of the pre-added slot to claim",
        },
      },
    },
  },
  {
    name: "list_members",
    description:
      "List all members in a group with their IDs and display names. Call this before add_expense when you need to look up a member by name to fill in paid_by or split_with.",
    inputSchema: {
      type: "object",
      required: ["group_id"],
      properties: {
        group_id: { type: "string", description: "Group UUID" },
      },
    },
  },
  {
    name: "get_member",
    description:
      "Look up your member info by member_id. Useful to confirm your identity or get your group_id.",
    inputSchema: {
      type: "object",
      required: ["member_id"],
      properties: {
        member_id: { type: "string", description: "Your member UUID" },
      },
    },
  },
  {
    name: "rename_member",
    description: "Change your display name within a group.",
    inputSchema: {
      type: "object",
      required: ["member_id", "display_name"],
      properties: {
        member_id: { type: "string", description: "Your member UUID" },
        display_name: { type: "string", description: "New display name" },
      },
    },
  },
];
