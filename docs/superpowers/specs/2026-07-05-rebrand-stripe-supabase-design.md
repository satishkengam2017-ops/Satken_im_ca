# Rebrand, Stripe migration, and Supabase re-point — Design

## Goal
Rebrand SATKEN's color scheme, switch pricing/payment from Razorpay (INR) to Stripe (USD), and re-point the app at a new Supabase project.

## 1. Visual theme
Replace the dark purple/gold theme with a cream/golden-brown theme. The theme is driven by CSS custom properties in `index.html`'s `:root`, so most of the change is redefining those variables:

- `--bg-deep` / `--bg-mid` / `--bg-black` → cream gradient stops (`#F7ECD3`, `#EFDFB8`, `#E8D5A3` or similar), used by the existing `radial-gradient` background
- `--gold` / `--gold-light` / `--gold-dark` → golden-brown accent tones (`#8B5E34`, `#A9793F`, `#6B4423`)
- `--text` → dark golden-brown (`#5C3A21`) for body text on the light background
- `--muted`, `--border`, `--border-soft`, `--gold-glow`, `--input-bg`, `--input-border*` → recomputed from the new accent so contrast holds on cream
- `--surface` → light translucent cream (`rgba(255,250,240,0.7)`) instead of translucent purple
- Status colors (`--green`, `--warn`, `--red`) stay, but will be checked for contrast against cream

Any hardcoded (non-variable) colors that assumed a dark background — e.g. `.nav-bar { background: rgba(26,10,46,0.9); }` — get audited and swapped to a cream-toned equivalent. Box-shadows using `rgba(0,0,0,x)` stay as-is (they still work as drop shadows on a light background).

## 2. Pricing copy
Both pricing displays (`index.html` — the landing pricing block and the trial-gate screen) change from:
`₹2999 → ₹999/year` to `$299 → $99/year`

The backend amount passed to the payment gateway changes from `99900` (paise) to `9900` (cents, USD).

## 3. Stripe replaces Razorpay
Razorpay is fully removed, not run alongside Stripe.

- **`netlify/functions/create-payment-link.js` → `create-checkout-session.js`**: keeps the existing auth-header + org-membership check (fetch against Supabase REST with the caller's JWT), then creates a Stripe Checkout Session via a direct `fetch` to `https://api.stripe.com/v1/checkout/sessions` (form-encoded, per Stripe's REST API) — no `stripe` npm package, keeping the project's zero-dependency style. Line item: `amount=9900`, `currency=usd`, one-year subscription framed as a single payment (matches existing "annual payment link" model, not recurring Stripe Subscriptions). `metadata[org_id]` carries the org id. Success URL: `https://satken-im.netlify.app/?stripe_session_id={CHECKOUT_SESSION_ID}`. Returns `{ url: session.url }`.
- **`netlify/functions/razorpay-webhook.js` → `stripe-webhook.js`**: verifies the `Stripe-Signature` header manually (parse `t=` and `v1=` from the header, compute `HMAC-SHA256(STRIPE_WEBHOOK_SECRET, t + "." + rawBody)`, compare to `v1`), listens for `checkout.session.completed`, reads `metadata.org_id`, and PATCHes `organizations.subscription_status` to `active` with `current_period_ends_at` one year out — same Supabase service-role update as today.
- **`auth.js`**: `handleSubscribe()` now posts to `/.netlify/functions/create-checkout-session` and redirects to `data.url`. `checkPostPaymentRedirect()` checks for `stripe_session_id` in the query string instead of `razorpay_payment_id`. `pollForActivation` logic is unchanged.
- **Netlify env vars** (set by the user, not committed): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` replace `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`.

## 4. Supabase re-point
- `auth.js` line 1-2: `SUPABASE_URL` → `https://gkhayphmzopttyasclww.supabase.co`, `SUPABASE_ANON_KEY` → the provided anon key.
- Netlify env vars `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` must be updated by the user to match the new project (used server-side by the netlify functions).
- The new project's schema hasn't been created yet. User needs to run `migration_step1.sql`, `migration_step2.sql`, `migration_step3.sql` (in that order) via the Supabase SQL Editor before auth/data will work.

## Out of scope
- No Stripe Subscriptions/recurring billing — mirrors the existing one-shot "annual payment" model.
- No visual mockup step — palette applied directly via CSS variables, user can request tweaks after seeing it live.
- No data migration from the old Supabase project (new project starts empty).

## Testing
Manual verification only (static HTML/JS app, no test suite): load the page locally, confirm theme renders, confirm pricing shows $299 → $99/year, confirm signup/login round-trips against the new Supabase project, confirm the Checkout Session function returns a valid URL structure (can't fully test webhook activation without live Stripe keys — documented as a follow-up manual step for the user after deploy).
