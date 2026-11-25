const drill=el('drill');
const drillModes={
 flush:{name:'清一色听牌',prompt:'找出这手清一色牌形的所有待牌。',format:'填写所有待牌的数字 1–9，例如 147。顺序任意。'},
 efficiency:{name:'一向听进张',prompt:'能让这手牌进入听牌的进张共有几种、几枚？',format:'两格都只填数字。例如 6 种 20 枚，依次填 6 和 20。'},
 score:{name:'番符与打点',prompt:'按 M.LEAGUE 规则算出番数、符数和支付点数。',format:'每格只填数字。番数按实际役和宝牌加总，符数填写计分所用的符数。'},
 discard:{name:'两向听何切',prompt:'切掉哪一张，能让下一摸进入一向听的剩余进张枚数最多？',format:'只填一个牌编码，例如 1m。并列最优时，填任一张即可。'}
};
const tileCode=tile=>tile[1]+tile[0];
const codeKey='m 万、p 筒、s 索、z 字牌。1z–7z 依次是东、南、西、北、白、发、中。赤五也填 5。';
let drillStatus;

function drillPage(title,backLabel,back){
 drill.innerHTML='<div class="top"><h2 tabindex="-1">'+title+'</h2><button type="button" class="secondary">'+backLabel+'</button></div><div class="panel drill-content"></div>';
 const heading=drill.querySelector('h2');
 drill.querySelector('.top button').onclick=back;
 heading.focus();
 return drill.querySelector('.drill-content');
}

async function showDrills(){
 if(!profile)return;
 el('lobby').hidden=true;
 drill.hidden=false;
 const panel=drillPage('闯关练习','返回大厅',()=>{
  drill.hidden=true;
  drill.replaceChildren();
  if(st)render();
  else{el('lobby').hidden=false;el('open-drill').focus();}
 });
 panel.textContent='正在读取练习进度…';
 try{
  const status=await requestAccountData('drillProgress');
  if(!panel.isConnected)return;
  drillStatus=status;
  panel.innerHTML='<p>每类 40 关，每关 5 题。答对本关 5 题即可解锁下一关，已通关的题可以重做。</p><div class="drill-modes">'
   +Object.entries(drillModes).map(([mode,{name,prompt}])=>'<button type="button" class="secondary" data-drill-mode="'+mode+'"><strong>'+name+'</strong><span>'+prompt+'</span><small>'+(status.progress[mode]??0)+' / '+status.total+' 题</small></button>').join('')+'</div>';
  panel.querySelectorAll('[data-drill-mode]').forEach(button=>button.onclick=()=>showDrillLevels(button.dataset.drillMode));
 }catch(error){if(panel.isConnected)panel.textContent=error.message;}
}

function showDrillLevels(mode){
 const panel=drillPage(drillModes[mode].name,'返回题型',showDrills);
 const {levelSize,total,progress}=drillStatus;
 const solved=progress[mode]??0;
 panel.innerHTML='<p>已完成 '+solved+' / '+total+' 题</p><div class="drill-levels">'+Array.from({length:total/levelSize},(_,level)=>{
  const first=level*levelSize;
  const closed=first>solved,done=solved>=first+levelSize;
  const status=closed?'未解锁':done?'已通关':first===solved?'待开始':(solved-first)+' / '+levelSize+' 题';
  return '<button type="button" class="secondary" data-level="'+level+'" '+(closed?'disabled':'')+'>第 '+(level+1)+' 关<small>'+status+'</small></button>';
 }).join('')+'</div>';
 panel.querySelectorAll('[data-level]:enabled').forEach(button=>button.onclick=()=>{
  const start=Number(button.dataset.level)*levelSize;
  showDrillQuestion(mode,solved>=start+levelSize?start:solved);
 });
}

const drillTiles=tiles=>'<div class="drill-tiles">'+tiles.map(tile).join('')+'</div>';
const numberBox=(label,name='numbers')=>'<label><input type="text" inputmode="numeric" maxlength="6" name="'+name+'" autocomplete="off" aria-label="'+label+'" required><span>'+label+'</span></label>';
function scoreLabels(q){
 return ['番','符',...(q.tsumo?q.seat?['闲家各付点','亲家付点']:['三家各付点']:['点'])];
}
function questionMarkup(mode,q){
 const info=drillModes[mode];
 const hand='<div class="drill-row"><b>手牌</b>'+drillTiles(q.hand)+'</div>';
 const visible=q.visible?.length?'<div class="drill-row"><b>其余已见牌</b>'+drillTiles(q.visible)+'</div>':'';
 const melds=q.melds?.length?'<div class="drill-row"><b>副露</b><div class="drill-tiles">'+q.melds.map(meldGroup).join('')+'</div></div>':'';
 const score=mode==='score'?'<p>'+winds[q.round]+'场 · 自风 '+winds[q.seat]+' · '+(q.tsumo?'自摸':'荣和')+' · '+(q.riichi?'已立直':'未立直')+' · 0 本场</p>'
  +'<div class="drill-score-tiles"><div class="drill-row"><b>和牌</b>'+drillTiles([q.win])+'</div><div class="drill-row"><b>表宝指示牌</b>'+drillTiles(q.dora)+'</div>'
  +(q.ura.length?'<div class="drill-row"><b>里宝指示牌</b>'+drillTiles(q.ura)+'</div>':'')+'</div>':'';
 const accounting=mode==='discard'?'计算枚数时扣除手牌和其余已见牌。本次切掉的牌已包含在手牌中。':mode==='efficiency'?'计算枚数时扣除手牌和题面列出的其余已见牌。':mode==='flush'?'手里已用尽四枚的牌不计入待牌。':q.tsumo?'自摸填写每家实际支付点数。满贯及以上也填符数。':'例如 1 番 40 符 1300 点，依次填 1、40、1300。满贯及以上也填符数。';
 const fields=mode==='score'?scoreLabels(q).map(label=>numberBox(label)).join('')
  :mode==='efficiency'?numberBox('种','kinds')+numberBox('枚','total')
  :'<label><input name="tiles" type="text" inputmode="'+(mode==='flush'?'numeric':'text')+'" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="'+(mode==='discard'?'切牌':'有效牌')+'" maxlength="100" required><span>'+(mode==='discard'?'切牌':'有效牌')+'</span></label>';
 return '<p class="drill-prompt">'+info.prompt+'</p>'+score+hand+melds+visible+'<p>'+accounting+'</p><p id="drill-format">'+info.format+(mode==='discard'?' '+codeKey:'')+'</p>'
  +'<form class="drill-form" aria-describedby="drill-format"><div class="drill-fields">'+fields+'</div><button type="submit">提交答案</button></form><div class="drill-feedback" aria-live="polite"></div>';
}

