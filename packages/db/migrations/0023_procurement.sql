-- 0023_procurement
-- Purchase orders to vendors and the receiving of what arrives. A purchase order buys product for stock-free,
-- job-driven work: it can point at a project, a sales order and/or a ticket so the vendor cost lands with the job.
-- Nothing here sends anything to a vendor or to QuickBooks; "ordered" only records that the order was placed.
-- Receipts record what physically arrived, line by line, with optional serial numbers; receiving more than was
-- ordered is refused so the books and the dock agree. Vendor bills (accounts payable) stay in QuickBooks.

CREATE SCHEMA procurement;

CREATE SEQUENCE procurement.po_number_seq START 1001;

CREATE TABLE procurement.purchase_order (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_number         text NOT NULL UNIQUE DEFAULT ('PO-' || nextval('procurement.po_number_seq')),
  vendor_company_id bigint NOT NULL REFERENCES crm.company (id),
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'ordered', 'partial', 'received', 'closed', 'canceled')),
  project_id        bigint REFERENCES project.project (id),
  sales_order_id    bigint REFERENCES sales.sales_order (id),
  ticket_id         bigint REFERENCES service.ticket (id),
  vendor_reference  text,                                   -- the vendor's own order or quote number
  ship_to           text,
  expected_date     date,
  ordered_at        timestamptz,
  shipping_cost     numeric(14,2) NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
  notes             text,
  created_by_member_id bigint REFERENCES iam.member (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT po_ordered_has_date CHECK ((status = 'draft' OR status = 'canceled') OR ordered_at IS NOT NULL)
);
CREATE INDEX purchase_order_vendor_idx ON procurement.purchase_order (vendor_company_id);
CREATE INDEX purchase_order_project_idx ON procurement.purchase_order (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX purchase_order_sales_order_idx ON procurement.purchase_order (sales_order_id) WHERE sales_order_id IS NOT NULL;
CREATE INDEX purchase_order_ticket_idx ON procurement.purchase_order (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX purchase_order_open_idx ON procurement.purchase_order (status) WHERE status IN ('ordered', 'partial');
SELECT sys.attach_standard_triggers('procurement.purchase_order');

CREATE TABLE procurement.purchase_order_line (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id       bigint NOT NULL REFERENCES procurement.purchase_order (id) ON DELETE CASCADE,
  product_id  bigint REFERENCES catalog.product (id),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  quantity    numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost   numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_order_line_po_idx ON procurement.purchase_order_line (po_id, sort_order, id);
SELECT sys.attach_standard_triggers('procurement.purchase_order_line');

CREATE TABLE procurement.receipt (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id       bigint NOT NULL REFERENCES procurement.purchase_order (id),
  received_on date NOT NULL DEFAULT current_date,
  reference   text,                                          -- packing slip or tracking number
  notes       text,
  received_by_member_id bigint REFERENCES iam.member (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipt_po_idx ON procurement.receipt (po_id);
SELECT sys.attach_standard_triggers('procurement.receipt');

CREATE TABLE procurement.receipt_line (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id  bigint NOT NULL REFERENCES procurement.receipt (id) ON DELETE CASCADE,
  po_line_id  bigint NOT NULL REFERENCES procurement.purchase_order_line (id),
  quantity    numeric(12,3) NOT NULL CHECK (quantity > 0),
  serial_numbers text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipt_line_receipt_idx ON procurement.receipt_line (receipt_id);
CREATE INDEX receipt_line_po_line_idx ON procurement.receipt_line (po_line_id);
SELECT sys.attach_standard_triggers('procurement.receipt_line');
