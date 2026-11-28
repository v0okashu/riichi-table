const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {gzipSync,gunzipSync} = require('node:zlib');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const rankRules = [
 {name:'小小狗', promoteAt:0, demoteBelow:null},
 {name:'小狗', promoteAt:50, demoteBelow:-100},
 {name:'狗狗的', promoteAt:100, demoteBelow:-150},
 {name:'狗完了', promoteAt:150, demoteBelow:-180},
 {name:'狗王', promoteAt:200, demoteBelow:-180},
 {name:'最狗位', promoteAt:null, demoteBelow:-150}
];
const windowSize = 10;
const sessionLifetime = 30 * 24 * 60 * 60;
const scrypt = promisify(crypto.scrypt);
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const validUsername = username => typeof username==='string'&&/^[a-z0-9_]{3,24}$/.test(username);
const validNickname = nickname => typeof nickname==='string'&&nickname.trim()===nickname&&nickname.length>0
 &&Array.from(nickname).length<=12&&!/[\x00-\x1f\x7f]/.test(nickname);
const lanPayload = ({code,challenge,audience,publicKey,username,nickname}) => Buffer.from(JSON.stringify([
 'wangwang-lan-v1',code,challenge,audience,publicKey,username,nickname
]));
const profilePayload = ({publicKey,nickname,rank,points,recentCount,revision}) => Buffer.from(JSON.stringify([
 'wangwang-rank-profile-v1',publicKey,nickname,rank,points,recentCount,revision
]));

function verifyLanProof(proof){
 return validUsername(proof.username)&&validNickname(proof.nickname)&&verifyLanSignature(proof,lanPayload);
}

function verifyLanSignature(signed,payload){
 if(typeof signed.publicKey!=='string'||!/^[\w-]{59}$/.test(signed.publicKey)||
    typeof signed.signature!=='string'||!/^[\w-]{86}$/.test(signed.signature))return false;
 try{
  const key=crypto.createPublicKey({key:Buffer.from(signed.publicKey,'base64url'),format:'der',type:'spki'});
  return key.asymmetricKeyType==='ed25519'&&key.export({format:'der',type:'spki'}).toString('base64url')===signed.publicKey
   &&crypto.verify(null,payload(signed),key,Buffer.from(signed.signature,'base64url'));
 }catch{return false;}
}

function validLanProfile(snapshot){
 return snapshot&&validNickname(snapshot.nickname)&&Number.isInteger(snapshot.rank)&&rankRules[snapshot.rank]&&
  Number.isFinite(snapshot.points)&&Number.isInteger(snapshot.recentCount)&&snapshot.recentCount>=0&&snapshot.recentCount<=windowSize&&Number.isSafeInteger(snapshot.revision)&&
  snapshot.revision>=0&&verifyLanSignature(snapshot,profilePayload);
}

