import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cron from 'node-cron';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { DateTime } from 'luxon';
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'animaca.sqlite');
const LEGACY_JSON = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';
const SESSION_COOKIE = 'animaca_session';
const PUBLISH_LOCK_MS = 15 * 60 * 1000;

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  image_mime TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  last_posted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  product_name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  image_mime TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  published_at TEXT,
  meta_post_id TEXT UNIQUE,
  error TEXT,
  error_code TEXT,
  error_subcode TEXT,
  last_attempt_at TEXT,
  publish_token TEXT,
  publish_lock_at TEXT,
  origin TEXT NOT NULL DEFAULT 'manual',
  planner_type TEXT,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_product ON posts(product_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`);

for (const [key, value] of Object.entries({ brand: 'Animaca Geek', timezone: TIMEZONE, approvalRequired: 'true' })) {
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(key, value);
}

function integrityCheck() {
  const rows = db.prepare('PRAGMA integrity_check').all();
  const ok = rows.length === 1 && String(Object.values(rows[0])[0]).toLowerCase() === 'ok';
  if (!ok) throw new Error(`Falha de integridade do SQLite: ${JSON.stringify(rows)}`);
}
integrityCheck();

function normalizeLegacyPost(p) {
  return {
    id: p.id || uuid(), productId: p.productId || null, productName: p.productName || '',
    message: String(p.message || '').trim(), imageUrl: p.imageUrl || '', imagePath: p.imagePath || '', imageMime: p.imageMime || '',
    status: ['draft','approved','published','error','cancelled'].includes(p.status) ? p.status : 'draft',
    scheduledAt: p.scheduledAt || null, createdAt: p.createdAt || new Date().toISOString(), updatedAt: p.updatedAt || null,
    publishedAt: p.publishedAt || null, metaPostId: p.metaPostId || null, error: p.error || null,
    origin: p.origin || 'legacy', plannerType: p.plannerType || null
  };
}

async function migrateLegacyJsonIfNeeded() {
  const already = db.prepare('SELECT 1 FROM migrations WHERE name=?').get('legacy-json-v1');
  if (already || !fssync.existsSync(LEGACY_JSON)) return;
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(LEGACY_JSON, 'utf8'));
  } catch (err) {
    throw new Error(`O banco legado ${LEGACY_JSON} existe, mas está corrompido. Nada foi apagado. Corrija/restaure o arquivo antes de iniciar. Detalhe: ${err.message}`);
  }
  const importTx = db.transaction(() => {
    const insProduct = db.prepare(`INSERT OR IGNORE INTO products
      (id,name,category,price,description,image_url,image_path,image_mime,active,last_posted_at,created_at)
      VALUES (@id,@name,@category,@price,@description,@imageUrl,@imagePath,@imageMime,@active,@lastPostedAt,@createdAt)`);
    for (const p of parsed.products || []) insProduct.run({
      id: p.id || uuid(), name: String(p.name || '').trim() || 'Produto legado', category: p.category || '', price: p.price || '',
      description: p.description || '', imageUrl: p.imageUrl || '', imagePath: p.imagePath || '', imageMime: p.imageMime || '',
      active: p.active === false ? 0 : 1, lastPostedAt: p.lastPostedAt || null, createdAt: p.createdAt || new Date().toISOString()
    });
    const insPost = db.prepare(`INSERT OR IGNORE INTO posts
      (id,product_id,product_name,message,image_url,image_path,image_mime,status,scheduled_at,created_at,updated_at,published_at,meta_post_id,error,origin,planner_type)
      VALUES (@id,@productId,@productName,@message,@imageUrl,@imagePath,@imageMime,@status,@scheduledAt,@createdAt,@updatedAt,@publishedAt,@metaPostId,@error,@origin,@plannerType)`);
    for (const raw of parsed.posts || []) {
      const p = normalizeLegacyPost(raw);
      if (p.message) insPost.run(p);
    }
    db.prepare('INSERT INTO migrations(name,applied_at) VALUES(?,?)').run('legacy-json-v1', new Date().toISOString());
  });
  importTx();
  const backup = `${LEGACY_JSON}.migrated-${Date.now()}.bak`;
  await fs.copyFile(LEGACY_JSON, backup);
  console.log(`[migration] JSON legado importado para SQLite. Backup preservado em ${backup}`);
}
await migrateLegacyJsonIfNeeded();

const app = express();
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', etag: true }));

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.APP_PASSWORD) return crypto.createHash('sha256').update(`animaca:${process.env.APP_PASSWORD}`).digest('hex');
  return '';
}
function signSession(exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token || !sessionSecret()) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try { return Number(JSON.parse(Buffer.from(payload, 'base64url').toString()).exp) > Date.now(); } catch { return false; }
}
function isAuthenticated(req) {
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}
function auth(req, res, next) {
  if (!process.env.APP_PASSWORD) return res.status(503).json({ error: 'APP_PASSWORD não configurada. O painel foi bloqueado por segurança.' });
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'Sessão não autenticada.', authRequired: true });
}
const loginAttempts = new Map();
function checkLoginRate(req) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now(); const windowMs = 15 * 60 * 1000; const max = 5;
  const rec = loginAttempts.get(key) || { first: now, count: 0 };
  if (now - rec.first > windowMs) { rec.first = now; rec.count = 0; }
  rec.count += 1; loginAttempts.set(key, rec);
  return rec.count <= max;
}
app.post('/api/login', (req, res) => {
  if (!process.env.APP_PASSWORD) return res.status(503).json({ error: 'APP_PASSWORD não configurada.' });
  if (!checkLoginRate(req)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde antes de tentar novamente.' });
  if (!safeEqual(String(req.body.password || ''), process.env.APP_PASSWORD)) return res.status(401).json({ error: 'Senha inválida.' });
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(signSession(exp))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
  res.json({ ok: true, expiresAt: new Date(exp).toISOString() });
});
app.post('/api/logout', (_req, res) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  res.json({ ok: true });
});
app.get('/api/auth/status', (req, res) => res.json({ configured: Boolean(process.env.APP_PASSWORD), authenticated: isAuthenticated(req) }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) return cb(new Error('Formato permitido: JPEG, PNG ou WEBP.'));
    cb(null, true);
  }
});
async function persistSafeImage(file) {
  if (!file) return null;
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !['image/jpeg','image/png','image/webp'].includes(detected.mime)) throw new Error('O conteúdo do arquivo não corresponde a uma imagem JPEG, PNG ou WEBP válida.');
  const output = await sharp(file.buffer, { failOn: 'error' })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
  const filename = `${uuid()}.webp`;
  const full = path.join(UPLOAD_DIR, filename);
  await fs.writeFile(full, output, { flag: 'wx' });
  return { path: full, mime: 'image/webp', filename };
}
function validateHttpsUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') throw new Error();
    return u.toString();
  } catch { throw new Error('A URL da imagem precisa ser HTTPS válida.'); }
}
app.get('/media/:name', auth, async (req, res) => {
  const name = path.basename(req.params.name);
  if (!/^[a-f0-9-]+\.webp$/i.test(name)) return res.status(404).end();
  const file = path.join(UPLOAD_DIR, name);
  if (!fssync.existsSync(file)) return res.status(404).end();
  res.type('image/webp').sendFile(file);
});

function productFromRow(r) { return r && ({ id:r.id,name:r.name,category:r.category,price:r.price,description:r.description,imageUrl:r.image_url,imagePath:r.image_path,imageMime:r.image_mime,active:Boolean(r.active),lastPostedAt:r.last_posted_at,createdAt:r.created_at,updatedAt:r.updated_at,mediaUrl:r.image_path?`/media/${path.basename(r.image_path)}`:'' }); }
function postFromRow(r) { return r && ({ id:r.id,productId:r.product_id,productName:r.product_name,message:r.message,imageUrl:r.image_url,imagePath:r.image_path,imageMime:r.image_mime,status:r.status,scheduledAt:r.scheduled_at,scheduledLocal:r.scheduled_at?DateTime.fromISO(r.scheduled_at,{zone:'utc'}).setZone(TIMEZONE).toFormat("yyyy-LL-dd'T'HH:mm"):null,createdAt:r.created_at,updatedAt:r.updated_at,publishedAt:r.published_at,metaPostId:r.meta_post_id,error:r.error,errorCode:r.error_code,errorSubcode:r.error_subcode,lastAttemptAt:r.last_attempt_at,origin:r.origin,plannerType:r.planner_type,mediaUrl:r.image_path?`/media/${path.basename(r.image_path)}`:'' }); }
function listProducts() { return db.prepare('SELECT * FROM products ORDER BY active DESC, created_at DESC').all().map(productFromRow); }
function listPosts() { return db.prepare('SELECT * FROM posts ORDER BY created_at ASC').all().map(postFromRow); }
function localToUtc(value) {
  if (!value) return null;
  const dt = DateTime.fromISO(String(value), { zone: TIMEZONE });
  if (!dt.isValid) throw new Error('Data/horário inválido.');
  return dt.toUTC().toISO({ suppressMilliseconds: true });
}
function plannerSlots() {
  const raw = String(process.env.PLANNER_SLOTS || '10:00,15:00,20:00');
  const slots = raw.split(',').map(s=>s.trim()).filter(s=>/^([01]\d|2[0-3]):[0-5]\d$/.test(s));
  return slots.length ? slots : ['10:00','15:00','20:00'];
}

let metaCache = { at: 0, value: null };
async function graphGet(endpoint, params = {}, token = process.env.META_PAGE_ACCESS_TOKEN) {
  const version = process.env.META_GRAPH_VERSION || 'v25.0';
  const url = new URL(`https://graph.facebook.com/${version}/${endpoint}`);
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  if (token) url.searchParams.set('access_token', token);
  const response = await fetch(url, { headers: { 'accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(json?.error?.message || `Meta API retornou HTTP ${response.status}`);
    err.code = json?.error?.code; err.subcode = json?.error?.error_subcode;
    throw err;
  }
  return json;
}
async function validateMetaConnection(force=false) {
  if (!process.env.META_PAGE_ID || !process.env.META_PAGE_ACCESS_TOKEN) return { configured:false, valid:false, reason:'META_PAGE_ID ou META_PAGE_ACCESS_TOKEN ausente.' };
  if (!force && metaCache.value && Date.now()-metaCache.at < 5*60*1000) return metaCache.value;
  try {
    const identity = await graphGet('me', { fields:'id,name' });
    const matchesPage = String(identity.id) === String(process.env.META_PAGE_ID);
    let tasks = null; let canCreateContent = null; let taskValidationError = null;
    if (process.env.META_USER_ACCESS_TOKEN) {
      try {
        const pages = await graphGet('me/accounts', { fields:'name,id,tasks', limit:100 }, process.env.META_USER_ACCESS_TOKEN);
        const page = (pages.data || []).find(p => String(p.id) === String(process.env.META_PAGE_ID));
        tasks = page?.tasks || [];
        const accepted = ['CREATE_CONTENT','PROFILE_PLUS_CREATE_CONTENT','MANAGE','PROFILE_PLUS_MANAGE','PROFILE_PLUS_FULL_CONTROL'];
        canCreateContent = Boolean(page && tasks.some(t => accepted.includes(t)));
      } catch (taskErr) {
        taskValidationError = taskErr.message;
      }
    }
    const value = { configured:true, valid:matchesPage, pageId:identity.id, pageName:identity.name, matchesPage, tasks, canCreateContent, taskValidationError, checkedAt:new Date().toISOString(), reason:matchesPage?null:'O token respondeu por uma identidade diferente do META_PAGE_ID configurado.' };
    metaCache = { at:Date.now(), value }; return value;
  } catch (err) {
    const value = { configured:true, valid:false, reason:err.message, code:err.code || null, subcode:err.subcode || null, checkedAt:new Date().toISOString() };
    metaCache = { at:Date.now(), value }; return value;
  }
}
function envStatus() {
  return { openai:Boolean(process.env.OPENAI_API_KEY), autoPublish:String(process.env.AUTO_PUBLISH).toLowerCase()==='true', graphVersion:process.env.META_GRAPH_VERSION||'v25.0', timezone:TIMEZONE, plannerSlots:plannerSlots() };
}
app.get('/api/status', auth, async (_req,res) => {
  const products = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  const posts = db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  const pending = db.prepare("SELECT COUNT(*) n FROM posts WHERE status IN ('draft','approved','error','needs_review')").get().n;
  const meta = await validateMetaConnection(false);
  res.json({ ...envStatus(), meta, counts:{products,posts,pending} });
});
app.post('/api/meta/validate', auth, async (_req,res) => res.json(await validateMetaConnection(true)));
app.get('/api/data', auth, (_req,res) => res.json({ products:listProducts(), posts:listPosts(), settings:{ timezone:TIMEZONE, approvalRequired:true, plannerSlots:plannerSlots() } }));

app.post('/api/products', auth, upload.single('image'), async (req,res,next) => {
  let saved;
  try {
    saved = await persistSafeImage(req.file);
    const name = String(req.body.name || '').trim(); if (!name) throw new Error('Nome do produto é obrigatório.');
    const imageUrl = validateHttpsUrl(req.body.imageUrl);
    const product = { id:uuid(), name, category:String(req.body.category||'').trim(), price:String(req.body.price||'').trim(), description:String(req.body.description||'').trim(), imageUrl, imagePath:saved?.path||'', imageMime:saved?.mime||'', createdAt:new Date().toISOString() };
    db.prepare(`INSERT INTO products(id,name,category,price,description,image_url,image_path,image_mime,created_at) VALUES(@id,@name,@category,@price,@description,@imageUrl,@imagePath,@imageMime,@createdAt)`).run(product);
    res.json(productFromRow(db.prepare('SELECT * FROM products WHERE id=?').get(product.id)));
  } catch (err) {
    if (saved?.path) await fs.unlink(saved.path).catch(()=>{});
    next(err);
  }
});
app.delete('/api/products/:id', auth, async (req,res) => {
  const found = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!found) return res.status(404).json({error:'Produto não encontrado.'});
  const refs = found.image_path ? db.prepare('SELECT COUNT(*) n FROM posts WHERE image_path=?').get(found.image_path).n : 0;
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  if (found.image_path && refs === 0) await fs.unlink(found.image_path).catch(()=>{});
  res.json({ok:true,mediaPreserved:refs>0});
});

function recentPublishedText(limit=12) {
  return db.prepare("SELECT product_name,message FROM posts WHERE status='published' ORDER BY published_at DESC LIMIT ?").all(limit).map(p=>`${p.product_name||'institucional'}: ${p.message}`).join('\n---\n');
}
function contentStrategy(product, recent, mode='product_sale') {
  const modeRule = {
    product_sale:'Objetivo: vender o produto de forma direta, destacando apenas benefícios sustentados pelos dados fornecidos.',
    engagement:'Objetivo: gerar comentário/interação com uma pergunta ou gancho geek, conectando naturalmente ao produto sem forçar venda.',
    showcase:'Objetivo: mostrar personalização, presente ou uso do produto de forma visual e desejável, com CTA leve.',
    institutional:'Objetivo: reforçar marca e relacionamento, sem inventar números, depoimentos ou fatos.'
  }[mode] || '';
  return `Você é o agente de conteúdo da Animaca Geek, marca brasileira de personalizados com linguagem humana, comercial e geek.\n\n${modeRule}\nProduto: ${product?.name||'Nenhum produto específico'}\nCategoria: ${product?.category||'não informada'}\nPreço: ${product?.price||'não informar preço'}\nDescrição: ${product?.description||'sem descrição adicional'}\n\nRegras:\n- Português do Brasil.\n- Comece com um gancho forte, sem parecer texto genérico de IA.\n- Parágrafos curtos.\n- CTA claro quando fizer sentido.\n- 3 a 6 hashtags relevantes no final.\n- NÃO invente características, estoque, prazo, frete, avaliações, números ou promoções.\n- Evite repetir estruturas dos posts recentes.\n- Retorne somente a legenda final.\n\nPosts recentes:\n${recent||'Nenhum.'}`;
}
async function generateCaption(product, mode) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Configure OPENAI_API_KEY no .env.');
  const client = new OpenAI({ apiKey:process.env.OPENAI_API_KEY });
  const response = await client.responses.create({ model:process.env.OPENAI_MODEL||'gpt-5.6', input:contentStrategy(product,recentPublishedText(),mode), store:false });
  const message = response.output_text?.trim(); if (!message) throw new Error('A IA não retornou uma legenda.');
  return message;
}
function insertPost({product=null,message,imageUrl='',imagePath='',imageMime='',scheduledAt=null,origin='manual',plannerType=null,status='draft'}) {
  const id=uuid(); const createdAt=new Date().toISOString();
  db.prepare(`INSERT INTO posts(id,product_id,product_name,message,image_url,image_path,image_mime,status,scheduled_at,created_at,origin,planner_type)
  VALUES(@id,@productId,@productName,@message,@imageUrl,@imagePath,@imageMime,@status,@scheduledAt,@createdAt,@origin,@plannerType)`).run({id,productId:product?.id||null,productName:product?.name||'',message,imageUrl:imageUrl||product?.imageUrl||'',imagePath:imagePath||product?.imagePath||'',imageMime:imageMime||product?.imageMime||'',status,scheduledAt,createdAt,origin,plannerType});
  return postFromRow(db.prepare('SELECT * FROM posts WHERE id=?').get(id));
}
app.post('/api/generate', auth, async (req,res,next) => {
  try {
    const row=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(req.body.productId); if(!row) return res.status(404).json({error:'Produto não encontrado.'});
    const product=productFromRow(row); const message=await generateCaption(product,'product_sale');
    res.json(insertPost({product,message,origin:'manual'}));
  } catch(err){next(err)}
});
app.post('/api/posts', auth, (req,res,next) => {
  try {
    const message=String(req.body.message||'').trim(); if(!message) throw new Error('Legenda é obrigatória.');
    const product=req.body.productId?productFromRow(db.prepare('SELECT * FROM products WHERE id=?').get(req.body.productId)):null;
    res.json(insertPost({product,message,imageUrl:validateHttpsUrl(req.body.imageUrl),scheduledAt:req.body.scheduledLocal?localToUtc(req.body.scheduledLocal):null,origin:'manual'}));
  }catch(err){next(err)}
});
app.patch('/api/posts/:id', auth, (req,res,next) => {
  try {
    const current=db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id); if(!current) return res.status(404).json({error:'Post não encontrado.'});
    if (['publishing','published'].includes(current.status)) return res.status(409).json({error:'Post em publicação ou já publicado não pode ser editado.'});
    const updates=[]; const vals=[];
    if ('message' in req.body) { const m=String(req.body.message||'').trim(); if(!m) throw new Error('Legenda não pode ficar vazia.'); updates.push('message=?'); vals.push(m); }
    if ('scheduledLocal' in req.body) { updates.push('scheduled_at=?'); vals.push(req.body.scheduledLocal?localToUtc(req.body.scheduledLocal):null); }
    if ('imageUrl' in req.body) { updates.push('image_url=?'); vals.push(validateHttpsUrl(req.body.imageUrl)); }
    if ('status' in req.body) {
      if (!['draft','approved','cancelled'].includes(req.body.status)) throw new Error('Status inválido.');
      updates.push('status=?'); vals.push(req.body.status); updates.push('error=NULL','error_code=NULL','error_subcode=NULL');
    }
    updates.push('updated_at=?'); vals.push(new Date().toISOString()); vals.push(req.params.id);
    db.prepare(`UPDATE posts SET ${updates.join(',')} WHERE id=?`).run(...vals);
    res.json(postFromRow(db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id)));
  }catch(err){next(err)}
});

