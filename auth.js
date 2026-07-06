var SUPABASE_URL='https://lpjdurwfiidrztinjzyn.supabase.co';
var SUPABASE_ANON_KEY='sb_publishable_C88ixlj-EhwMHCxf3hmHuA_XmKsJthQ';
var sb=supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);

var currentUser=null;
var currentOrgId=null;
var currentOrgName=null;
var currentOrgSubStatus=null;
var currentOrgTrialEndsAt=null;
var currentUserRole=null;
var currentOrgPeriodEndsAt=null;

var authMode='login';

var EYE_OPEN_SVG='<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
var EYE_CLOSED_SVG='<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.6 18.6 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';

function togglePasswordVisibility(inputId,btnEl){
  var input=document.getElementById(inputId);
  var showing=input.type==='text';
  input.type=showing?'password':'text';
  btnEl.querySelector('svg').innerHTML=showing?EYE_OPEN_SVG:EYE_CLOSED_SVG;
  btnEl.setAttribute('aria-label',showing?'Show password':'Hide password');
}

function showAuthError(msg){
  var el=document.getElementById('auth-error');
  el.textContent=msg;
  el.style.color='var(--red)';
  el.style.display='block';
}
function clearAuthError(){
  var el=document.getElementById('auth-error');
  el.style.display='none';
  el.textContent='';
}

function switchAuthMode(mode){
  authMode=mode;
  clearAuthError();
  document.getElementById('auth-login-mode').style.display=(mode==='login')?'':'none';
  document.getElementById('auth-signup-mode').style.display=(mode==='signup')?'':'none';
  document.getElementById('auth-forgot-mode').style.display=(mode==='forgot')?'':'none';
}

function showAuthNotice(msg){
  var el=document.getElementById('auth-error');
  el.textContent=msg;
  el.style.color='var(--green)';
  el.style.display='block';
}

function setAuthBusy(busy){
  document.querySelectorAll('#auth-card button').forEach(function(b){b.disabled=busy;});
}

async function handleSignup(){
  clearAuthError();
  var storeName=document.getElementById('auth-store-name').value.trim();
  var email=document.getElementById('auth-signup-email').value.trim();
  var password=document.getElementById('auth-signup-password').value;

  if(!storeName||!email||!password){ showAuthError('All fields are required.'); return; }
  if(password.length<6){ showAuthError('Password must be at least 6 characters.'); return; }

  setAuthBusy(true);
  var {data,error}=await sb.auth.signUp({email:email,password:password});
  if(error){ setAuthBusy(false); showAuthError(error.message); return; }

  if(!data.session){
    setAuthBusy(false);
    showAuthError('Check your email to confirm your account, then sign in.');
    switchAuthMode('login');
    return;
  }

  currentUser=data.user;
  var {data:newOrgId,error:orgErr}=await sb.rpc('accept_invite_or_create_org',{org_name:storeName});
  setAuthBusy(false);
  if(orgErr){ showAuthError('Account created but store setup failed: '+orgErr.message); return; }
  currentOrgId=newOrgId;
  await resolveOrgAndEnterApp();
}

async function handleForgotPassword(){
  clearAuthError();
  var email=document.getElementById('auth-forgot-email').value.trim();
  if(!email){ showAuthError('Email is required.'); return; }

  setAuthBusy(true);
  var {error}=await sb.auth.resetPasswordForEmail(email,{
    redirectTo:'https://satken-im.netlify.app/'
  });
  setAuthBusy(false);
  if(error){
    // Supabase's client wraps some server-side failures (e.g. an SMTP
    // send error) as an error whose .message is just "{}" — show a
    // sensible fallback instead of that raw string.
    var msg=(error.message&&error.message!=='{}')?error.message:'Something went wrong sending the email. Please try again in a moment.';
    showAuthError(msg);
    return;
  }

  showAuthNotice('If an account exists for that email, a reset link has been sent.');
}

