/** Who the invoice is from. Set INVOICE_SELLER_* in the environment to change it. */
export interface Seller {
  name: string;
  lines: string[];
  /** Printed under the totals, e.g. where to send checks. Empty when not configured. */
  remitNote: string;
}

export function sellerFromEnv(env: NodeJS.ProcessEnv = process.env): Seller {
  const lines = (env.INVOICE_SELLER_ADDRESS ?? "7828 E 88th Street|Indianapolis, IN 46256")
    .split("|")
    .map((l) => l.trim())
    .filter(Boolean);
  if (env.INVOICE_SELLER_PHONE?.trim()) lines.push(env.INVOICE_SELLER_PHONE.trim());
  return {
    name: env.INVOICE_SELLER_NAME?.trim() || "Hoosier Security",
    lines,
    remitNote: env.INVOICE_REMIT_NOTE?.trim() ?? "",
  };
}
