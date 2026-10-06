import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'roulette.db'));

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '');
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '';
const CHANNEL_URL = process.env.CHANNEL_URL || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';

app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname));

db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  coins INTEGER NOT NULL DEFAULT 0,
  referred_by INTEGER,
  referral_rewarded INTEGER NOT NULL DEFAULT 0,
  first_spin_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  result_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  reward_type TEXT NOT NULL,
  reward_value TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  reward INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS task_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, task_key)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const defaults = {
  free_spin_hours: '24',
  paid_spin_cost: '100',
  paid_spin_limit: '5',
  code_days: '10',
  exchange_coins: '3500',
  exchange_uc: '60',
  exchange_discount_coins: '900',
  exchange_discount_percent: '25',
  referral_reward: '100',
  channel_reward: '50',
  weight_c50a: '15',
  weight_c100a: '10',
  weight_c150a: '7',
  weight_c100b: '6',
  weight_c150b: '5',
  weight_discount25: '3',
  weight_uc60: '0.2',
  weight_nothing: '50',
  uc_roulette_inventory: '1'
};
const setDefault = db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)`);
for (const [k,v] of Object.entries(defaults)) setDefault.run(k,v);

db.prepare(`INSERT OR IGNORE INTO tasks(key,title,reward) VALUES ('channel','Подпишитесь на наш канал',50)`).run();

const resultPool = [
  { id:'c50a', label:'50 монет', kind:'coins', value:50, weightKey:'weight_c50a' },
  { id:'c100a', label:'100 монет', kind:'coins', value:100, weightKey:'weight_c100a' },
  { id:'c150a', label:'150 монет', kind:'coins', value:150, weightKey:'weight_c150a' },
  { id:'c100b', label:'100 монет', kind:'coins', value:100, weightKey:'weight_c100b' },
  { id:'c150b', label:'150 монет', kind:'coins', value:150, weightKey:'weight_c150b' },
  { id:'discount25', label:'Скидка 25%', kind:'code', value:'25% скидка', weightKey:'weight_discount25' },
  { id:'uc60', label:'60 UC', kind:'code', value:'60 UC', weightKey:'weight_uc60' },
  { id:'nothing', label:'Ничего', kind:'nothing', value:0, weightKey:'weight_nothing' }
];

function now(){ return Math.floor(Date.now()/1000); }
function setting(k){ return Number(db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? 0); }
function randomCode(prefix){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s='';
  for(let i=0;i<7;i++) s += chars[crypto.randomInt(chars.length)];
  return `${prefix}-${s}`;
}
function pickResult(){
  const inventory = setting('uc_roulette_inventory');
  const pool=resultPool
    .filter(r => r.id !== 'uc60' || inventory > 0)
    .map(r=>({...r,weight:Math.max(0,Number(setting(r.weightKey))||0)}));
  const total=pool.reduce((a,r)=>a+r.weight,0);
  if(total<=0) return {id:'nothing',label:'Ничего',kind:'nothing',value:0,weightKey:'weight_nothing',weight:1};
  let x=Math.random()*total;
  for(const r of pool){ x-=r.weight; if(x<0) return r; }
  return pool[pool.length-1];
}

function authInitData(initData){
  if(!initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); if(!hash) return null;
  p.delete('hash');
  const dataCheck = [...p.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256',secret).update(dataCheck).digest('hex');
  if(!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(hash))) return null;
  const authDate = Number(p.get('auth_date')||0);
  if(now()-authDate > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
async function tg(method, body={}){
  const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)
  });
  const j=await r.json();
  if(!j.ok) throw new Error(j.description || 'Telegram API error');
  return j.result;
}
async function isSubscribed(userId){
  if(!CHANNEL_USERNAME) return false;
  try {
    const m=await tg('getChatMember',{chat_id:CHANNEL_USERNAME,user_id:Number(userId)});
    return ['member','administrator','creator'].includes(m.status) || (m.status==='restricted' && m.is_member);
  } catch { return false; }
}
async function notifyAdmin(text){
  if(!ADMIN_ID) return;
  try { await tg('sendMessage',{chat_id:Number(ADMIN_ID),text,parse_mode:'HTML'}); } catch {}
}
function upsertUser(tgUser, referralId){
  const t=now();
  const existing=db.prepare('SELECT * FROM users WHERE id=?').get(tgUser.id);
  if(existing){
    db.prepare('UPDATE users SET username=?, first_name=?, updated_at=? WHERE id=?').run(tgUser.username||'',tgUser.first_name||'',t,tgUser.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(tgUser.id);
  }
  let ref=null;
  if(referralId && Number(referralId)!==Number(tgUser.id) && db.prepare('SELECT id FROM users WHERE id=?').get(Number(referralId))) ref=Number(referralId);
  db.prepare('INSERT INTO users(id,username,first_name,referred_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(tgUser.id,tgUser.username||'',tgUser.first_name||'',ref,t,t);
  return db.prepare('SELECT * FROM users WHERE id=?').get(tgUser.id);
}
function requireUser(req,res){
  const tgUser=authInitData(req.headers['x-telegram-init-data']||'');
  if(!tgUser) { res.status(401).json({error:'Не удалось проверить Telegram WebApp данные'}); return null; }
  const ref = req.headers['x-referral-id'] || '';
  const u=upsertUser(tgUser,ref);
  return {tgUser,u};
}
function requireAdmin(req,res){
  const x=requireUser(req,res); if(!x) return null;
  if(String(x.tgUser.id)!==ADMIN_ID){ res.status(403).json({error:'Доступ только для администратора'}); return null; }
  return x;
}

app.get('/api/health',(req,res)=>res.json({ok:true,telegramConfigured:!!BOT_TOKEN,adminConfigured:!!ADMIN_ID,channelConfigured:!!CHANNEL_USERNAME,webappConfigured:!!WEBAPP_URL}));

app.get('/api/config',(req,res)=>{
  res.json({channelUrl:CHANNEL_URL,channelUsername:CHANNEL_USERNAME,botUsername:BOT_USERNAME,exchangeCoins:setting('exchange_coins'),exchangeUc:setting('exchange_uc'),exchangeDiscountCoins:setting('exchange_discount_coins'),exchangeDiscountPercent:setting('exchange_discount_percent'),paidSpinCost:setting('paid_spin_cost'),paidSpinLimit:setting('paid_spin_limit'),ucRouletteInventory:setting('uc_roulette_inventory')});
});

app.get('/api/me',(req,res)=>{
  const x=requireUser(req,res); if(!x) return;
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(x.tgUser.id);
  db.prepare("UPDATE codes SET status='expired',updated_at=? WHERE user_id=? AND status='pending' AND expires_at<=?").run(now(),u.id,now());
  const lastFree=db.prepare("SELECT created_at FROM spins WHERE user_id=? AND type='free' ORDER BY created_at DESC LIMIT 1").get(u.id)?.created_at||0;
  const paidSince=now()-86400;
  const paidCount=db.prepare("SELECT COUNT(*) c FROM spins WHERE user_id=? AND type='paid' AND created_at>?").get(u.id,paidSince).c;
  const claims=db.prepare('SELECT task_key FROM task_claims WHERE user_id=?').all(u.id).map(x=>x.task_key);
  const codes=db.prepare('SELECT code,reward_type,reward_value,status,expires_at,created_at FROM codes WHERE user_id=? ORDER BY created_at DESC').all(u.id);
  res.json({user:u,freeAvailable:now()-lastFree>=setting('free_spin_hours')*3600,freeNextAt:lastFree+setting('free_spin_hours')*3600,paidUsed:paidCount,paidLeft:Math.max(0,setting('paid_spin_limit')-paidCount),claims,codes,admin:String(u.id)===ADMIN_ID});
});

app.post('/api/spin',(req,res)=>{
  const x=requireUser(req,res); if(!x) return;
  const paid=!!req.body.paid;
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(x.tgUser.id);
  db.prepare("UPDATE codes SET status='expired',updated_at=? WHERE user_id=? AND status='pending' AND expires_at<=?").run(now(),u.id,now());
  const lastFree=db.prepare("SELECT created_at FROM spins WHERE user_id=? AND type='free' ORDER BY created_at DESC LIMIT 1").get(u.id)?.created_at||0;
  if(!paid && now()-lastFree<setting('free_spin_hours')*3600) return res.status(400).json({error:'Бесплатный прокрут ещё недоступен',nextAt:lastFree+setting('free_spin_hours')*3600});
  const paidCount=db.prepare("SELECT COUNT(*) c FROM spins WHERE user_id=? AND type='paid' AND created_at>?").get(u.id,now()-86400).c;
  if(paid && paidCount>=setting('paid_spin_limit')) return res.status(400).json({error:'Лимит платных прокрутов за 24 часа исчерпан'});
  if(paid && u.coins<setting('paid_spin_cost')) return res.status(400).json({error:'Недостаточно монет'});
  const result=pickResult();
  const t=now();
  const tx=db.transaction(()=>{
    if(paid) db.prepare('UPDATE users SET coins=coins-?,updated_at=? WHERE id=?').run(setting('paid_spin_cost'),t,u.id);
    if(result.kind==='coins') db.prepare('UPDATE users SET coins=coins+?,updated_at=? WHERE id=?').run(result.value,t,u.id);
    db.prepare('INSERT INTO spins(user_id,type,cost,result_id,created_at) VALUES(?,?,?,?,?)').run(u.id,paid?'paid':'free',paid?setting('paid_spin_cost'):0,result.id,t);
  });
  tx();
  let code=null;
  if(result.kind==='code'){
    const prefix=result.id==='uc60'?'UC':'SALE';
    code=randomCode(prefix);
    const expires=t+setting('code_days')*86400;
    db.prepare('INSERT INTO codes(code,user_id,reward_type,reward_value,source,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(code,u.id,result.id,result.value,'spin',expires,t,t);
    if(result.id==='uc60') db.prepare("UPDATE settings SET value=CAST(value AS REAL)-1 WHERE key='uc_roulette_inventory' AND CAST(value AS REAL)>0").run();
    notifyAdmin(`🎰 <b>Новый выигрыш</b>\n👤 ${escapeHtml(u.username?'@'+u.username:u.first_name)}\n🆔 ${u.id}\n🎁 ${escapeHtml(result.label)}\n🔑 <code>${code}</code>\n⏳ Код действует 10 дней.`);
  }
  if(!u.first_spin_done){
    db.prepare('UPDATE users SET first_spin_done=1,updated_at=? WHERE id=?').run(t,u.id);
    maybeRewardReferral(u.id,t);
  }
  res.json({result:{...result,code,expiresAt:code?t+setting('code_days')*86400:null},coins:db.prepare('SELECT coins FROM users WHERE id=?').get(u.id).coins});
});

app.post('/api/task/channel/claim',async (req,res)=>{
  const x=requireUser(req,res); if(!x) return;
  const u=x.u;
  if(db.prepare('SELECT 1 FROM task_claims WHERE user_id=? AND task_key=?').get(u.id,'channel')) return res.status(400).json({error:'Задание уже выполнено'});
  if(!(await isSubscribed(u.id))) return res.status(400).json({error:'Сначала подпишитесь на канал'});
  const t=now();
  const reward=setting('channel_reward');
  const tx=db.transaction(()=>{
    db.prepare('UPDATE users SET coins=coins+?,updated_at=? WHERE id=?').run(reward,t,u.id);
    db.prepare('INSERT INTO task_claims(user_id,task_key,created_at) VALUES(?,?,?)').run(u.id,'channel',t);
  }); tx();

  // Referral reward is released only after the invited user both subscribes and makes a first spin.
  maybeRewardReferral(u.id,t);
  res.json({ok:true,reward,coins:db.prepare('SELECT coins FROM users WHERE id=?').get(u.id).coins});
});

app.post('/api/exchange', (req,res)=>{
  const x=requireUser(req,res); if(!x) return;
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(x.tgUser.id);
  const type=String(req.body?.type||'uc');
  let cost, rewardType, rewardValue, prefix, label;
  if(type==='discount25'){
    cost=setting('exchange_discount_coins');
    const percent=setting('exchange_discount_percent');
    rewardType='exchange_discount25';
    rewardValue=`Скидка ${percent}% на экипировку`;
    prefix='SALE';
    label=`Скидка ${percent}% на экипировку`;
  } else {
    cost=setting('exchange_coins');
    const uc=setting('exchange_uc');
    rewardType='exchange_uc';
    rewardValue=`${uc} UC`;
    prefix='UC';
    label=`${uc} UC`;
  }
  if(u.coins<cost) return res.status(400).json({error:`Нужно ${cost} монет`});
  const t=now(), code=randomCode(prefix);
  const expires=t+setting('code_days')*86400;
  const tx=db.transaction(()=>{
    db.prepare('UPDATE users SET coins=coins-?,updated_at=? WHERE id=?').run(cost,t,u.id);
    db.prepare('INSERT INTO codes(code,user_id,reward_type,reward_value,source,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(code,u.id,rewardType,rewardValue,'exchange',expires,t,t);
  }); tx();
  notifyAdmin(`💱 <b>Новый обмен</b>\n👤 ${escapeHtml(u.username?'@'+u.username:u.first_name)}\n🆔 ${u.id}\n💰 Списано: ${cost} монет\n🎁 ${escapeHtml(label)}\n🔑 <code>${code}</code>\n⏳ Код действует 10 дней.`);
  res.json({ok:true,code,reward:rewardValue,expiresAt:expires,coins:db.prepare('SELECT coins FROM users WHERE id=?').get(u.id).coins});
});

app.get('/api/admin/codes',(req,res)=>{
  if(!requireAdmin(req,res)) return;
  db.prepare("UPDATE codes SET status='expired',updated_at=? WHERE status='pending' AND expires_at<=?").run(now(),now());
  const rows=db.prepare(`SELECT c.*,u.username,u.first_name FROM codes c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 200`).all();
  res.json({codes:rows});
});
app.post('/api/admin/codes/:id/status',(req,res)=>{
  if(!requireAdmin(req,res)) return;
  const status=req.body.status;
  if(!['issued','cancelled'].includes(status)) return res.status(400).json({error:'Недопустимый статус'});
  const row=db.prepare('SELECT * FROM codes WHERE id=?').get(req.params.id);
  if(!row) return res.status(404).json({error:'Код не найден'});
  if(row.status!=='pending') return res.status(400).json({error:'Код уже обработан'});
  db.prepare('UPDATE codes SET status=?,updated_at=? WHERE id=?').run(status,now(),row.id);
  res.json({ok:true});
});
app.get('/api/admin/stats',(req,res)=>{
  if(!requireAdmin(req,res)) return;
  res.json({
    users:db.prepare('SELECT COUNT(*) c FROM users').get().c,
    spins:db.prepare('SELECT COUNT(*) c FROM spins').get().c,
    pendingCodes:db.prepare("SELECT COUNT(*) c FROM codes WHERE status='pending' AND expires_at>?").get(now()).c,
    coins:db.prepare('SELECT COALESCE(SUM(coins),0) s FROM users').get().s
  });
});
app.post('/api/admin/settings',(req,res)=>{
  if(!requireAdmin(req,res)) return;
  const allowed=['exchange_coins','exchange_uc','exchange_discount_coins','exchange_discount_percent','referral_reward','channel_reward','paid_spin_cost','paid_spin_limit','code_days','free_spin_hours','weight_c50a','weight_c100a','weight_c150a','weight_c100b','weight_c150b','weight_discount25','weight_uc60','weight_nothing','uc_roulette_inventory'];
  const update=db.prepare('UPDATE settings SET value=? WHERE key=?');
  for(const k of allowed) if(req.body[k]!==undefined) update.run(String(req.body[k]),k);
  res.json({ok:true});
});
app.get('/api/admin/settings',(req,res)=>{
  if(!requireAdmin(req,res)) return;
  const rows=db.prepare('SELECT key,value FROM settings').all();
  res.json(Object.fromEntries(rows.map(x=>[x.key,Number(x.value)])));
});

function maybeRewardReferral(userId,t=now()){
  const fresh=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if(!fresh || !fresh.referred_by || !fresh.first_spin_done || fresh.referral_rewarded) return;
  // Subscription is checked live so reward is granted regardless of whether the user subscribed before or after the first spin.
  isSubscribed(userId).then(subscribed=>{
    if(!subscribed) return;
    const fresh2=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if(!fresh2 || !fresh2.referred_by || !fresh2.first_spin_done || fresh2.referral_rewarded) return;
    const ref=db.prepare('SELECT * FROM users WHERE id=?').get(fresh2.referred_by);
    if(!ref) return;
    const reward=setting('referral_reward');
    const tx=db.transaction(()=>{
      const marked=db.prepare('UPDATE users SET referral_rewarded=1,updated_at=? WHERE id=? AND referral_rewarded=0').run(t,userId);
      if(!marked.changes) return false;
      db.prepare('UPDATE users SET coins=coins+?,updated_at=? WHERE id=?').run(reward,t,ref.id);
      return true;
    });
    if(tx()) notifyAdmin(`👥 <b>Реферал активирован</b>\nНовый пользователь: ${fresh2.id}\nПригласивший: ${ref.id}\nНачислено: ${reward} монет.`);
  }).catch(()=>{});
}
function escapeHtml(s=''){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// Telegram bot polling: convenient for first test. For production use webhook if desired.
let offset=0;
async function pollBot(){
  if(!BOT_TOKEN) return;
  try{
    const updates=await tg('getUpdates',{offset,timeout:20,allowed_updates:['message']});
    for(const up of updates){
      offset=up.update_id+1;
      const m=up.message;
      if(!m?.text) continue;
      const chatId=m.chat.id;
      if(m.text.startsWith('/start')){
        const parts=m.text.split(' ');
        const ref=parts[1]||'';
        upsertUser(m.from,ref);
        const buttons={inline_keyboard:[
          [{text:'🎰 Открыть рулетку',web_app:{url:WEBAPP_URL}}],
          [{text:'📢 Подписаться на канал',url:CHANNEL_URL}]
        ]};
        await tg('sendMessage',{chat_id:chatId,text:`🎰 <b>Рулетка</b>\n\nДобро пожаловать, ${escapeHtml(m.from.first_name||'игрок')}!\n\nУ тебя есть бесплатный прокрут раз в 24 часа и до 5 платных прокрутов по 100 монет.`,parse_mode:'HTML',reply_markup:buttons});
      }
    }
  }catch(e){}
}
setInterval(pollBot,1000);

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.listen(PORT,()=>console.log(`Server started on :${PORT}`));
