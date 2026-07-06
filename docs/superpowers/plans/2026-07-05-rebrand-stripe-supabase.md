# Rebrand, Stripe Migration, and Supabase Re-point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recolor SATKEN to a cream/golden-brown theme, change pricing from ₹999/year to $99/year, replace Razorpay with Stripe as the payment gateway, and re-point the app at a new Supabase project.

**Architecture:** This is a single-page static app (`index.html` + `auth.js` + `app.js`) backed by two Netlify serverless functions (`netlify/functions/*.js`) that talk to Supabase (REST API) and the payment gateway via plain `fetch` — no npm dependencies, no build step. Changes are: (1) CSS custom-property and literal-color edits in `index.html`, (2) copy edits in `index.html`, (3) two rewritten Netlify functions replacing the Razorpay ones, (4) small `auth.js` edits to point at the new functions/Supabase project.

**Tech Stack:** Vanilla HTML/CSS/JS, Netlify Functions (Node.js, CommonJS, zero dependencies), Supabase (Postgres + Auth REST API), Stripe REST API (Checkout Sessions).

## Global Constraints

- No new npm dependencies. Netlify functions stay plain Node (`fetch`, `crypto`, `Buffer` — no `stripe` or `@supabase/supabase-js` packages), matching the existing zero-install pattern.
- Razorpay is fully removed — not run alongside Stripe.
- Secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`) are read from `process.env` only, never hardcoded or committed.
- The Supabase anon/public key IS safe to hardcode client-side in `auth.js` (it already is today — that's how Supabase's client-side auth model works).
- All commits authored as `satishkumarkengam-cpu <kengam4s@gmail.com>` (matches existing repo history), pushed to `origin` = `https://github.com/satishkengam2017-ops/Satken_im_ca.git`, branch `main`.
- Repo root for all paths below: the working copy already checked out locally (contains `index.html`, `auth.js`, `app.js`, `netlify/`, `netlify.toml`, `migration_step1-3.sql`).

---

### Task 1: Rebrand theme — cream background, golden-brown text

**Files:**
- Modify: `index.html:10-24` (`:root` CSS custom properties)
- Modify: `index.html` (global literal-color sweep across the `<style>` block, lines 8-355)

**Interfaces:**
- Produces: new color values for `--bg-deep`, `--bg-mid`, `--bg-black`, `--surface`, `--border`, `--border-soft`, `--gold`, `--gold-light`, `--gold-dark`, `--gold-glow`, `--text`, `--muted`, `--dim`, `--blue`, `--input-bg`, `--input-border`, `--input-border-focus`. Later tasks (2, and any future styling) should assume these are the new brand colors.

This task is a full dark-purple/gold → cream/golden-brown palette swap. Because the stylesheet is almost entirely driven by CSS custom properties, most of the work is a handful of exact string replacements. Do them in this exact order.

- [ ] **Step 1: Replace the three literal values that have no matching global pattern**

Using the Edit tool (or equivalent exact string replacement), apply these three replacements in `index.html`. Each `old_string` below is unique in the file — verify uniqueness before editing if your tool doesn't error on ambiguity.

Replacement 1 — `--surface` (translucent card background, dark purple → translucent cream):
```
OLD: --surface: rgba(45,16,84,0.7);
NEW: --surface: rgba(255,250,240,0.75);
```

