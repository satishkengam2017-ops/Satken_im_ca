// Receives Razorpay's payment_link.paid webhook, verifies its signature,
// and flips the paying org's subscription_status to 'active' using the
// Supabase service role key (bypasses RLS — never exposed client-side).
// Uses plain fetch/crypto (Node built-ins) — no npm dependency to install.

var crypto = require('crypto');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({error:'method not allowed'}) };
  }

  var signature = event.headers['x-razorpay-signature'] || event.headers['X-Razorpay-Signature'];
  var rawBody = event.body; // must verify against the RAW string, not a parsed/re-serialized copy

  if(!signature){
    return { statusCode: 400, body: JSON.stringify({error:'missing signature header'}) };
  }

  var expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if(expectedSignature !== signature){
    return { statusCode: 400, body: JSON.stringify({error:'invalid signature'}) };
  }

  var payload;
  try{ payload = JSON.parse(rawBody); }
  catch(e){ return { statusCode: 400, body: JSON.stringify({error:'invalid JSON body'}) }; }

  // Only act on a successfully paid payment link. Event name/payload shape
  // verified against Razorpay's own dashboard test-send before going live —
  // see migration notes.
  if(payload.event !== 'payment_link.paid'){
    return { statusCode: 200, body: JSON.stringify({ignored:true}) };
  }

  var orgId = payload.payload &&
    payload.payload.payment_link &&
    payload.payload.payment_link.entity &&
    payload.payload.payment_link.entity.notes &&
    payload.payload.payment_link.entity.notes.org_id;

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