function openAccounts(file) {
 fs.mkdirSync(path.dirname(file), {recursive:true});
 const db = new DatabaseSync(file);
 db.exec(`
  PRAGMA foreign_keys=ON;
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=4000;
  CREATE TABLE IF NOT EXISTS accounts (
   id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL,
   salt BLOB NOT NULL, password_hash BLOB NOT NULL,
   rank INTEGER NOT NULL DEFAULT 0, stage INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
   hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
   expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ranked_matches (
   seq INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
   match_id TEXT NOT NULL, stage INTEGER NOT NULL, points INTEGER NOT NULL,
   UNIQUE(account_id, match_id)
  );
  CREATE TABLE IF NOT EXISTS completed_matches (
   id TEXT PRIMARY KEY, played_at TEXT NOT NULL, account_ids TEXT NOT NULL,
   names TEXT NOT NULL, final TEXT NOT NULL, round_count INTEGER NOT NULL,
   replay BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ranked_recent ON ranked_matches(account_id, stage, seq DESC);
  CREATE TABLE IF NOT EXISTS drill_progress (
   account_id INTEGER NOT NULL REFERENCES accounts(id), mode TEXT NOT NULL, solved INTEGER NOT NULL,
   PRIMARY KEY(account_id,mode)
  );
  CREATE TABLE IF NOT EXISTS drill_favorites (
   account_id INTEGER NOT NULL REFERENCES accounts(id), mode TEXT NOT NULL, bank_index INTEGER NOT NULL,
   PRIMARY KEY(account_id,mode,bank_index)
  );
  CREATE TABLE IF NOT EXISTS lan_player_keys (
   account_id INTEGER PRIMARY KEY REFERENCES accounts(id), public_key TEXT NOT NULL UNIQUE, private_key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lan_identities (
   public_key TEXT PRIMARY KEY, account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id)
  );
  CREATE TABLE IF NOT EXISTS lan_ranked_matches (
   account_id INTEGER NOT NULL, match_id TEXT NOT NULL, hosted INTEGER NOT NULL, seat INTEGER NOT NULL,
   PRIMARY KEY(account_id,match_id),
   FOREIGN KEY(account_id,match_id) REFERENCES ranked_matches(account_id,match_id)
  );
  CREATE TABLE IF NOT EXISTS lan_profile_cache (
   viewer INTEGER NOT NULL REFERENCES accounts(id), public_key TEXT NOT NULL,
   revision INTEGER NOT NULL, snapshot TEXT NOT NULL,
   PRIMARY KEY(viewer,public_key)
  );
  CREATE TABLE IF NOT EXISTS lan_sync_cursors (
   account_id INTEGER NOT NULL REFERENCES accounts(id), source TEXT NOT NULL, seq INTEGER NOT NULL,
   PRIMARY KEY(account_id,source)
  );
  CREATE TABLE IF NOT EXISTS lan_metadata (name TEXT PRIMARY KEY,value TEXT NOT NULL);
 `);
 db.prepare("INSERT OR IGNORE INTO lan_metadata VALUES('source',?)").run(crypto.randomUUID());
 const lanSource=db.prepare("SELECT value FROM lan_metadata WHERE name='source'").get().value;

 const byId = db.prepare('SELECT id, username, nickname, rank, stage FROM accounts WHERE id=?');
 const allAccounts = db.prepare(`SELECT a.id,a.nickname,a.rank,a.stage,p.public_key FROM accounts a
  LEFT JOIN lan_player_keys p ON p.account_id=a.id
  WHERE NOT EXISTS(SELECT 1 FROM lan_identities i WHERE i.account_id=a.id) ORDER BY a.id`);
 const lookup = db.prepare('SELECT id, salt, password_hash FROM accounts WHERE username=?');
 const insertAccount = db.prepare(`
  INSERT INTO accounts(username,nickname,salt,password_hash) VALUES(?,?,?,?)
  ON CONFLICT(username) DO NOTHING RETURNING id
 `);
 const removeExpired = db.prepare('DELETE FROM sessions WHERE expires<=?');
 const insertSession = db.prepare('INSERT INTO sessions VALUES(?,?,?)');
 const findSession = db.prepare('SELECT account_id FROM sessions WHERE hash=? AND expires>?');
 const removeSession = db.prepare('DELETE FROM sessions WHERE hash=?');
 const history = db.prepare(`
  SELECT count(*) AS count, coalesce(sum(points),0) AS points FROM (
   SELECT points FROM ranked_matches WHERE account_id=? AND stage=? ORDER BY seq DESC LIMIT ?
  )
 `);
 const stageTotal = db.prepare('SELECT coalesce(sum(points),0) AS points FROM ranked_matches WHERE account_id=? AND stage=?');
 const insertResult = db.prepare(`
  INSERT INTO ranked_matches(account_id,match_id,stage,points) VALUES(?,?,?,?)
  ON CONFLICT(account_id,match_id) DO NOTHING
 `);
 const insertArchive = db.prepare(`INSERT INTO completed_matches VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
 const archiveList = db.prepare(`SELECT m.id, m.played_at, m.account_ids, m.names, m.final, m.round_count
  FROM ranked_matches r JOIN completed_matches m ON m.id=r.match_id
  WHERE r.account_id=? ORDER BY m.played_at DESC`);
 const archiveById = db.prepare(`SELECT m.* FROM ranked_matches r JOIN completed_matches m ON m.id=r.match_id WHERE r.account_id=? AND m.id=?`);
 const setRank = db.prepare('UPDATE accounts SET rank=?, stage=stage+1 WHERE id=?');
 const readDrills = db.prepare('SELECT mode,solved FROM drill_progress WHERE account_id=?');
 const saveDrill = db.prepare(`INSERT INTO drill_progress VALUES(?,?,?)
  ON CONFLICT(account_id,mode) DO UPDATE SET solved=MAX(solved,excluded.solved)`);
 const readDrillFavorites = db.prepare('SELECT mode,bank_index FROM drill_favorites WHERE account_id=? ORDER BY mode,bank_index');
 const readDrillFavorite = db.prepare('SELECT 1 FROM drill_favorites WHERE account_id=? AND mode=? AND bank_index=?');
 const addDrillFavorite = db.prepare('INSERT INTO drill_favorites VALUES(?,?,?) ON CONFLICT DO NOTHING');
 const removeDrillFavorite = db.prepare('DELETE FROM drill_favorites WHERE account_id=? AND mode=? AND bank_index=?');
 const playerKey = db.prepare('SELECT public_key,private_key FROM lan_player_keys WHERE account_id=?');
 const savePlayerKey = db.prepare('INSERT INTO lan_player_keys VALUES (?,?,?)');
 const localIdentity = db.prepare('SELECT account_id FROM lan_player_keys WHERE public_key=?');
 const linkedIdentity = db.prepare('SELECT account_id FROM lan_identities WHERE public_key=?');
 const linkIdentity = db.prepare('INSERT INTO lan_identities VALUES (?,?)');
 const legacyIdentity = db.prepare(`SELECT id FROM accounts WHERE id=? AND username=?
  AND NOT EXISTS(SELECT 1 FROM lan_identities WHERE account_id=?)
  AND NOT EXISTS(SELECT 1 FROM lan_player_keys WHERE account_id=?)`);
 const linkedKey = db.prepare('SELECT public_key FROM lan_identities WHERE account_id=?');
 const saveLanResult = db.prepare(`INSERT INTO lan_ranked_matches VALUES (?,?,?,?)
  ON CONFLICT(account_id,match_id) DO UPDATE SET hosted=MAX(hosted,excluded.hosted)`);
 const lanSeat = db.prepare('SELECT seat FROM lan_ranked_matches WHERE account_id=? AND match_id=?');
 const rankRevision = db.prepare('SELECT count(*) AS count FROM ranked_matches WHERE account_id=?');
 const saveLanProfile = db.prepare(`INSERT INTO lan_profile_cache VALUES(?,?,?,?)
  ON CONFLICT(viewer,public_key) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot
  WHERE excluded.revision>lan_profile_cache.revision`);
 const cachedProfile = db.prepare('SELECT snapshot,revision FROM lan_profile_cache WHERE viewer=? AND public_key=?');
 const cachedPeers = db.prepare('SELECT snapshot FROM lan_profile_cache WHERE viewer=?');
 const lanCursor = db.prepare('SELECT seq FROM lan_sync_cursors WHERE account_id=? AND source=?');
 const saveLanCursor = db.prepare(`INSERT INTO lan_sync_cursors VALUES(?,?,?)
  ON CONFLICT(account_id,source) DO UPDATE SET seq=MAX(seq,excluded.seq)`);
 const nextLanArchive = db.prepare(`SELECT r.seq,m.* FROM ranked_matches r
  JOIN lan_ranked_matches l ON r.account_id=l.account_id AND r.match_id=l.match_id
  JOIN completed_matches m ON r.match_id=m.id
  WHERE r.account_id=? AND r.seq>? AND l.hosted=1 ORDER BY r.seq LIMIT 1`);

 function profile(id) {
  const remote=linkedKey.get(id);
  if(remote){
   const saved=cachedProfile.get(id,remote.public_key);
   if(saved){
    const value=JSON.parse(saved.snapshot);
    return {id,nickname:value.nickname,rank:rankRules[value.rank].name,recentCount:value.recentCount,
     recentPoints:value.points,...(value.rank===rankRules.length-1?{topPoints:value.points}:{})};
   }
  }
  return accountProfile(byId.get(id));
 }

 function accountProfile(account) {
  const {id}=account;
  const recent = history.get(id,account.stage,windowSize);
  return {id,nickname:account.nickname,rank:rankRules[account.rank].name,recentCount:recent.count,
   recentPoints:recent.points/10,
   ...(account.rank===rankRules.length-1?{topPoints:stageTotal.get(id,account.stage).points/10}:{})};
 }

 function leaderboard(viewerId) {
  const accounts=allAccounts.all();
  const keys=new Set(accounts.map(account=>account.public_key));
  const locals=accounts.map(account=>{
   const current=accountProfile(account);
   return {rankIndex:account.rank,nickname:current.nickname,rank:current.rank,
    points:current.topPoints??current.recentPoints,isSelf:account.id===viewerId};
  });
  const selfKey=linkedKey.get(viewerId)?.public_key;
  const peers=cachedPeers.all(viewerId).map(row=>JSON.parse(row.snapshot)).filter(peer=>!keys.has(peer.publicKey)).map(peer=>({
   rankIndex:peer.rank,rank:rankRules[peer.rank].name,nickname:peer.nickname,points:peer.points,
   isSelf:selfKey===peer.publicKey
  }));
  return locals.concat(peers).sort((a,b)=>b.rankIndex-a.rankIndex||b.points-a.points)
   .map(({nickname,rank,points,isSelf})=>({nickname,rank,points,isSelf}));
 }

 function session(id) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now()/1000);
  removeExpired.run(now);
  insertSession.run(digest(token),id,now+sessionLifetime);
  return {token,profile:profile(id)};
 }

 async function authenticate(op, body) {
  const username = typeof body.username==='string'?body.username.trim().toLowerCase():'';
  const password = typeof body.password==='string'?body.password:'';
  const validPassword = password.length>=8 && password.length<=128;
  if(op==='register'){
   const nickname = typeof body.nickname==='string'?body.nickname.trim():'';
   if(!validUsername(username))throw Error('账号须为 3～24 位字母、数字或下划线');
   if(!validPassword)throw Error('密码长度须为 8～128 个字符');
   if(!validNickname(nickname))throw Error('昵称须为 1～12 个字符');
   const salt = crypto.randomBytes(16);
   const passwordHash = await scrypt(password,salt,64);
   const account = insertAccount.get(username,nickname,salt,passwordHash);
   if(!account)throw Error('这个账号已被注册');
   return session(account.id);
  }
  if(!validUsername(username)||!validPassword)throw Error('账号或密码错误');
  const account = lookup.get(username);
  const passwordHash = await scrypt(password,account?.salt??Buffer.alloc(16),64);
  if(!account || !crypto.timingSafeEqual(passwordHash,account.password_hash))throw Error('账号或密码错误');
  return session(account.id);
 }

 function ensurePlayerKey(id){
  let key=playerKey.get(id);
  if(!key){
   const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
   key={public_key:publicKey.export({type:'spki',format:'der'}).toString('base64url'),
    private_key:privateKey.export({type:'pkcs8',format:'pem'})};
   savePlayerKey.run(id,key.public_key,key.private_key);
  }
  return key;
 }

 function signLanProof(id,code,challenge,audience){
  const {username,nickname}=byId.get(id);
  if(!validUsername(username))throw Error('请在本机登录后加入房间');
  const key=ensurePlayerKey(id);
  const proof={username,nickname,publicKey:key.public_key,code,challenge,audience};
  return {...proof,signature:crypto.sign(null,lanPayload(proof),key.private_key).toString('base64url'),stats:lanProfile(id)};
 }

 function acceptLanProof(proof,legacyId,canEnter){
  const {publicKey,username,nickname}=proof;
  const known=localIdentity.get(publicKey)??linkedIdentity.get(publicKey);
  const legacy=legacyId&&legacyIdentity.get(legacyId,username,legacyId,legacyId);
  let id=known?.account_id??legacy?.id;
  canEnter(id);
  if(known){publishLanProfile(id,proof.stats);return session(id);}
  db.exec('BEGIN IMMEDIATE');
  try{
   // Guest records are keyed by identity and never authenticate with a password on this host.
   id??=insertAccount.get('~lan-'+digest(publicKey),nickname,crypto.randomBytes(16),crypto.randomBytes(64)).id;
   linkIdentity.run(publicKey,id);
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  publishLanProfile(id,proof.stats);
  return session(id);
 }

 function lanProfile(id,createKey=true){
  const remote=linkedKey.get(id);
  if(remote){
   const saved=cachedProfile.get(id,remote.public_key);
   return saved?JSON.parse(saved.snapshot):null;
  }
  const key=createKey?ensurePlayerKey(id):playerKey.get(id);
  if(!key)return null;
  const account=byId.get(id),current=accountProfile(account);
  const snapshot={publicKey:key.public_key,nickname:current.nickname,rank:account.rank,
   points:current.topPoints??current.recentPoints,recentCount:current.recentCount,revision:rankRevision.get(id).count};
  return {...snapshot,signature:crypto.sign(null,profilePayload(snapshot),key.private_key).toString('base64url')};
 }

 function publishLanProfile(id,snapshot){
  const remote=linkedKey.get(id);
  if(remote&&snapshot?.publicKey===remote.public_key)rememberLanPeers(id,[snapshot]);
 }

 function rememberLanPeers(viewer,snapshots){
  for(const snapshot of snapshots){
   if(typeof snapshot?.publicKey!=='string')continue;
   const previous=cachedProfile.get(viewer,snapshot.publicKey);
   if((!previous||snapshot.revision>previous.revision)&&validLanProfile(snapshot))
    saveLanProfile.run(viewer,snapshot.publicKey,snapshot.revision,JSON.stringify(snapshot));
  }
 }

 function lanFeed(id,after){
  const row=nextLanArchive.get(id,after);
  if(!row)return null;
  return {seq:row.seq,player:(linkedKey.get(id)??playerKey.get(id))?.public_key,
   match:{...matchSummary(row,id),...JSON.parse(gunzipSync(row.replay).toString('utf8'))}};
 }

 function importLanMatch(id,source,entry){
  if(ensurePlayerKey(id).public_key!==entry?.player)throw Error('组网牌谱与本机账号不匹配');
  const {seq,match}=entry;
  if(!Number.isSafeInteger(seq)||seq<1||!match||typeof match.id!=='string'||
     !Number.isInteger(match.viewer)||match.viewer<0||match.viewer>3||
     !Array.isArray(match.final)||match.final.length!==4||!match.final.every(Number.isFinite)||
     !Array.isArray(match.record?.player)||match.record.player.length!==4||
     !Array.isArray(match.record.log)||!match.record.log.length||!Array.isArray(match.walls)||
     match.walls.length!==match.record.log.length||typeof match.at!=='string')throw Error('组网牌谱数据无效');
  const accountIds=Array(4).fill(null);
  accountIds[match.viewer]=id;
  const result=applyMatch(match.id,[{id,points:match.final[match.viewer]}],{...match,accountIds,lan:true})[id];
  saveLanCursor.run(id,source,seq);
  return {id:match.id,result,stats:lanProfile(id)};
 }

 function accountId(token) {
  return token ? findSession.get(digest(token),Math.floor(Date.now()/1000))?.account_id : undefined;
 }

 function logout(token) {
  if(token)removeSession.run(digest(token));
 }

 function matchSummary(row,id){
  const viewer=lanSeat.get(id,row.id)?.seat??JSON.parse(row.account_ids).indexOf(id);
  return {id:row.id,at:row.played_at,viewer,
   names:JSON.parse(row.names),final:JSON.parse(row.final),roundCount:row.round_count};
 }

 function matches(id){
  return archiveList.all(id).map(row=>matchSummary(row,id));
 }

 function savedMatch(id,matchId){
  const row=archiveById.get(id,matchId);
  if(!row)return null;
  return {...matchSummary(row,id),...JSON.parse(gunzipSync(row.replay).toString('utf8'))};
 }

 function applyMatch(matchId, participants, archive) {
  const packed=archive && gzipSync(JSON.stringify({record:archive.record,walls:archive.walls}));
  const changes = {};
  db.exec('BEGIN IMMEDIATE');
  try {
   if(archive)insertArchive.run(matchId,archive.at,JSON.stringify(archive.accountIds),
    JSON.stringify(archive.record.player),JSON.stringify(archive.final),archive.record.log.length,packed);
   for(const {id,points} of participants){
    const {rank,stage} = byId.get(id);
    const {name,promoteAt,demoteBelow} = rankRules[rank];
    const inserted = insertResult.run(id,matchId,stage,Math.round(points*10));
    if(archive?.lan)saveLanResult.run(id,matchId,archive.hosted?1:0,archive.accountIds.indexOf(id));
    // The host keeps this guest's replay and result, while the guest's own account settles its rank.
    if(archive?.hosted&&linkedKey.get(id)){
     const current=profile(id);
     changes[id]={profile:current,previousRank:current.rank,windowPoints:current.recentPoints};
     continue;
    }
    const recent = history.get(id,stage,windowSize);
    let next = rank;
    if(inserted.changes && recent.count===windowSize){
     if(promoteAt!==null && recent.points>=promoteAt*10)next++;
     else if(demoteBelow!==null && recent.points<demoteBelow*10)next--;
    }
    if(next!==rank)setRank.run(next,id);
    changes[id]={profile:profile(id),previousRank:name,windowPoints:recent.points/10};
   }
   db.exec('COMMIT');
   return changes;
  }catch(error){
   db.exec('ROLLBACK');
   throw error;
  }
 }

 function drillProgress(id){
  return Object.fromEntries(readDrills.all(id).map(({mode,solved})=>[mode,solved]));
 }
 function solveDrill(id,mode,solved){
  saveDrill.run(id,mode,solved);
 }

 return {authenticate,accountId,logout,profile,leaderboard,applyMatch,matches,savedMatch,drillProgress,solveDrill,
  drillFavorites:id=>readDrillFavorites.all(id),
  isDrillFavorite:(id,mode,bankIndex)=>Boolean(readDrillFavorite.get(id,mode,bankIndex)),
  setDrillFavorite:(id,mode,bankIndex,favorite)=>(favorite?addDrillFavorite:removeDrillFavorite).run(id,mode,bankIndex),
  signLanProof,acceptLanProof,lanProfile,publishLanProfile,rememberLanPeers,lanFeed,lanSource,importLanMatch,
  lanCursor:(id,source)=>lanCursor.get(id,source)?.seq??0};
}

module.exports = {openAccounts,sessionLifetime,rankRules,verifyLanProof};