function chooseProductsForPlan(count) {
  const products=listProducts().filter(p=>p.active);
  if(!products.length) throw new Error('Cadastre pelo menos um produto ativo antes de usar o Planner.');
  const recentIds=new Set(db.prepare("SELECT product_id FROM posts WHERE product_id IS NOT NULL ORDER BY created_at DESC LIMIT 3").all().map(r=>r.product_id));
  products.sort((a,b)=>{
    const ar=recentIds.has(a.id)?1:0, br=recentIds.has(b.id)?1:0; if(ar!==br)return ar-br;
    const at=a.lastPostedAt?Date.parse(a.lastPostedAt):0, bt=b.lastPostedAt?Date.parse(b.lastPostedAt):0; return at-bt;
  });
  const out=[]; for(let i=0;i<count;i++) out.push(products[i%products.length]); return out;
}
app.post('/api/planner/generate', auth, async (req,res,next) => {
  try {
    const date=String(req.body.date||DateTime.now().setZone(TIMEZONE).toISODate());
    const d=DateTime.fromISO(date,{zone:TIMEZONE}); if(!d.isValid) throw new Error('Data do Planner inválida.');
    const slots=plannerSlots(); const products=chooseProductsForPlan(slots.length); const modes=['product_sale','engagement','showcase'];
    const created=[];
    for(let i=0;i<slots.length;i++){
      const local=`${date}T${slots[i]}`; const scheduledAt=localToUtc(local);
      const exists=db.prepare("SELECT id FROM posts WHERE scheduled_at=? AND status NOT IN ('cancelled')").get(scheduledAt);
      if(exists) continue;
      const product=products[i]; const mode=modes[i%modes.length]; const message=await generateCaption(product,mode);
      created.push(insertPost({product,message,scheduledAt,origin:'planner',plannerType:mode,status:'draft'}));
    }
    res.json({date,timezone:TIMEZONE,created,skipped:slots.length-created.length});
  }catch(err){next(err)}
});