Replacement 2 — `--text` and `--dim` (leave `--muted` untouched here, it's fixed by the global sweep in Step 2):
```
OLD: --text: #F5E6C8; --muted: rgba(201,168,76,0.6); --dim: rgba(255,255,255,0.3);
NEW: --text: #5C3A21; --muted: rgba(201,168,76,0.6); --dim: rgba(92,58,33,0.35);
```

Replacement 3 — `--input-bg` (dark input fill → light input fill; leave `--input-border`/`--input-border-focus` untouched here, fixed by Step 2):
```
OLD: --input-bg: rgba(0,0,0,0.3); --input-border: rgba(201,168,76,0.2); --input-border-focus: rgba(201,168,76,0.6);
NEW: --input-bg: rgba(255,255,255,0.55); --input-border: rgba(201,168,76,0.2); --input-border-focus: rgba(201,168,76,0.6);
```

- [ ] **Step 2: Run the global literal-color sweep**

These hex/rgb triples appear identically in both the `:root` variable definitions and in literal (non-`var()`) uses elsewhere in the stylesheet (button gradients, borders, glows). Running one global find-and-replace per pattern fixes both at once. Run from the repo root:

```bash
F="index.html"
sed -i 's/201,168,76/139,94,52/g' "$F"   # old gold rgb -> new golden-brown rgb (28 occurrences)
sed -i 's/26,10,46/255,248,231/g' "$F"   # nav-bar/tab-bar dark overlay -> light cream (2 occurrences)
sed -i 's/#C9A84C/#8B5E34/g' "$F"        # --gold / --blue / button gradients (5 occurrences)
sed -i 's/#E8C96A/#A9793F/g' "$F"        # --gold-light / button gradients (4 occurrences)
sed -i 's/#A8872A/#6B4423/g' "$F"        # --gold-dark / button gradients (4 occurrences)
sed -i 's/#1A0A2E/#FFF8E7/g' "$F"        # --bg-deep / button text color (4 occurrences)
sed -i 's/#7A5F1E/#4A2E17/g' "$F"        # button bottom-shadow color (9 occurrences)
sed -i 's/#2D1054/#FFFDF5/g' "$F"        # --bg-mid (1 occurrence)
sed -i 's/#0D0518/#E8D5A3/g' "$F"        # --bg-black (1 occurrence)
```

- [ ] **Step 3: Verify the sweep worked and nothing old is left**

```bash
grep -c "201,168,76\|26,10,46\|#C9A84C\|#E8C96A\|#A8872A\|#1A0A2E\|#7A5F1E\|#2D1054\|#0D0518" index.html
```
Expected: `0` (grep exits with no matches / prints nothing — if your grep prints a count of matching lines rather than erroring, expect `0`).

- [ ] **Step 4: Fix the one spot where reusing `--bg-deep` would break contrast**

`#sound-banner button` uses `color:var(--bg-deep)` for dark text on its orange (`--warn`) background. Since `--bg-deep` is now light cream, that text would become nearly invisible. Point it at `--text` (dark golden-brown) instead:

```
OLD: #sound-banner button { margin-left:auto;background:var(--warn);color:var(--bg-deep);border:none;border-radius:8px;padding:6px 12px;font-family:'Cinzel',serif;font-size:14px;font-weight:700;letter-spacing:0.5px;cursor:pointer;white-space:nowrap;box-shadow:0 3px 0 #A16B2E,0 5px 8px rgba(0,0,0,0.3);transition:transform 0.12s ease,box-shadow 0.12s ease;transform:translateY(0); }
NEW: #sound-banner button { margin-left:auto;background:var(--warn);color:var(--text);border:none;border-radius:8px;padding:6px 12px;font-family:'Cinzel',serif;font-size:14px;font-weight:700;letter-spacing:0.5px;cursor:pointer;white-space:nowrap;box-shadow:0 3px 0 #A16B2E,0 5px 8px rgba(0,0,0,0.3);transition:transform 0.12s ease,box-shadow 0.12s ease;transform:translateY(0); }
```

- [ ] **Step 5: Fix the four remaining "white-on-dark" literal colors that assumed a dark surface**

These four rgba values were tuned for a dark-mode surface (white tints, or a black chip background) and need to flip for a light cream surface. Apply all four:

```
OLD: .header-pill { font-family:'JetBrains Mono',monospace; font-size:16px; color: var(--gold); background: rgba(0,0,0,0.3); padding: 4px 10px; border-radius: 20px; border: 1px solid var(--input-border); white-space:nowrap; }
NEW: .header-pill { font-family:'JetBrains Mono',monospace; font-size:16px; color: var(--gold); background: rgba(139,94,52,0.12); padding: 4px 10px; border-radius: 20px; border: 1px solid var(--input-border); white-space:nowrap; }
```

```
OLD: .manual-input::placeholder { color:rgba(245,230,200,0.35); }
NEW: .manual-input::placeholder { color:rgba(92,58,33,0.4); }
```

```
OLD: .scan-count.once { background:rgba(255,255,255,0.05);color:var(--dim); }
NEW: .scan-count.once { background:rgba(0,0,0,0.05);color:var(--dim); }
```

```
OLD: .reason-badge.notscanned { background:rgba(255,255,255,0.06);color:var(--dim); }
NEW: .reason-badge.notscanned { background:rgba(0,0,0,0.06);color:var(--dim); }
```

```
OLD: .resolve-icon { flex-shrink:0;width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,0.25);border:1px solid var(--border-soft);color:var(--gold);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 0 rgba(0,0,0,0.35),0 5px 8px rgba(0,0,0,0.25);transition:transform 0.12s ease,box-shadow 0.12s ease;transform:translateY(0); }
NEW: .resolve-icon { flex-shrink:0;width:36px;height:36px;border-radius:50%;background:rgba(139,94,52,0.15);border:1px solid var(--border-soft);color:var(--gold);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 0 rgba(0,0,0,0.35),0 5px 8px rgba(0,0,0,0.25);transition:transform 0.12s ease,box-shadow 0.12s ease;transform:translateY(0); }
```

- [ ] **Step 6: Sanity-check the final `:root` block**

```bash
sed -n '10,24p' index.html
```
Expected output:
```
    --bg-deep: #FFF8E7; --bg-mid: #FFFDF5; --bg-black: #E8D5A3;
    --surface: rgba(255,250,240,0.75);
    --border: rgba(139,94,52,0.35);
    --border-soft: rgba(139,94,52,0.15);
    --gold: #8B5E34; --gold-light: #A9793F; --gold-dark: #6B4423;
    --gold-glow: rgba(139,94,52,0.25);
    --text: #5C3A21; --muted: rgba(139,94,52,0.6); --dim: rgba(92,58,33,0.35);
    --green: #6DBE8C; --green-light: rgba(109,190,140,0.15);
    --warn: #E8A04A; --warn-light: rgba(232,160,74,0.15);
    --red: #E85A6A; --red-light: rgba(232,90,106,0.15);
    --blue: #8B5E34;
    --input-bg: rgba(255,255,255,0.55); --input-border: rgba(139,94,52,0.2); --input-border-focus: rgba(139,94,52,0.6);
    --card-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(139,94,52,0.2);
```

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "Rebrand theme: cream background, golden-brown text"
```

---

### Task 2: Pricing copy — $99/year (was $299)

**Files:**
- Modify: `index.html:397`, `index.html:467`, `index.html:485`

**Interfaces:**
- Consumes: none.
- Produces: none (pure copy change; the Stripe function in Task 4 independently hardcodes `unit_amount=9900`, matching this $99 display).

- [ ] **Step 1: Update the landing-page pricing block**

```
OLD:       <div class="price-row"><span class="price-old">₹2999</span><span class="price-new">₹999</span><span class="price-period">/year</span></div>
NEW:       <div class="price-row"><span class="price-old">$299</span><span class="price-new">$99</span><span class="price-period">/year</span></div>
```

- [ ] **Step 2: Update the trial-gate screen pricing block**

```
OLD:       <div class="price-row" style="margin-bottom:16px"><span class="price-old">₹2999</span><span class="price-new">₹999</span><span class="price-period">/year</span></div>
NEW:       <div class="price-row" style="margin-bottom:16px"><span class="price-old">$299</span><span class="price-new">$99</span><span class="price-period">/year</span></div>
```

- [ ] **Step 3: Update the nav-bar upgrade badge label**

```
OLD:         <span class="btn-label">Upgrade — ₹999/year</span>
NEW:         <span class="btn-label">Upgrade — $99/year</span>
```

- [ ] **Step 4: Verify no old currency text remains**

```bash
grep -n "₹" index.html
```
Expected: no output (no matches).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Update pricing to \$99/year (was \$299)"
```

---

### Task 3: Point the client at the new Supabase project

**Files:**
- Modify: `auth.js:1-2`

**Interfaces:**
- Consumes: none.
- Produces: `SUPABASE_URL` and `SUPABASE_ANON_KEY` globals used by `sb` (the Supabase client) at `auth.js:3` and throughout `app.js`.

- [ ] **Step 1: Update the Supabase URL and anon key**

```
OLD: var SUPABASE_URL='https://lpjdurwfiidrztinjzyn.supabase.co';
var SUPABASE_ANON_KEY='sb_publishable_C88ixlj-EhwMHCxf3hmHuA_XmKsJthQ';
NEW: var SUPABASE_URL='https://gkhayphmzopttyasclww.supabase.co';
var SUPABASE_ANON_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdraGF5cGhtem9wdHR5YXNjbHd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzMDQxNjgsImV4cCI6MjA5ODg4MDE2OH0.dcrcYJG3eLQL9bM_1K-1y4F-8C7ebxBHhURzevaeaFE';
```

- [ ] **Step 2: Verify**

```bash
sed -n '1,3p' auth.js
```
Expected: the three lines show the new URL, the new anon key, and the unchanged `sb=supabase.createClient(...)` line.

- [ ] **Step 3: Commit**

```bash
git add auth.js
git commit -m "Point client at new Supabase project"
```

- [ ] **Step 4: Note for the user (not a code step)**

This only updates the client-side key. The user still needs to, on their own:
1. Run `migration_step1.sql`, then `migration_step2.sql`, then `migration_step3.sql` (in that order) in the new Supabase project's SQL Editor.
2. Update the `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` environment variables in the Netlify dashboard to match the new project (these are read by the Netlify functions server-side and are separate from the values hardcoded in `auth.js`).

---

### Task 4: Stripe Checkout Session function (replaces Razorpay payment link)

**Files:**
- Create: `netlify/functions/create-checkout-session.js`
- Delete: `netlify/functions/create-payment-link.js`

**Interfaces:**
- Consumes: `process.env.SUPABASE_URL`, `process.env.SUPABASE_ANON_KEY`, `process.env.STRIPE_SECRET_KEY` (all set in Netlify's dashboard, not in code).
- Produces: HTTP endpoint `/.netlify/functions/create-checkout-session` — `POST` body `{orgId: string}`, header `Authorization: Bearer <supabase JWT>` — returns `{url: string}` on success (200), or `{error: string}` on failure (400/401/403/405/502). Task 6 (`auth.js`) consumes this exact response shape. The Stripe Checkout Session is created with `metadata.org_id = orgId`, which Task 5's webhook reads back.

- [ ] **Step 1: Delete the old Razorpay function**

```bash
git rm netlify/functions/create-payment-link.js
```

- [ ] **Step 2: Create the Stripe Checkout Session function**

Create `netlify/functions/create-checkout-session.js`:

```javascript
// Creates a Stripe Checkout Session for a store's $99/year subscription.
// Uses plain fetch against Stripe's REST API (no `stripe` npm package) and
// against Supabase's REST API (no @supabase/supabase-js dependency) so the
// function has zero npm install step to fail at deploy time.

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({error:'method not allowed'}) };
  }

  var authHeader = event.headers.authorization || event.headers.Authorization;
  if(!authHeader){
    return { statusCode: 401, body: JSON.stringify({error:'missing auth header'}) };
  }
  var jwt = authHeader.replace('Bearer ','');

  var body;
  try{ body = JSON.parse(event.body || '{}'); }
  catch(e){ return { statusCode: 400, body: JSON.stringify({error:'invalid JSON body'}) }; }

  var orgId = body.orgId;
  if(!orgId){
    return { statusCode: 400, body: JSON.stringify({error:'orgId required'}) };
  }

  // Verify the caller actually belongs to this org — existing RLS on
  // org_members enforces this naturally when queried with the caller's
  // own JWT, so a non-member simply gets an empty result here.
  var membershipResp;
  try{
    membershipResp = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/org_members?select=org_id,organizations(name)&org_id=eq.' + encodeURIComponent(orgId),
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + jwt
        }
      }
    );
  }catch(e){
    return { statusCode: 502, body: JSON.stringify({error:'could not reach Supabase'}) };
  }

  var membershipRows = await membershipResp.json();
  if(!membershipResp.ok || !Array.isArray(membershipRows) || membershipRows.length === 0){
    return { statusCode: 403, body: JSON.stringify({error:'not a member of this org'}) };
  }

  var orgName = (membershipRows[0].organizations && membershipRows[0].organizations.name) || 'your store';

  var params = new URLSearchParams();
  params.append('mode','payment');
  params.append('success_url','https://satken-im.netlify.app/?stripe_session_id={CHECKOUT_SESSION_ID}');
  params.append('cancel_url','https://satken-im.netlify.app/');
  params.append('line_items[0][quantity]','1');
  params.append('line_items[0][price_data][currency]','usd');
  params.append('line_items[0][price_data][unit_amount]','9900');
  params.append('line_items[0][price_data][product_data][name]','SATKEN annual subscription — ' + orgName);
  params.append('metadata[org_id]', orgId);

  var stripeResp;
  try{
    stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
  }catch(e){
    return { statusCode: 502, body: JSON.stringify({error:'could not reach Stripe'}) };
  }

  var stripeData = await stripeResp.json();
  if(!stripeResp.ok){
    return { statusCode: 502, body: JSON.stringify({error:'stripe error', detail: stripeData}) };
  }

  return { statusCode: 200, body: JSON.stringify({ url: stripeData.url }) };
};
```

- [ ] **Step 3: Syntax-check**

```bash
node --check netlify/functions/create-checkout-session.js
```
Expected: no output, exit code 0.

- [ ] **Step 4: Dry-run the request-shape logic with a stubbed `fetch`**

There's no live Stripe key available in dev, so verify the function builds the right request shape and handles both the membership-check and Stripe-call paths without a network call. Create a throwaway script (do not commit it), run it, then delete it:

```bash
cat > ./tmp_verify_checkout.js <<'EOF'
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_123';

var calls = [];
global.fetch = async function(url, opts){
  calls.push({url: url, opts: opts});
  if(url.indexOf('supabase') !== -1){
    return { ok: true, json: async () => ([{org_id:'org1', organizations:{name:'Test Store'}}]) };
  }
  return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/pay/cs_test_123' }) };
};

var handler = require('./netlify/functions/create-checkout-session.js').handler;

handler({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer fake-jwt' },
  body: JSON.stringify({orgId: 'org1'})
}).then(function(result){
  var assert = require('assert');
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(JSON.parse(result.body).url, 'https://checkout.stripe.com/pay/cs_test_123');
  var stripeCall = calls[1];
  assert.ok(stripeCall.opts.body.indexOf('metadata%5Border_id%5D=org1') !== -1, 'metadata.org_id missing from Stripe request body');
  assert.ok(stripeCall.opts.body.indexOf('unit_amount%5D=9900') !== -1, 'unit_amount is not 9900');
  console.log('create-checkout-session dry run passed');
});
EOF
node ./tmp_verify_checkout.js
rm ./tmp_verify_checkout.js
```
Expected: prints `create-checkout-session dry run passed` with no assertion errors.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/create-checkout-session.js
git commit -m "Replace Razorpay payment link with Stripe Checkout Session"
```

---

### Task 5: Stripe webhook function (replaces Razorpay webhook)

**Files:**
- Create: `netlify/functions/stripe-webhook.js`
- Create: `netlify/functions/stripe-webhook.test.js`
- Delete: `netlify/functions/razorpay-webhook.js`

**Interfaces:**
- Consumes: `process.env.STRIPE_WEBHOOK_SECRET`, `process.env.SUPABASE_URL`, `process.env.SUPABASE_SERVICE_ROLE_KEY` (Netlify env vars). Reads `metadata.org_id` produced by Task 4's Checkout Session.
- Produces: HTTP endpoint `/.netlify/functions/stripe-webhook` for Stripe's webhook delivery, and an exported pure function `verifyStripeSignature(rawBody, signatureHeader, secret) -> boolean` used by the test file.

- [ ] **Step 1: Delete the old Razorpay webhook**

```bash
git rm netlify/functions/razorpay-webhook.js
```

- [ ] **Step 2: Write the failing test first**

Create `netlify/functions/stripe-webhook.test.js`:

```javascript
// Plain Node script (no test framework) verifying the signature-checking
// logic in stripe-webhook.js. Run with: node netlify/functions/stripe-webhook.test.js
var assert = require('assert');
var crypto = require('crypto');
var { verifyStripeSignature } = require('./stripe-webhook.js');

var secret = 'whsec_test_secret';
var rawBody = JSON.stringify({hello:'world'});
var timestamp = '1700000000';
var validSig = crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');

assert.strictEqual(
  verifyStripeSignature(rawBody, 't=' + timestamp + ',v1=' + validSig, secret),
  true,
  'valid signature should verify'
);

assert.strictEqual(
  verifyStripeSignature(rawBody, 't=' + timestamp + ',v1=' + '0'.repeat(64), secret),
  false,
  'tampered signature should fail'
);

assert.strictEqual(
  verifyStripeSignature(rawBody, undefined, secret),
  false,
  'missing signature header should fail'
);

console.log('stripe-webhook signature tests passed');
```

- [ ] **Step 3: Run it to verify it fails**

```bash
node netlify/functions/stripe-webhook.test.js
```
Expected: `Error: Cannot find module './stripe-webhook.js'` (the module doesn't exist yet).

- [ ] **Step 4: Create the Stripe webhook function**

Create `netlify/functions/stripe-webhook.js`:

```javascript
// Receives Stripe's checkout.session.completed webhook, verifies its
// signature, and flips the paying org's subscription_status to 'active'
// using the Supabase service role key (bypasses RLS — never exposed
// client-side). Uses plain fetch/crypto (Node built-ins) — no npm
// dependency to install.

var crypto = require('crypto');

function verifyStripeSignature(rawBody, signatureHeader, secret){
  if(!signatureHeader) return false;
  var parts = signatureHeader.split(',').reduce(function(acc, part){
    var kv = part.split('=');
    acc[kv[0]] = kv[1];
    return acc;
  }, {});
  if(!parts.t || !parts.v1) return false;

  var expected = crypto
    .createHmac('sha256', secret)
    .update(parts.t + '.' + rawBody)
    .digest('hex');

  var expectedBuf = Buffer.from(expected, 'utf8');
  var actualBuf = Buffer.from(parts.v1, 'utf8');
  if(expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({error:'method not allowed'}) };
  }

  var signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  var rawBody = event.body; // must verify against the RAW string, not a parsed/re-serialized copy

  if(!verifyStripeSignature(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)){
    return { statusCode: 400, body: JSON.stringify({error:'invalid signature'}) };
  }

  var payload;
  try{ payload = JSON.parse(rawBody); }
  catch(e){ return { statusCode: 400, body: JSON.stringify({error:'invalid JSON body'}) }; }

  // Only act on a successfully completed Checkout Session.
  if(payload.type !== 'checkout.session.completed'){
    return { statusCode: 200, body: JSON.stringify({ignored:true}) };
  }

  var orgId = payload.data && payload.data.object && payload.data.object.metadata && payload.data.object.metadata.org_id;

  if(!orgId){
    return { statusCode: 400, body: JSON.stringify({error:'no org_id found in webhook payload'}) };
  }

  var oneYearFromNow = new Date();
  oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);

  var updateResp;
  try{
    updateResp = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/organizations?id=eq.' + encodeURIComponent(orgId),
      {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          subscription_status: 'active',
          current_period_ends_at: oneYearFromNow.toISOString()
        })
      }
    );
  }catch(e){
    return { statusCode: 502, body: JSON.stringify({error:'could not reach Supabase'}) };
  }

  if(!updateResp.ok){
    var errText = await updateResp.text();
    return { statusCode: 500, body: JSON.stringify({error:'failed to update organization', detail: errText}) };
  }

  return { statusCode: 200, body: JSON.stringify({ok:true}) };
};

