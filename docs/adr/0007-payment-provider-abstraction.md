# 0007. Payment provider abstraction and tokenisation

Status: Accepted
Date: 2026-11-19

## Context
Autopay must work with Stripe, WisePay and Global Payments, now or later, and providers may change. Handling
card data directly would put the application and server in broad PCI scope.

## Decision
- Define a provider-neutral `PaymentProvider` interface ([10](../10-payments-and-autopay.md)); autopay scheduling,
  retries, ledger, receipts and accounting export are written once above it and tested with a fake provider.
- **Tokenise at the provider.** Card and bank details are entered only in provider-hosted fields or pages. The
  database stores tokens and display metadata, never primary account numbers.
- Record gross, fee and net on every payment, and store every webhook raw for audit and replay.
- Outcomes are driven by verified provider events or synchronous API results, never by browser redirects.
- Each provider adapter ships with recorded-fixture contract tests.

## Consequences
- SAQ A scope; a leaked database cannot yield usable card numbers.
- Adding or replacing a provider is an adapter, not a rewrite.
- Provider feature gaps (for example no stored credentials, no ACH) are visible as capability flags and
  handled by the layer above or by excluding that provider for that use.
- WisePay and Global Payments capabilities are unverified; the first task of milestone 5 is to confirm them.

## Alternatives considered
- **Integrate one provider directly.** Fastest, but locks billing logic to its shapes.
- **Store encrypted card data ourselves.** Rejected: large compliance burden and risk for no benefit.