async function graphPost(endpoint, body) {
  const version=process.env.META_GRAPH_VERSION||'v25.0'; const pageId=process.env.META_PAGE_ID;
  const url=`https://graph.facebook.com/${version}/${pageId}/${endpoint}`;
  let response;
  try { response=await fetch(url,{method:'POST',body,signal:AbortSignal.timeout(20000)}); }
  catch(err){ const e=new Error(`Falha de rede ao chamar a Meta: ${err.message}`); e.ambiguous=true; throw e; }
  const json=await response.json().catch(()=>({}));
  if(!response.ok){ const e=new Error(json?.error?.message||`Meta API retornou HTTP ${response.status}`); e.code=json?.error?.code; e.subcode=json?.error?.error_subcode; throw e; }
  return json;
}
async function publishPost(post) {
  const meta=await validateMetaConnection(true); if(!meta.valid) throw new Error(`Conexão Meta inválida: ${meta.reason||'token/página não validados.'}`);
  const token=process.env.META_PAGE_ACCESS_TOKEN;
  if(post.imagePath&&fssync.existsSync(post.imagePath)){
    const bytes=await fs.readFile(post.imagePath); const form=new FormData(); form.append('caption',post.message); form.append('access_token',token); form.append('source',new Blob([bytes],{type:post.imageMime||'image/webp'}),path.basename(post.imagePath)); return graphPost('photos',form);
  }
  if(post.imageUrl){ const form=new URLSearchParams({url:post.imageUrl,caption:post.message,access_token:token}); return graphPost('photos',form); }
  const form=new URLSearchParams({message:post.message,access_token:token}); return graphPost('feed',form);
}
const claimTx=db.transaction((id)=>{
  const row=db.prepare('SELECT * FROM posts WHERE id=?').get(id); if(!row) throw new Error('Post não encontrado.');
  if(row.status==='published') return {already:true,post:postFromRow(row)};
  if(row.status==='publishing'){
    const lockAge=Date.now()-Date.parse(row.publish_lock_at||0); if(lockAge<PUBLISH_LOCK_MS) throw new Error('Este post já está em processo de publicação.');
  }
  if(!['approved','publishing'].includes(row.status)) throw new Error('Apenas posts aprovados podem ser publicados. Revise e aprove novamente antes de tentar.');
  const token=uuid(), now=new Date().toISOString();
  const result=db.prepare(`UPDATE posts SET status='publishing',publish_token=?,publish_lock_at=?,last_attempt_at=?,error=NULL,error_code=NULL,error_subcode=NULL,updated_at=? WHERE id=? AND (status!='publishing' OR publish_lock_at IS NULL OR publish_lock_at<?)`).run(token,now,now,now,id,new Date(Date.now()-PUBLISH_LOCK_MS).toISOString());
  if(result.changes!==1) throw new Error('Não foi possível obter o bloqueio de publicação; outra execução provavelmente já assumiu este post.');
  return {already:false,token,post:postFromRow(db.prepare('SELECT * FROM posts WHERE id=?').get(id))};
});
async function publishById(id){
  const claim=claimTx(id); if(claim.already)return claim.post;
  try{
    const result=await publishPost(claim.post); const now=new Date().toISOString();
    const done=db.transaction(()=>{
      const updated=db.prepare(`UPDATE posts SET status='published',published_at=?,meta_post_id=?,error=NULL,error_code=NULL,error_subcode=NULL,publish_token=NULL,publish_lock_at=NULL,updated_at=? WHERE id=? AND publish_token=?`).run(now,result.id||result.post_id||null,now,id,claim.token);
      if(updated.changes!==1) throw new Error('O post foi enviado à Meta, mas o estado local mudou inesperadamente. Intervenção manual necessária.');
      if(claim.post.productId) db.prepare('UPDATE products SET last_posted_at=?,updated_at=? WHERE id=?').run(now,now,claim.post.productId);
    }); done();
  }catch(err){
    const status=err.ambiguous?'needs_review':'error';
    db.prepare(`UPDATE posts SET status=?,error=?,error_code=?,error_subcode=?,publish_token=NULL,publish_lock_at=NULL,updated_at=? WHERE id=? AND publish_token=?`).run(status,err.message,String(err.code||''),String(err.subcode||''),new Date().toISOString(),id,claim.token);
    throw err;
  }
  return postFromRow(db.prepare('SELECT * FROM posts WHERE id=?').get(id));
}
app.post('/api/posts/:id/publish', auth, async (req,res)=>{try{res.json(await publishById(req.params.id))}catch(err){res.status(err.message.includes('Apenas posts aprovados')?409:502).json({error:err.message,ambiguous:Boolean(err.ambiguous)})}});

cron.schedule('* * * * *', async()=>{
  if(String(process.env.AUTO_PUBLISH).toLowerCase()!=='true')return;
  const now=new Date().toISOString();
  const due=db.prepare("SELECT id FROM posts WHERE status='approved' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at LIMIT 10").all(now);
  for(const p of due){try{await publishById(p.id)}catch(err){console.error(`[scheduler] ${p.id}:`,err.message)}}
});

app.use((err,_req,res,_next)=>{
  console.error('[error]',err);
  res.status(err.code==='LIMIT_FILE_SIZE'?413:400).json({error:err.message||'Erro inesperado.'});
});
app.listen(port,()=>{
  console.log(`Animaca Agent v0.2: http://localhost:${port}`);
  if(!process.env.APP_PASSWORD)console.error('[security] APP_PASSWORD não configurada: APIs protegidas permanecerão bloqueadas.');
});
