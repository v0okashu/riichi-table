const suits=['m','p','s','z'];
function tileName(p){
 if(p==='back')return '暗手牌背';
 return p[0]==='z'?'东南西北白发中'[+p[1]-1]:(p[1]==='0'?'赤':'')+'一二三四五六七八九'[(+p[1]||5)-1]+({m:'万',s:'索',p:'筒'}[p[0]]);
}
function modelTile(p){
 const back=p==='back',row=back?0:p[1]==='0'?4:suits.indexOf(p[0]);
 const col=back?0:p[1]==='0'?suits.indexOf(p[0]):+p[1]-1;
 const pins=Array.from({length:8},(_,i)=>'<b class="pin" style="left:'+(i%2*100)+'%;top:'+(Math.floor(i/2)%2*100)+'%;transform:translateZ('+(i>=4?'var(--depth)':'0px')+')"></b>').join('');
 return '<span data-model="'+(back?'back':p.slice(0,2))+'" role="img" aria-label="'+tileName(p)+'" class="model block '+(back?'concealed':'')+'" style="--u:'+col*12.5+'%;--v:'+row*25+'%"><i class="porcelain"></i><i class="reverse"></i><i class="edge north"></i><i class="edge south"></i><i class="edge east"></i><i class="edge west"></i>'+pins+'</span>';
}