async function handleSetNewPassword(){
  var el=document.getElementById('reset-password-error');
  el.style.display='none';
  var newPassword=document.getElementById('reset-new-password').value;
  if(!newPassword||newPassword.length<6){
    el.textContent='Password must be at least 6 characters.';
    el.style.display='block';
    return;
  }
  var {error}=await sb.auth.updateUser({password:newPassword});
  if(error){ el.textContent=error.message; el.style.display='block'; return; }

  window.history.replaceState({},document.title,window.location.pathname);
  document.getElementById('reset-password-screen').style.display='none';
  var {data:{session}}=await sb.auth.getSession();
  if(session){ currentUser=session.user; await resolveOrgAndEnterApp(); }
  else { document.getElementById('auth-screen').style.display=''; switchAuthMode('login'); }
}

async function handleLogin(){
  clearAuthError();
  var email=document.getElementById('auth-email').value.trim();
  var password=document.getElementById('auth-password').value;
  if(!email||!password){ showAuthError('Email and password are required.'); return; }

  setAuthBusy(true);
  var {data,error}=await sb.auth.signInWithPassword({email:email,password:password});
  setAuthBusy(false);
  if(error){ showAuthError(error.message); return; }

  currentUser=data.user;
  await resolveOrgAndEnterApp();
}

async function handleLogout(){
  await sb.auth.signOut();
  currentUser=null;
  currentOrgId=null;
  currentOrgName=null;
  currentOrgSubStatus=null;
  currentOrgTrialEndsAt=null;
  currentUserRole=null;
  document.getElementById('app-shell').style.display='none';
  document.getElementById('trial-gate-screen').style.display='none';
  resetBranding();
  document.getElementById('auth-screen').style.display='';
  switchAuthMode('login');
}

async function resolveOrgAndEnterApp(){
  var {data:membership,error}=await sb
    .from('org_members')
    .select('org_id, role, organizations(id, name, subscription_status, trial_ends_at, current_period_ends_at)')
    .eq('user_id',currentUser.id)
    .single();

  if(error||!membership){
    showAuthError('No store found for this account. Please contact support.');
    return;
  }

  currentOrgId=membership.org_id;
  currentOrgName=membership.organizations.name;
  currentOrgSubStatus=membership.organizations.subscription_status;
  currentOrgTrialEndsAt=membership.organizations.trial_ends_at;
  currentOrgPeriodEndsAt=membership.organizations.current_period_ends_at;
  currentUserRole=membership.role;

  applyBranding();
  applySubscribeVisibility();

  if(isTrialExpired()){ showTrialGate(); return; }

  document.getElementById('auth-screen').style.display='none';
  document.getElementById('trial-gate-screen').style.display='none';
  document.getElementById('reset-password-screen').style.display='none';
  document.getElementById('app-shell').style.display='';
}

function isTrialExpired(){
  if(currentOrgSubStatus==='active')return false;
  if(currentOrgSubStatus==='trialing'){
    return new Date(currentOrgTrialEndsAt)<new Date();
  }
  // 'past_due' or 'canceled' — treat as blocked
  return true;
}

function showTrialGate(){
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('app-shell').style.display='none';
  document.getElementById('reset-password-screen').style.display='none';
  var nameEl=document.getElementById('trial-gate-org-name');
  if(nameEl)nameEl.textContent=currentOrgName||'your store';
  document.getElementById('trial-gate-screen').style.display='';
}

function applyBranding(){
  var nameEl=document.getElementById('app-brand-name');
  var subEl=document.getElementById('app-brand-sub');
  var navEl=document.getElementById('app-nav-label');
  if(nameEl)nameEl.textContent=currentOrgName;
  if(subEl)subEl.textContent='Inventory Management';
  if(navEl)navEl.textContent=currentOrgName;
}

function resetBranding(){
  var nameEl=document.getElementById('app-brand-name');
  var subEl=document.getElementById('app-brand-sub');
  var navEl=document.getElementById('app-nav-label');
  if(nameEl)nameEl.textContent='SATKEN';
  if(subEl)subEl.textContent='Inventory Management';
  if(navEl)navEl.textContent='SATKEN';
}