module.exports.verifyStripeSignature = verifyStripeSignature;
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
node netlify/functions/stripe-webhook.test.js
```
Expected: `stripe-webhook signature tests passed`

- [ ] **Step 6: Syntax-check the handler file itself**

```bash
node --check netlify/functions/stripe-webhook.js
```
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/stripe-webhook.js netlify/functions/stripe-webhook.test.js
git commit -m "Replace Razorpay webhook with Stripe webhook handler"
```

---

### Task 6: Wire `auth.js` billing flow to Stripe

**Files:**
- Modify: `auth.js:234` (comment), `auth.js:254` (endpoint call), `auth.js:269` (redirect field), `auth.js:298` (post-payment param check)

**Interfaces:**
- Consumes: `create-checkout-session` response shape `{url: string}` from Task 4; `stripe_session_id` query param convention from Task 4's `success_url`.
- Produces: none (leaf of the dependency chain).

- [ ] **Step 1: Update the section comment**

```
OLD: /* ── BILLING (Razorpay) ── */
NEW: /* ── BILLING (Stripe) ── */
```

- [ ] **Step 2: Point `handleSubscribe` at the new function and response field**

```
OLD:     var resp=await fetch('/.netlify/functions/create-payment-link',{
      method:'POST',
      headers:{
        'Authorization':'Bearer '+session.access_token,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({orgId:currentOrgId})
    });
    var data=await resp.json();
    if(!resp.ok){
      alert('Could not start payment: '+(data.error||'unknown error'));
      btnEl.disabled=false;
      setBtnLabel(btnEl,originalText);
      return;
    }
    window.location.href=data.short_url;
NEW:     var resp=await fetch('/.netlify/functions/create-checkout-session',{
      method:'POST',
      headers:{
        'Authorization':'Bearer '+session.access_token,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({orgId:currentOrgId})
    });
    var data=await resp.json();
    if(!resp.ok){
      alert('Could not start payment: '+(data.error||'unknown error'));
      btnEl.disabled=false;
      setBtnLabel(btnEl,originalText);
      return;
    }
    window.location.href=data.url;
```

