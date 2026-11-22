let profile;
let accountMode='login';

async function accountRequest(op, fields={}){
 const response=await fetch('/api',{method:'POST',body:JSON.stringify({op,...fields})});
 const data=await response.json();
 if(!response.ok)throw Error(data.error);
 return data.profile;
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
 st=null;
 last='';
 auth={};
 sessionStorage.removeItem('table');
 el('room').hidden=true;
 el('replay').hidden=true;
 el('replay').replaceChildren();
 el('lobby').hidden=true;
 el('account-gate').hidden=false;
}

function acceptProfile(current){
 profile=current;
 el('account-gate').hidden=true;
 el('lobby').hidden=false;
 el('account-profile').innerHTML='<div class="account-identity"><b>'+esc(current.nickname)+'</b><button type="button" id="logout" class="secondary">退出登录</button></div>'
  +rankSummary(current)
  +'<details class="rank-rules"><summary>段位规则</summary><p>小小狗 / 小狗 / 狗狗的 / 狗完了 / 狗王 / 最狗位</p><p>本段最近 10 个完整半庄合计达到 200 pt 晋级，低于 −200 pt 降级。升降后从第 1 场重新累计。</p></details>';
 el('logout').onclick=async()=>{
  try{await accountRequest('logout');showAccountGate();}
  catch(error){el('error').textContent=error.message;}
 };
 if(auth.token)call('state');
}

async function restoreAccount(){
 try{
  const current=await accountRequest('me');
  if(current)acceptProfile(current);
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
 el('account-submit').textContent=registering?'注册并登录':'登录';
 el('error').textContent='';
}

el('login-tab').onclick=()=>changeAccountMode('login');
el('register-tab').onclick=()=>changeAccountMode('register');
el('account-form').onsubmit=async event=>{
 event.preventDefault();
 const form=event.currentTarget,submit=el('account-submit');
 if(submit.disabled)return;
 submit.disabled=true;
 try{
  const current=await accountRequest(accountMode,Object.fromEntries(new FormData(form)));
  form.reset();
  el('error').textContent='';
  acceptProfile(current);
 }catch(error){el('error').textContent=error.message;}
 finally{submit.disabled=false;}
};