// Fires when the user lands back on the site via a password-reset email
// link — registered at top level (not inside DOMContentLoaded) since it's
// just a subscription and can fire independently of the initial session check.
sb.auth.onAuthStateChange(function(event,session){
  if(event==='PASSWORD_RECOVERY'){
    document.getElementById('auth-screen').style.display='none';
    document.getElementById('trial-gate-screen').style.display='none';
    document.getElementById('app-shell').style.display='none';
    document.getElementById('reset-password-screen').style.display='';
  }
});

/* ── BILLING (Razorpay) ── */
function getBtnLabel(btnEl){
  var span=btnEl.querySelector('.btn-label');
  return span?span.textContent:btnEl.textContent;
}
function setBtnLabel(btnEl,text){
  var span=btnEl.querySelector('.btn-label');
  if(span)span.textContent=text; else btnEl.textContent=text;
}

async function handleSubscribe(btnEl){
  btnEl=btnEl||document.getElementById('subscribe-btn');
  var originalText=getBtnLabel(btnEl);
  btnEl.disabled=true;
  setBtnLabel(btnEl,'Redirecting to payment…');

  var {data:{session}}=await sb.auth.getSession();
  if(!session){ btnEl.disabled=false; setBtnLabel(btnEl,originalText); return; }

  try{
    var resp=await fetch('/.netlify/functions/create-payment-link',{
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
  }catch(e){
    alert('Network error starting payment.');
    btnEl.disabled=false;
    setBtnLabel(btnEl,originalText);
  }
}

function applySubscribeVisibility(){
  var navBtn=document.getElementById('nav-subscribe-btn');
  var daysPill=document.getElementById('days-remaining-pill');
  var isActive=currentOrgSubStatus==='active';

  if(navBtn) navBtn.style.display=isActive?'none':'';

  if(daysPill){
    if(isActive&&currentOrgPeriodEndsAt){
      var msLeft=new Date(currentOrgPeriodEndsAt)-new Date();
      var daysLeft=Math.max(0,Math.ceil(msLeft/86400000));
      daysPill.textContent=daysLeft+(daysLeft===1?' day left':' days left');
      daysPill.style.display='';
    } else {
      daysPill.style.display='none';
    }
  }
}

function checkPostPaymentRedirect(){
  var params=new URLSearchParams(window.location.search);
  if(params.has('razorpay_payment_id')){
    window.history.replaceState({},document.title,window.location.pathname);
    pollForActivation(0);
  }
}

function pollForActivation(attempt){
  if(attempt>=8){
    alert('Payment received — activation can take a few seconds. Please refresh shortly if this screen doesn\'t update.');
    return;
  }
  setTimeout(async function(){
    await resolveOrgAndEnterApp();
    var gate=document.getElementById('trial-gate-screen');
    if(gate&&gate.style.display!=='none'){
      pollForActivation(attempt+1);
    }
  },2500);
}

document.addEventListener('DOMContentLoaded',async function(){
  // A password-recovery link lands here with #...type=recovery in the URL.
  // Supabase establishes a real session from it immediately, which would
  // otherwise look identical to a normal login below and skip straight into
  // the app — so detect it directly from the URL and let the
  // PASSWORD_RECOVERY listener (registered above) own the screen instead.
  var isRecovery=window.location.hash.indexOf('type=recovery')!==-1;
  if(isRecovery){
    setTimeout(function(){
      if(document.getElementById('reset-password-screen').style.display!==''){
        document.getElementById('auth-screen').style.display='none';
        document.getElementById('trial-gate-screen').style.display='none';
        document.getElementById('app-shell').style.display='none';
        document.getElementById('reset-password-screen').style.display='';
      }
    },800);
    return;
  }

  var {data:{session}}=await sb.auth.getSession();
  if(session){
    currentUser=session.user;
    await resolveOrgAndEnterApp();
  } else {
    document.getElementById('auth-screen').style.display='';
  }
  checkPostPaymentRedirect();
});
