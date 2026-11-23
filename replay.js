const replayView=el('replay');
let replayDatabase;

function openReplayDatabase(){
 if(replayDatabase)return replayDatabase;
 replayDatabase=new Promise((resolve,reject)=>{
  const request=indexedDB.open('雀庭牌谱',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('matches',{keyPath:'id'});
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
 replayDatabase.catch(()=>{replayDatabase=null});
 return replayDatabase;
}

async function accessReplays(mode,operation){
 const db=await openReplayDatabase();
 return new Promise((resolve,reject)=>{
  const transaction=db.transaction('matches',mode);
  const request=operation(transaction.objectStore('matches'));
  transaction.oncomplete=()=>resolve(request.result);
  transaction.onabort=()=>reject(transaction.error);
 });
}

async function requestReplayData(op, fields={}){
 const response=await fetch('/api',{method:'POST',body:JSON.stringify({op,...fields})});
 const data=await response.json();
 if(!response.ok)throw Error(data.error);
 return data;
}

document.addEventListener('click',event=>{
 if(event.target.closest('[data-open-replays]'))showReplayLibrary();
});

function replayHeading(title, back){
 replayView.innerHTML='<div class="top"><h2>'+title+'</h2><button id="replay-back" class="secondary">'+back+'</button></div><div id="replay-content"></div>';
}

async function showReplayLibrary(){
 el('lobby').hidden=true;
 el('room').hidden=true;
 replayView.hidden=false;
 replayHeading('牌谱','返回');
 el('replay-back').onclick=()=>{
  replayView.hidden=true;
  replayView.replaceChildren();
  if(st)render();
  else el('lobby').hidden=false;
 };
 const content=el('replay-content');
 content.textContent='正在读取牌谱…';
 try{
  const owner=profile?.id;
  const {matches:serverMatches}=await requestReplayData('history');
  const localMatches=await accessReplays('readonly',store=>store.getAll()).catch(()=>[]);
  const savedIds=new Set(serverMatches.map(match=>match.id));
  const legacy=localMatches.filter(match=>(match.owner==null||match.owner===owner)
   && !savedIds.has(match.owner==null?match.id:match.id.slice(String(owner).length+1)));
  const matches=serverMatches.concat(legacy);
  matches.sort((a,b)=>b.at.localeCompare(a.at));
  if(!matches.length){
   content.innerHTML='<p>完整打完一个半庄后，牌谱会保存到你的账号。</p>';
   return;
  }
  content.innerHTML=matches.map((match,index)=>{
   const date=new Date(match.at).toLocaleString('zh-CN');
   const points=match.final[match.viewer];
   return '<div class="replay-match"><div><b>'+esc(date)+'</b><p>'+match.names.map(esc).join(' · ')+'</p></div><span>'+(match.roundCount??match.rounds.length)+' 局 · '+(points>0?'+':'')+points+' pt</span><button data-match="'+index+'">回放</button></div>';
  }).join('');
  content.querySelectorAll('[data-match]').forEach(button=>{
   button.onclick=async()=>{
    const match=matches[Number(button.dataset.match)];
    button.disabled=true;
    try{
     const replay=match.rounds?match:await requestReplayData('savedReplay',{matchId:match.id});
     if(button.isConnected)openMatchReplay(replay);
    }catch(error){
     if(button.isConnected)el('error').textContent=error.message;
    }finally{button.disabled=false;}
   };
  });
 }catch{
  content.innerHTML='<p role="status">未能读取牌谱，请重试。</p><button id="replay-retry">重试</button>';
  content.querySelector('#replay-retry').onclick=showReplayLibrary;
 }
}

function replayTurnStarts(frames,viewerSeat){
 const starts=[0];
 let seenFirstTurn=false;
 frames.forEach((frame,index)=>{
  if(frame.seat!==viewerSeat || !['zimo','fulou'].includes(frame.type))return;
  if(seenFirstTurn)starts.push(index);
  seenFirstTurn=true;
 });
 return starts;
}

function wallMarkup(wall){
 const group=(list,label)=>'<h3>'+label+'</h3><div class="replay-wall-tiles">'+list.map((p,index)=>
  '<span class="replay-wall-tile"><small>'+(index+1)+'</small>'+tile(p)+'</span>'
 ).join('')+'</div>';
 return group(wall.slice(0,14),'原始王牌 · 14 张')
  + group(wall.slice(14).reverse(),'活牌取牌顺序 · 122 张（前 52 张用于配牌）');
}

function openMatchReplay(match){
 replayHeading('半庄回放','返回牌谱');
 el('replay-back').onclick=showReplayLibrary;
 el('replay-content').innerHTML=`
  <div class="replay-toolbar">
   <label>局 <select id="replay-round"></select></label>
   <label>巡 <select id="replay-turn" title="以自家摸牌或鸣牌为一巡"></select></label>
   <label><input type="checkbox" id="replay-reveal"> 显示其他家手牌</label>
  </div>
  <nav class="replay-navigation" aria-label="回放进度">
   <button type="button" id="turn-back" aria-label="退一巡" title="退一巡">⇐</button>
   <button type="button" id="step-back" aria-label="退一步" title="退一步">←</button>
   <output id="replay-progress" aria-live="polite"></output>
   <button type="button" id="step-next" aria-label="进一步" title="进一步">→</button>
   <button type="button" id="turn-next" aria-label="进一巡" title="进一巡">⇒</button>
  </nav>
  <div id="replay-table"></div>
  <details class="replay-wall" id="replay-wall"><summary>查看原始牌山（136 张）</summary><div id="replay-wall-content"></div></details>
 `;
 const roundSelect=el('replay-round'),turnSelect=el('replay-turn'),reveal=el('replay-reveal');
 const wall=el('replay-wall'),wallContent=el('replay-wall-content');
 roundSelect.innerHTML=match.rounds.map((round,index)=>{
  const {round:label,honba}=round.frames[0].table;
  return '<option value="'+index+'">第 '+(index+1)+' 局 · '+label+' '+honba+' 本场</option>';
 }).join('');
 let step,round,starts,viewerSeat;
 function loadRound(){
  round=match.rounds[Number(roundSelect.value)];
  viewerSeat=round.frames[0].table.players.findIndex(player=>player.id===match.viewer);
  starts=replayTurnStarts(round.frames,viewerSeat);
  turnSelect.innerHTML=starts.map((_,index)=>'<option value="'+index+'">第 '+(index+1)+' 巡</option>').join('');
  step=0;
  wallContent.replaceChildren();
  if(wall.open)wallContent.innerHTML=wallMarkup(round.wall);
  paint();
 }
 const currentTurn=()=>starts.findLastIndex(start=>start<=step);
 function paint(){
  const frame=round.frames[step],table={...frame.table,l:viewerSeat};
  const hand=tiles(table.players[viewerSeat].hand).map(tile).join('');
  updateTableArea(el('replay-table'),tableMarkup(table,hand,{reveal:reveal.checked,interactive:false,replay:true})
   +'<div class="touchhand hand">'+hand+'</div>');
  const turn=currentTurn();
  turnSelect.value=turn;
  const events={qipai:'配牌',zimo:'摸牌',dapai:'打牌',fulou:'鸣牌',gang:'杠',gangzimo:'岭上摸牌',kaigang:'翻指示牌',hule:'和牌',pingju:frame.result?.name==='诈立'?'诈立':'流局'};
  const event=(frame.seat==null?'':winds[frame.seat]+'家 ')+events[frame.type];
  el('replay-progress').textContent=(step+1)+' / '+round.frames.length+' · '+event;
  el('step-back').disabled=step===0;
  el('step-next').disabled=step===round.frames.length-1;
  el('turn-back').disabled=turn===0;
  el('turn-next').disabled=turn===starts.length-1;
 }
 for(const [id,offset,byTurn] of [['step-back',-1,false],['step-next',1,false],['turn-back',-1,true],['turn-next',1,true]]){
  el(id).onclick=()=>{step=byTurn?starts[currentTurn()+offset]:step+offset;paint()};
 }
 roundSelect.onchange=loadRound;
 turnSelect.onchange=()=>{step=starts[Number(turnSelect.value)];paint()};
 reveal.onchange=paint;
 wall.ontoggle=()=>{if(wall.open&&!wallContent.firstChild)wallContent.innerHTML=wallMarkup(round.wall)};
 loadRound();
}
