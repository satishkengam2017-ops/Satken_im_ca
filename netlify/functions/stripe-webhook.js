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