- [ ] **Step 3: Update the post-payment redirect check**

```
OLD:   if(params.has('razorpay_payment_id')){
NEW:   if(params.has('stripe_session_id')){
```

- [ ] **Step 4: Verify no Razorpay references remain in `auth.js`**

```bash
grep -in razorpay auth.js
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add auth.js
git commit -m "Wire billing flow to Stripe endpoints"
```

---

### Task 7: End-to-end manual verification and push

**Files:** none (verification only)

- [ ] **Step 1: Confirm no Razorpay references remain anywhere in the repo**

```bash
grep -rin razorpay --include=*.html --include=*.js --exclude-dir=vendor .
```
Expected: no output.

- [ ] **Step 2: Confirm no old currency symbol remains**

```bash
grep -rn "₹" --include=*.html .
```
Expected: no output.

- [ ] **Step 3: Start a local static server and fetch the page**

```bash
npx -y serve -l 5959 . &
sleep 2
curl -s http://localhost:5959/ -o ./tmp_page.html
grep -c "8B5E34\|FFF8E7" ./tmp_page.html
grep -c "\$99/year\|\$299" ./tmp_page.html
grep -c "gkhayphmzopttyasclww" ./tmp_page.html
```
Expected: each `grep -c` prints a number greater than `0`, confirming the new theme colors, new pricing, and new Supabase URL are all present in what actually gets served.

