let profile;
let accountMode='login';
const desktop=window.riichiDesktop;
const desktopPending=new Map();
let desktopRequestId=0;

if(desktop)window.chrome.webview.addEventListener('message',event=>{
 const {id,value,error}=event.data;
 const pending=desktopPending.get(id);
 if(!pending)return;
 desktopPending.delete(id);
 if(error)pending.reject(Error(error));
 else pending.resolve(value);
});

function desktopRequest(action,fields={}){
 return new Promise((resolve,reject)=>{
  const id=++desktopRequestId;
  desktopPending.set(id,{resolve,reject});
  window.chrome.webview.postMessage({Id:id,Action:action,...fields});
 });
}

async function requestAccountData(op, fields={}){
 const response=await fetch('/api',{method:'POST',body:JSON.stringify({op,...fields})});
 const data=await response.json();
 if(!response.ok)throw Error(data.error);
 return data;
}

function signedPoints(points){
 return (points>0?'+':'')+points.toFixed(1)+' pt';
}

function rankSummary(current,result){
 const changed=result && result.previousRank!==current.rank;
 const heading=changed?result.previousRank+' → '+current.rank:current.rank;
 const progress=changed?'<span>触发升降的 10 场合计 '+signedPoints(result.windowPoints)+'</span>':'';
 const top=current.topPoints==null?'':'<span>最狗位累计 '+signedPoints(current.topPoints)+'</span>';
 return '<div class="rank-summary"><strong>'+heading+'</strong>'+progress
  +'<span>最近 '+current.recentCount+' / 10 个半庄 · '+signedPoints(current.recentPoints)+'</span>'+top+'</div>';
}

function showAccountGate(){
 profile=null;
 resetTable();
 el('replay').hidden=true;
 el('replay').replaceChildren();
 el('leaderboard').hidden=true;
 el('leaderboard-content').replaceChildren();
 el('drill').hidden=true;
 el('drill').replaceChildren();
 el('lobby').hidden=true;
 el('account-gate').hidden=false;
 el('remember-login').hidden=!desktop?.remember;
 setPasswordVisible(false);
 if(desktop?.remember)readSavedLogin();
}

function rankRulesMarkup(rules){
 if(!rules?.length)return '';
 const rows=rules.map(({name,promoteAt,demoteBelow})=>'<tr><th scope="row">'+esc(name)+'</th><td>'
  +(promoteAt??'—')+'</td><td>'+(demoteBelow??'—')+'</td></tr>').join('');
 return '<details class="rank-rules"><summary>段位规则</summary>'
  +'<p>本段打满 10 个完整半庄后，最近 10 场合计达到晋级线则晋级，低于降级线则降级。升降后从第 1 场重新累计。</p>'
  +'<table><thead><tr><th scope="col">段位</th><th scope="col">晋级线（pt）</th><th scope="col">降级线（pt）</th></tr></thead><tbody>'
  +rows+'</tbody></table></details>';
}

function acceptProfile(current,rankRules){
 profile=current;
 el('account-gate').hidden=true;
 el('lobby').hidden=false;
 el('account-profile').innerHTML='<div class="account-identity"><b>'+esc(current.nickname)+'</b><button type="button" id="logout" class="secondary">退出登录</button></div>'
  +rankSummary(current)+rankRulesMarkup(rankRules);
 el('logout').onclick=async()=>{
  try{await requestAccountData('logout');showAccountGate();}
  catch(error){el('error').textContent=error.message;}
 };
 if(auth.token)call('state');
 else if(invited)call(parameters.has('resume')?'resume':'join',{code:invited});
 else if(desktop?.network)call('resume');
}

async function restoreAccount(){
 try{
  const {profile:current,rankRules,hasLanRoom}=await requestAccountData('me');
  if(current&&(!desktopStartup||hasLanRoom))acceptProfile(current,rankRules);
  else showAccountGate();
 }catch(error){
  showAccountGate();
  el('error').textContent=error.message;
 }
}

