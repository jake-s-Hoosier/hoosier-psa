export const msg = (e: unknown) => (e instanceof Error ? e.message : "Request failed");

export const fullName = (c: { firstName: string; lastName: string | null }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ");

export const hours = (n: number) => `${n.toFixed(2).replace(/\.?0+$/, "")} h`;

export const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";

export const addressLine = (s: {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}) =>
  [s.addressLine1, [s.city, s.state].filter(Boolean).join(", "), s.postalCode]
    .filter(Boolean)
    .join(" · ");

export const usd = (n: number | string) =>
  Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