- [ ] **Step 4: Stop the local server**

```bash
kill %1
rm ./tmp_page.html
```

- [ ] **Step 5: Open the page in a real browser and visually confirm**

This is a genuinely manual step — automated checks above confirm the *values* are correct, but only a human eye (or a screenshot tool) can confirm the cream/golden-brown palette actually looks good together. Start `npx -y serve -l 5959 .` (or use the existing `.claude/launch.json` "static" config) and check:
- Background reads as rich cream, text reads as golden-brown, at a glance nothing looks washed-out or low-contrast
- Landing page pricing shows `$299` struck through next to `$99/year`
- Nav upgrade badge (only visible when logged in with an inactive subscription) shows `Upgrade — $99/year`
- Sign up / sign in against the new Supabase project works (creates a session) — confirms the anon key from Task 3 is correct

- [ ] **Step 6: Push all commits**

```bash
git push origin main
```
Expected: push succeeds, `origin/main` now has all 6 commits from Tasks 1-6.

- [ ] **Step 7: Remind the user of the manual follow-ups that can't be done from here**

Print or otherwise surface this to the user — these cannot be completed by an agent in this environment:
1. Run `migration_step1.sql` → `migration_step2.sql` → `migration_step3.sql` against the new Supabase project via its SQL Editor.
2. In Netlify's dashboard, set/update env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (new project), and `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (from their Stripe account) — and remove the now-unused `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
3. In their Stripe dashboard, add a webhook endpoint pointing at `https://satken-im.netlify.app/.netlify/functions/stripe-webhook` subscribed to the `checkout.session.completed` event, then copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