function changeAccountMode(mode){
 const registering=mode==='register';
 const form=el('account-form');
 accountMode=mode;
 el('login-tab').setAttribute('aria-pressed',String(!registering));
 el('register-tab').setAttribute('aria-pressed',String(registering));
 el('register-nickname').hidden=!registering;
 form.elements.nickname.required=registering;
 form.elements.password.autocomplete=registering?'new-password':'current-password';
 setPasswordVisible(false);
 el('account-submit').textContent=registering?'注册并登录':'登录';
 el('error').textContent='';
}

function setPasswordVisible(visible){
 const button=el('show-password'),label=visible?'隐藏密码':'显示密码';
 el('account-password').type=visible?'text':'password';
 button.setAttribute('aria-pressed',String(visible));
 button.setAttribute('aria-label',label);
 button.title=label;
}

async function readSavedLogin(){
 try{
  const saved=await desktopRequest('readLogin');
  if(!saved||el('account-gate').hidden)return;
  const form=el('account-form');
  if(form.elements.username.value||form.elements.password.value)return;
  form.elements.username.value=saved.Username||'';
  form.elements.password.value=saved.Password||'';
  el('remember-account').checked=Boolean(saved.Username);
  el('remember-password').checked=Boolean(saved.Password);
 }catch(error){el('error').textContent=error.message}
}

async function showLeaderboard(){
 const content=el('leaderboard-content');
 const loading=document.createElement('p');
 loading.setAttribute('role','status');
 loading.textContent='正在读取排行榜…';
 content.replaceChildren(loading);
 el('lobby').hidden=true;
 el('leaderboard').hidden=false;
 el('leaderboard-back').focus();
 try{
  const {players}=await requestAccountData('leaderboard');
  if(!loading.isConnected)return;
  const rows=players.map(({nickname,rank,points,isSelf},index)=>
   '<tr'+(isSelf?' class="leaderboard-self"':'')+'><td>'+(index+1)+'</td><th scope="row">'+esc(nickname)
   +(isSelf?' <small>（你）</small>':'')+'</th><td>'+esc(rank)+'</td><td>'+signedPoints(points)+'</td></tr>'
  ).join('');
  content.innerHTML='<table class="leaderboard-table"><caption>同段位按积分排序。最狗位显示累计积分，其余段位显示本段最近 10 个半庄的积分。</caption>'
   +'<thead><tr><th scope="col">排名</th><th scope="col">昵称</th><th scope="col">段位</th><th scope="col">积分</th></tr></thead><tbody>'+rows+'</tbody></table>';
 }catch{
  if(loading.isConnected)loading.textContent='未能读取排行榜，请返回大厅后重试。';
 }
}

el('open-leaderboard').onclick=showLeaderboard;
el('leaderboard-back').onclick=()=>{
 el('leaderboard').hidden=true;
 el('leaderboard-content').replaceChildren();
 if(st)render();
 else{
  el('lobby').hidden=false;
  el('open-leaderboard').focus();
 }
};
el('login-tab').onclick=()=>changeAccountMode('login');
el('register-tab').onclick=()=>changeAccountMode('register');
el('show-password').onclick=()=>setPasswordVisible(el('account-password').type==='password');
el('remember-account').onchange=()=>{
 if(!el('remember-account').checked)el('remember-password').checked=false;
};
el('remember-password').onchange=()=>{
 if(el('remember-password').checked)el('remember-account').checked=true;
};
el('account-form').onsubmit=async event=>{
 event.preventDefault();
 const form=event.currentTarget,submit=el('account-submit');
 if(submit.disabled)return;
 submit.disabled=true;
 try{
  const fields=Object.fromEntries(new FormData(form));
  const {profile:current,rankRules}=await requestAccountData(accountMode,fields);
  let preferenceError='';
  if(desktop?.remember){
   const login=el('remember-account').checked?{
    Username:fields.username.trim(),
    Password:el('remember-password').checked?fields.password:null
   }:null;
   try{await desktopRequest('saveLogin',{Login:login})}
   catch{preferenceError='已登录，暂时无法保存登录设置。'}
  }
  form.reset();
  setPasswordVisible(false);
  el('error').textContent=preferenceError;
  acceptProfile(current,rankRules);
 }catch(error){el('error').textContent=error.message;}
 finally{submit.disabled=false;}
};
