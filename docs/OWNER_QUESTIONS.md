# Questions For The Shop Owner

Everything in the app is already built. What's left is not code — it's a few real-world
things only you can provide (like a website address) and a few money/legal decisions only
you (or your CA / accountant) can make. This file is a fill-in-the-blank form. Answer what
you can, leave the rest blank, and send it back — nothing here needs you to know anything
about computers.

**How to fill this in:** just type your answer after the `→` on each line. If you don't know
something, write `not sure` or leave it empty and move on — skip whole sections if you want,
they're independent of each other.

---

## Section 1 — Give your shop's app a real address on the internet

Right now the app only works on the shop's own computer (`localhost`). To let it work from
anywhere (your phone, a second branch, customers checking their bill online), it needs two
things: a **domain** (a web address like `mysore-jewellers.com`) and a **VPS** (a small rented
computer that stays on 24/7 and answers requests at that address — think of it like renting a
tiny always-on computer in a data centre, for maybe ₹400–1500/month).

**Steps to get these (about 20 minutes):**

1. Buy a domain name. Go to a site like Namecheap, GoDaddy, or Hostinger, search your shop's
   name, and buy the `.com` or `.in` one that's available. Costs roughly ₹500–1200/year.
2. Rent a VPS. Go to a site like DigitalOcean, Hetzner, or AWS Lightsail, sign up, and create
   the cheapest/smallest Ubuntu server (22.04 or newer). They will email you an IP address
   (four numbers like `139.59.12.44`) and a way to log in (usually a root password, or a file
   called an "SSH key" — either is fine, just keep whatever they give you).
3. Come back here and fill in:

- Domain name (e.g. `mysore-jewellers.com`) → 
- VPS provider (e.g. DigitalOcean) → 
- VPS IP address (the four numbers) → 
- How you log into the VPS (password, or an SSH key file) → 
- Do you want separate addresses for testing vs the real live shop (e.g.
  `test.mysore-jewellers.com` and `app.mysore-jewellers.com`), or just one live address? → 

*(Not ready yet? That's fine — everything still works fine on the shop's own computer in the
meantime. This only matters once you want it reachable from outside the shop.)*

---

## Section 2 — A safety copy of your data, kept somewhere else

The app already keeps daily backups on the shop's own computer, and they're locked
(encrypted) so a stolen backup file is useless to whoever took it. But if the shop's computer
is stolen, catches fire, or is destroyed, those backups go with it. You need **one more copy
kept in a different physical place** — this is standard practice, the same reason people keep
a photocopy of important documents at a relative's house.

**Simplest options (pick one):**

- **A cloud storage account** (easiest) — a service like Backblaze, Google Drive, or Dropbox
  where the backup file quietly uploads itself every night. Usually free or a few hundred
  rupees a month for the storage this needs.
- **A second location you already have** — e.g. an external hard drive kept at your house or
  a second branch, plugged in weekly to copy the latest backup onto it.

Fill in:

- Which option do you want? → 
- If cloud storage: which service, and do you already have an account? (if yes, just the
  service name is enough for now — never write passwords in this file) → 
- If a physical second location: where, and who will plug in the drive each week? → 

*(This one only needs a decision now — I'll wire up the actual copying once you tell me
which option.)*

---

## Section 3 — Ask your CA / accountant these questions

These features are fully built and sitting ready, switched **off**, waiting on real numbers
instead of placeholder ones. None of this is a computer question — it's what your accountant
or a jeweller's association would already know. Ask them, then fill in what they say.

### 3a. How many years must you legally keep billing/audit records?

Indian tax and company law sets a minimum number of years shops must retain records. The app
currently guesses **7 years** as a safe placeholder.

- What does your CA say the real number should be? → ______ years

### 3b. How do you currently charge customers for "wastage" (gold lost while making jewellery)?

The app supports three ways shops commonly do this — ask which one matches how you already
bill, or how you want to:

- **A)** Add a bit of extra weight on top of the item's actual weight, and charge for that too
- **B)** Charge it as a percentage on top of the making charge
- **C)** Show it as its own separate line on the bill, with its own amount

Fill in:

- Which method (A, B, or C)? → 
- What percentage do you currently charge? → ______ %

### 3c. Old gold exchange — is 5% the right deduction?

When a customer brings old gold jewellery to exchange/sell, the app currently guesses a
**5% deduction** (for melting loss, purity re-testing, etc.) before valuing it. Is that the
number you actually use, or something else?

- Correct deduction percentage → ______ %

### 3d. Gold savings scheme terms (only fill in if you plan to offer one)

If customers pay a fixed amount monthly and get a free installment or bonus at the end
(a common Indian jewellery-shop scheme), the app has this fully built with placeholder terms
below. These need your accountant/lawyer to confirm before it's legally safe to advertise and
sell — ask them, then correct anything below:

- Number of installments before maturity (placeholder: 11) → 
- Free/bonus installments added at the end (placeholder: 1, i.e. "11+1") → 
- Grace period in days if a customer misses a payment (placeholder: 30) → 
- Penalty % if a customer closes early (placeholder: 0%) → 
- Do you want to offer this scheme at all right now, or leave it off? → 

### 3e. Management reports — who should be allowed to see them?

The app has four reports ready (daily settlement, reconciliation, profit margins, and how
long stock has been sitting unsold). These reveal your profit margins, so before turning them
on:

- Should only you (the owner) see them, or can senior staff/managers see them too? → 
- OK to turn all four on together, or start with just one? (if just one, which) → 

---

## Section 4 — Buying stock from suppliers / moving stock between branches (optional)

This one has **not been built yet** — it needs you to first decide how it should work, since
different shops track this differently. No rush on this section; skip it if you're not ready.

If you do want it, answer these in plain words (however you'd explain it to a new employee):

- When you buy gold/jewellery from a supplier, what should the app record? (just the
  weight/amount added to stock, or also the supplier's name, invoice number, payment terms?) → 
- If you have more than one branch, when stock moves from one to another, should that need
  someone to approve it, or just be logged automatically? → 
- Anything else about how purchases or transfers should work at your shop? → 

---

## What happens after you answer

Whatever you fill in, I'll use as real settings instead of placeholders — for the infra
sections (1 and 2) I'll set up the actual connection and prove it works; for the CA-reviewed
numbers (section 3) I'll plug in the real figures and switch the matching feature on; section
4 I'll only start building once there's an answer to build from. Anything you leave blank
just stays off/placeholder, exactly as it is today — nothing breaks either way.
