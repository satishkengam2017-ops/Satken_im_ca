// Receives Stripe's subscription-lifecycle webhooks and keeps the paying
// org's subscription_status / stripe_customer_id / stripe_subscription_id /
// current_period_ends_at in sync, using the Supabase service role key
// (bypasses RLS — never exposed client-side). Verifies Stripe's webhook
// signature before trusting any payload. Uses plain fetch/crypto (Node
// built-ins) — no npm dependency to install.

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

async function patchOrganizations(filterQuery, body){
  var resp = await fetch(
    process.env.SUPABASE_URL + '/rest/v1/organizations?' + filterQuery,
    {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(body)
    }
  );
  if(!resp.ok){
    var errText = await resp.text();
    throw new Error('Supabase PATCH failed: ' + errText);
  }
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

  try{
    // Initial subscription checkout — activates the org and remembers
    // the Stripe customer/subscription ids for the events below.
    if(payload.type === 'checkout.session.completed'){
      var session = payload.data.object;
      var orgId = session.metadata && session.metadata.org_id;
      if(!orgId){
        return { statusCode: 400, body: JSON.stringify({error:'no org_id found in webhook payload'}) };
      }
      // current_period_ends_at is set optimistically here (one month out) as
      // a safety net — Stripe doesn't guarantee invoice.payment_succeeded
      // fires after this event, so without it a race could leave the org
      // "active" with a null period end, which org_is_active() treats as
      // inactive. invoice.payment_succeeded below corrects it to the real
      // value on arrival, whichever order the two events land in.
      var oneMonthFromNow = new Date();
      oneMonthFromNow.setMonth(oneMonthFromNow.getMonth() + 1);

      await patchOrganizations('id=eq.' + encodeURIComponent(orgId), {
        subscription_status: 'active',
        stripe_customer_id: session.customer || null,
        stripe_subscription_id: session.subscription || null,
        current_period_ends_at: oneMonthFromNow.toISOString()
      });
      return { statusCode: 200, body: JSON.stringify({ok:true}) };
    }

    // Fires on the first invoice and every renewal — extends the org's
    // paid-through date to match the subscription's new billing period.
    if(payload.type === 'invoice.payment_succeeded'){
      var invoice = payload.data.object;
      var subscriptionId = invoice.subscription;
      var periodEnd = invoice.lines && invoice.lines.data && invoice.lines.data[0] &&
        invoice.lines.data[0].period && invoice.lines.data[0].period.end;
      if(!subscriptionId || !periodEnd){
        return { statusCode: 400, body: JSON.stringify({error:'missing subscription or period on invoice'}) };
      }
      await patchOrganizations('stripe_subscription_id=eq.' + encodeURIComponent(subscriptionId), {
        subscription_status: 'active',
        current_period_ends_at: new Date(periodEnd * 1000).toISOString()
      });
      return { statusCode: 200, body: JSON.stringify({ok:true}) };
    }

    // Fires when a subscription is cancelled (immediately, or at period
    // end depending on how it was cancelled) — locks the org out.
    if(payload.type === 'customer.subscription.deleted'){
      var subscription = payload.data.object;
      await patchOrganizations('stripe_subscription_id=eq.' + encodeURIComponent(subscription.id), {
        subscription_status: 'canceled'
      });
      return { statusCode: 200, body: JSON.stringify({ok:true}) };
    }
  }catch(e){
    return { statusCode: 502, body: JSON.stringify({error:'could not update Supabase', detail: e.message}) };
  }

  return { statusCode: 200, body: JSON.stringify({ignored:true}) };
};

module.exports.verifyStripeSignature = verifyStripeSignature;
