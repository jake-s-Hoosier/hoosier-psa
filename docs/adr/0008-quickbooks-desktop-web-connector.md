# 0008. QuickBooks Desktop integration via Web Connector

Status: Proposed (pending the milestone 2 verification spike)
Date: 2026-11-19

## Context
QuickBooks Desktop (on its own server) has no cloud API. The PSA must create customers and invoices (later credit
memos and payments) in QuickBooks reliably, without duplicates, and reproduce ConnectWise's existing mapping.

## Decision (proposed)
Use the QuickBooks Web Connector: a Windows service beside QuickBooks that polls a SOAP endpoint we host and
exchanges QBXML. Posted documents go into a database export queue; the endpoint serves queue items in order,
records `TxnID` and `EditSequence`, and turns rejections into tasks for billing. Before any add, query by
reference number and adopt an existing transaction instead of duplicating. A daily reconciliation compares PSA
invoices with the `qb_invoices` rows the existing nightly ETL already syncs.

## Consequences
- Works with the installed product and Intuit-supported tooling; no screen scraping.
- The endpoint is a new internet-reachable surface and needs strict access control ([08](../08-security.md)).
- The Web Connector requires QuickBooks to be able to open the company file (the Windows session and QuickBooks
  must be available when it runs); operational runbook needed.
- Throughput is modest, which is fine for Hoosier's volume.

## To verify in the spike
1. Installed QuickBooks Desktop version and Web Connector compatibility.
2. How CW currently maps customer, item, income account, class and tax code (derive from 34k historical invoices).
3. Required handling for closed accounting periods, inactive customers/items and sales-tax setup.
4. Whether to retain CW's export path in parallel until parity is proven.

## Alternatives considered
- **IIF file import.** Simple but limited and unreliable for updates; no response data.
- **Direct QuickBooks SDK / COM.** Tighter coupling and Windows-only in-process dependencies on the application server.
- **Moving to QuickBooks Online first.** A business decision outside this project; the adapter interface keeps the option open.
