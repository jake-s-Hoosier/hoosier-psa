# 10. Payments and autopay

Specification for milestone 5. Providers: **Stripe**, **WisePay** and **Global Payments**. The design
assumes no provider-specific capability that has not been verified; the first task is to obtain each
provider's API documentation and sandbox credentials and fill the capability table below.

## Provider abstraction

```ts
interface PaymentProvider {
  readonly id: "stripe" | "wisepay" | "global_payments";
  readonly capabilities: { card: boolean; ach: boolean; storedCredentials: boolean;
                           hostedFields: boolean; webhooks: boolean; refunds: boolean };

  /** Create a provider customer and return its id. */
  ensureCustomer(company: CompanyRef): Promise<string>;
  /** Start a hosted flow that returns a token for a new payment method. */
  createSetupSession(customerId: string, returnUrl: string): Promise<SetupSession>;
  /** Charge a stored method. Must be idempotent for a given idempotencyKey. */
  charge(req: ChargeRequest): Promise<ChargeResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
  /** Verify a webhook signature and normalise the event. */
  parseWebhook(headers: Headers, rawBody: Buffer): Promise<NormalizedEvent>;
  /** Settlement and fee detail used for deposit reconciliation. */
  getSettlement(ref: string): Promise<SettlementDetail>;
}
```

Everything above the interface (autopay scheduling, retries, ledger, receipts, accounting export) is
provider-neutral and tested against a fake provider. Each real provider is an adapter plus a recorded-fixture contract test.

## Capability table (to complete from vendor documentation)

| Capability | Stripe | WisePay | Global Payments |
|---|---|---|---|
| Card payments | to verify | to verify | to verify |
| ACH / bank debit | to verify | to verify | to verify |
| Hosted fields or hosted page (keeps SAQ A) | to verify | to verify | to verify |
| Stored credentials / customer vault | to verify | to verify | to verify |
| Webhooks with signatures | to verify | to verify | to verify |
| Fee and settlement reporting API | to verify | to verify | to verify |

## As built: manual payments

Migration 0016 implements the ledger without any provider: `payments.payment` (customer, date received, method, reference,
amount, fee, status posted or void) and `payments.payment_application` (payment, invoice, amount). One payment can pay
several invoices and a payment larger than the invoice balance keeps the rest as credit on the customer, to be applied
later. An invoice's `amount_paid` and status follow its applications from live (not void) payments. The database refuses
a payer that is not the invoice's customer, an invoice that is not posted or part paid, and any application beyond the
payment or the balance; the API checks the same things first so the message names the invoice. Voiding a payment keeps it
on record and reopens what it paid. Card numbers are never stored. Provider fields (`provider`, `provider_reference`) are
in place for Stripe and the others to fill later.

## Data model *(planned)*

- `payments.payment_method`: company, provider, provider customer id, **token**, kind (card/ach), brand,
  last four, expiry, status, default flag. No card numbers, ever ([08](08-security.md)).
- `payments.autopay_enrolment`: company, payment method, scope (all invoices, agreements only, or specific
  agreements), authorisation evidence (who, when, from where, the agreement text version), status, optional
  maximum amount per charge.
- `payments.payment`: invoice, method, provider, provider reference, **gross, fee, net**, status
  (`pending`, `succeeded`, `failed`, `refunded`, `disputed`), failure code, idempotency key, timestamps.
- `payments.payment_application`: how a payment is spread across invoices (supports partial and combined payments).
- `payments.provider_event`: every webhook received, signature result, processing outcome (replay-safe).

## Autopay

1. A customer authorises autopay through the portal or a staff-assisted hosted flow; the authorisation text
   and metadata are stored with the enrolment (required for card-on-file and ACH rules).
2. When an invoice is posted for an enrolled company, a charge is scheduled for the invoice due date
   (configurable: on posting, on due date, or N days before).
3. The worker claims due charges, calls the provider with an idempotency key derived from
   `(invoice, attempt)`, and records the outcome. Success creates a payment application and queues the accounting export.
4. Failure follows a **retry schedule** (for example day +3 and +7), notifies the billing contact each time,
   and after the last failure pauses the enrolment and creates a task for billing.
5. Amount changes above the enrolment maximum, expired methods and disputed charges stop automation
   and notify a person.

## Webhooks

Every provider event is stored raw, verified, then processed idempotently by provider event id. A payment
is never marked succeeded from the browser return URL, only from a verified provider event or a
synchronous API result.

## Reconciliation and fees

Each payment records gross, fee and net. Settlement reports (where the provider offers them) are imported
daily and matched to deposits, closing the gap where merchant fees currently disappear into net bank
deposits. The accounting export posts the fee as an expense line against the payment.

## Compliance notes

- Card data is handled only by provider-hosted fields or pages (SAQ A scope).
- Surcharging or convenience fees are subject to card-network and state rules; decide with legal advice before offering them.
- ACH debits require written authorisation and return handling (R-codes); the enrolment captures the authorisation.
