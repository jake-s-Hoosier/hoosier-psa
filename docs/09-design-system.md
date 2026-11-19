# 09. Design system

The goal is a clean, modern, fast interface that people who live in it all day enjoy. It is not a
reproduction of ConnectWise's layout or vocabulary.

## Principles

1. **Speed over ornament.** Dense but calm; keyboard-first; no modal when a panel will do.
2. **One obvious next action.** Every screen has a primary action; destructive actions are never primary.
3. **Show state, not chrome.** Status, ownership, SLA and money are visible at a glance; borders and
   shadows stay quiet.
4. **Consistency through tokens.** No raw colours, spacing or radii in components; everything comes from
   the tokens in `apps/web/src/styles.css`.
5. **Mobile is a first-class client for technicians**: touch targets of at least 44px, single-column
   layouts, offline-tolerant timers.

## Tokens

Defined as CSS custom properties: colour (`--color-bg`, `--color-surface`, `--color-border`, `--color-text`,
`--color-text-muted`, `--color-accent`, `--color-danger`, navigation colours), spacing scale
(`--space-1` to `--space-6`), radius, shadow and typography. Dark mode adds a second set of values
under `[data-theme="dark"]` without changing component code.

## Layout

- Persistent left navigation (collapsible), top bar with global search and the current user.
- Lists: sticky header, search and filter toolbar above, saved views, inline row actions, keyboard navigation.
- Detail screens: summary header with key facts and status, tabs for related records, a right-hand activity
  and notes panel.
- Global command palette (`Ctrl/Cmd+K`) to jump to companies, tickets and actions.

## Components (built as needed, in this order)

Button, input, select, combobox with async search, date and time pickers, data table with column
control, status badge, tabs, side panel, toast, confirm dialog, empty state, skeleton loader,
timer widget (always visible while running), schedule board.

## Accessibility

Target **WCAG 2.1 AA**: 4.5:1 text contrast, visible focus rings, full keyboard operation, labelled
controls, `aria-current` on navigation, announcements for async results, no information conveyed by
colour alone. The web shell already follows these (focus-visible styles, labelled search, semantic
table markup).

## Content style

Plain, specific language ("Ticket 18423 closed", not "Operation successful"). Money always formatted
through `formatUsd`; dates in the viewer's time zone with the company time zone shown where it differs.
Empty and error states say what happened and what to do next.
