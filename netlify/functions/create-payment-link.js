// Creates a Razorpay Payment Link for a store's ₹999/year subscription.
// Uses plain fetch against Supabase's REST API (no @supabase/supabase-js
// dependency) so the function has zero npm install step to fail at deploy time.

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

  var rzpAuth = Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64');
  var rzpResp;
  try{
    rzpResp = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + rzpAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: 99900, // paise — ₹999.00
        currency: 'INR',
        description: 'SATKEN annual subscription — ' + orgName,
        callback_url: 'https://satken-im.netlify.app/',
        callback_method: 'get',
        notes: { org_id: orgId }
      })
    });
  }catch(e){
    return { statusCode: 502, body: JSON.stringify({error:'could not reach Razorpay'}) };
  }

  var rzpData = await rzpResp.json();
  if(!rzpResp.ok){
    return { statusCode: 502, body: JSON.stringify({error:'razorpay error', detail: rzpData}) };
  }

  return { statusCode: 200, body: JSON.stringify({ short_url: rzpData.short_url }) };
};
