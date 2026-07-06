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