function drillSolution(mode,q,a){
 const entries=items=>items.map(([tile,n])=>tileCode(tile)+' × '+n).join('，');
 if(mode==='score'){
  const chinese={'ドラ':'表宝牌','裏ドラ':'里宝牌','赤ドラ':'赤宝牌','門前清自摸和':'门前清自摸和','断幺九':'断幺九','七対子':'七对子','対々和':'对对和','一気通貫':'一气通贯','三色同順':'三色同顺','一盃口':'一杯口','二盃口':'二杯口','混全帯幺九':'混全带幺九','純全帯幺九':'纯全带幺九'};
  const yaku=a.yaku.map(({name,fanshu})=>(chinese[name]??name.replace('場風','场风').replace('自風','自风').replace('發','发'))+' '+fanshu+' 番').join(' · ');
  return '<p>'+a.numbers.map((value,i)=>value+' '+scoreLabels(q)[i]).join(' · ')+'</p><p>'+esc(yaku)+'</p>';
 }
 if(mode==='flush')return '<p>待牌 '+a.tiles.map(tile=>tile[1]).join(' ')+'</p>'+drillTiles(a.tiles);
 if(mode==='efficiency')return '<p>'+a.tiles.length+' 种，共 '+a.total+' 枚</p><p>'+entries(a.entries)+'</p>';
 const best=a.best.map(option=>'<p>切 '+tileCode(option.tile)+'，'+option.entries.length+' 种 '+option.total+' 枚 · '+entries(option.entries)+'</p>').join('');
 const all=a.options.map(option=>'切 '+tileCode(option.tile)+' '+option.total+' 枚').join(' · ');
 return best+'<details><summary>比较各切牌的进张枚数</summary><p>'+all+'</p></details>';
}

async function showDrillQuestion(mode,index){
 const {levelSize,total}=drillStatus;
 const level=Math.floor(index/levelSize),inLevel=index%levelSize;
 const panel=drillPage(drillModes[mode].name,'返回关卡',()=>showDrillLevels(mode));
 panel.textContent='正在读取题目…';
 try{
  const {question}=await requestAccountData('drillQuestion',{mode,index});
  if(!panel.isConnected)return;
  panel.innerHTML='<p class="drill-position">第 '+(level+1)+' 关 · 第 '+(inLevel+1)+' / '+levelSize+' 题</p>'+questionMarkup(mode,question);
  const form=panel.querySelector('form'),submit=form.querySelector('button'),feedback=panel.querySelector('.drill-feedback');
  form.onsubmit=async event=>{
   event.preventDefault();
   if(submit.disabled)return;
   submit.disabled=true;
   const fields=new FormData(form);
   const answer=mode==='score'?{numbers:fields.getAll('numbers')}
    :mode==='efficiency'?{kinds:fields.get('kinds'),total:fields.get('total')}
    :{tiles:fields.get('tiles')};
   let correct=false;
   try{
    const result=await requestAccountData('drillAnswer',{mode,index,answer});
    if(!panel.isConnected)return;
    correct=result.correct;
    const last=inLevel===levelSize-1;
    feedback.innerHTML='<strong>'+(correct?(last?'本关完成':'回答正确'):'答案有误，可以重答')+'</strong>'+drillSolution(mode,question,result.solution);
    feedback.classList.toggle('is-correct',correct);
    if(!correct)return;
    drillStatus.progress[mode]=result.solved;
    form.querySelectorAll('input').forEach(input=>input.disabled=true);
    const next=document.createElement('button');
    next.type='button';
    next.textContent=last?(index+1<total?'进入下一关':'返回关卡'):'下一题';
    next.onclick=()=>index+1<total?showDrillQuestion(mode,index+1):showDrillLevels(mode);
    feedback.append(next);
    next.focus({preventScroll:true});
   }catch(error){if(panel.isConnected)feedback.textContent=error.message;}
   finally{submit.disabled=correct;}
  };
 }catch(error){if(panel.isConnected)panel.textContent=error.message;}
}

el('open-drill').onclick=showDrills;
