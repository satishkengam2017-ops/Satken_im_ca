// Plain Node script (no test framework) verifying the signature-checking
// logic in stripe-webhook.js. Run with: node tests/stripe-webhook.test.js
var assert = require('assert');
var crypto = require('crypto');
var { verifyStripeSignature } = require('../netlify/functions/stripe-webhook.js');

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
