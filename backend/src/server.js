import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import crypto from 'crypto';

dotenv.config();
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const dbConfig = { host:process.env.DB_HOST, port:Number(process.env.DB_PORT||3306), user:process.env.DB_USER, password:process.env.DB_PASSWORD };
// decimalNumbers:true is required so DECIMAL columns (revenue, amounts, etc.) come back as
// JS numbers instead of strings like "1299.000000" — without this, every numeric value from
// MySQL is a string, which silently breaks chart auto-detection, sorting, exports and KPIs.
const pool = mysql.createPool({ ...dbConfig, database:process.env.DB_NAME, waitForConnections:true, connectionLimit:10, namedPlaceholders:true, decimalNumbers:true });

async function ensureDatabase(){
  const dbName = String(process.env.DB_NAME || 'nlqueryengine').replace(/`/g,'');
  const conn = await mysql.createConnection(dbConfig);
  try { await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``); }
  finally { await conn.end(); }
}

const allowedOrigins=(process.env.FRONTEND_URL||'http://localhost:5173').split(',').map(s=>s.trim());
app.use(cors({ origin:(origin,cb)=>{ if(!origin || allowedOrigins.includes(origin)) cb(null,true); else cb(new Error('CORS blocked')); }, credentials:true }));
app.use(express.json({limit:'2mb'}));

const roles = ['admin','manager','analyst','viewer'];

function sign(user){ return jwt.sign({id:user.id,email:user.email,role:user.role,name:user.name,avatar:user.avatar}, process.env.JWT_SECRET, {expiresIn:'8h'}); }
function auth(req,res,next){ const h=req.headers.authorization||''; if(!h.startsWith('Bearer ')) return res.status(401).json({message:'Authentication required'}); try{req.user=jwt.verify(h.slice(7),process.env.JWT_SECRET); next();}catch{return res.status(401).json({message:'Invalid or expired token'});} }
function allow(...allowed){ return (req,res,next)=> allowed.includes(req.user.role) ? next() : res.status(403).json({message:'Access denied'}); }
function avatar(name){ return name.split(/\s+/).map(w=>w[0]).join('').toUpperCase().slice(0,2); }
function safeName(name){ let n=String(name||'dataset').toLowerCase().replace(/\.csv$/,'').replace(/[^a-z0-9_]+/g,'_').replace(/^\d/,'_$&').slice(0,55); return n || `dataset_${Date.now()}`; }
function qi(id){ return '`'+String(id).replace(/`/g,'')+'`'; }
function inferType(values){ const non=values.filter(v=>v!=='' && v!=null); if(non.length && non.every(v=>/^[-+]?\d+(\.\d+)?$/.test(String(v)))) return 'number'; if(non.length && non.every(v=>!Number.isNaN(Date.parse(v)) && /[-/]/.test(String(v)))) return 'date'; return 'string'; }
function coerce(v,type){ if(type==='number') return v===''||v==null?null:Number(v); return v===undefined?null:v; }
function csvEscape(v){ const s=String(v??''); if(s.includes(',')||s.includes('"')||s.includes('\n')) return '"'+s.replace(/"/g,'""')+'"'; return s; }

// Cleans raw CSV header names into safe MySQL identifiers AND de-duplicates them.
// MySQL column names are compared case-insensitively, so "Revenue" and "revenue" would
// otherwise collide and crash CREATE TABLE / INSERT with "Duplicate column name". A CSV
// column literally named "id" is also safe here since the internal PK is `__row_id`, not `id`.
function cleanColumns(rawCols, records){
  const seen = new Map(); // lowercase name -> count
  return rawCols.map((c, i) => {
    let clean = String(c ?? '').trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^\d/, '_$&').slice(0, 60) || `column_${i + 1}`;
    const key = clean.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count > 0) clean = `${clean}_${count + 1}`.slice(0, 60);
    return { original: c, name: clean, type: inferType(records.map(r => r[c])) };
  });
}

// Ensures a dataset name is unique (datasets.name has a UNIQUE constraint) by appending
// _2, _3, ... instead of letting the insert fail with a raw MySQL duplicate-entry error.
async function uniqueDatasetName(base){
  const [existing] = await pool.query('SELECT name FROM datasets WHERE name=? OR name LIKE ?', [base, `${base}_%`]);
  const taken = new Set(existing.map(r => r.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// Inserts rows in batches using multi-row INSERT statements instead of one INSERT per row,
// which is far more reliable and far faster for larger CSV uploads.
async function bulkInsertRows(conn, tableName, columnNames, rows, chunkSize = 500){
  if (!rows.length) return;
  const cols = columnNames.map(qi).join(',');
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => `(${columnNames.map(() => '?').join(',')})`).join(',');
    const values = chunk.flat();
    await conn.query(`INSERT INTO ${qi(tableName)} (${cols}) VALUES ${placeholders}`, values);
  }
}

async function logAudit(pool, userId, action, details){
  try { await pool.query('INSERT INTO audit_logs(user_id,action,details) VALUES(?,?,?)',[userId,action,details||null]); } catch(e){ console.error('Audit log failed:',e.message); }
}

async function init(){
  await pool.query(`CREATE TABLE IF NOT EXISTS users(id INT AUTO_INCREMENT PRIMARY KEY,email VARCHAR(190) UNIQUE NOT NULL,password_hash VARCHAR(255) NOT NULL,role ENUM('admin','manager','analyst','viewer') NOT NULL,name VARCHAR(120) NOT NULL,avatar VARCHAR(10) NOT NULL,is_active TINYINT(1) DEFAULT 1,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS datasets(id INT AUTO_INCREMENT PRIMARY KEY,name VARCHAR(100) UNIQUE NOT NULL,table_name VARCHAR(100) UNIQUE NOT NULL,original_filename VARCHAR(255),row_count INT DEFAULT 0,column_count INT DEFAULT 0,created_by INT NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dataset_columns(id INT AUTO_INCREMENT PRIMARY KEY,dataset_id INT NOT NULL,name VARCHAR(190) NOT NULL,data_type ENUM('string','number','date') NOT NULL,position_no INT NOT NULL,FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dashboards(id INT AUTO_INCREMENT PRIMARY KEY,title VARCHAR(190) NOT NULL,description TEXT,dataset_id INT NOT NULL,created_by INT NOT NULL,charts JSON NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dashboard_access(dashboard_id INT NOT NULL,user_id INT NOT NULL,PRIMARY KEY(dashboard_id,user_id),FOREIGN KEY(dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dataset_requests(id INT AUTO_INCREMENT PRIMARY KEY,requested_by INT NOT NULL,description TEXT NOT NULL,status ENUM('pending','approved','rejected') DEFAULT 'pending',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(requested_by) REFERENCES users(id) ON DELETE CASCADE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS query_history(id INT AUTO_INCREMENT PRIMARY KEY,user_id INT NOT NULL,dataset_id INT NOT NULL,natural_query TEXT NOT NULL,sql_text TEXT NOT NULL,row_count INT DEFAULT 0,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS saved_queries(id INT AUTO_INCREMENT PRIMARY KEY,name VARCHAR(190) NOT NULL,natural_query TEXT NOT NULL,dataset_id INT NOT NULL,sql_text TEXT NOT NULL,visualization_type VARCHAR(30) DEFAULT 'table',created_by INT NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs(id INT AUTO_INCREMENT PRIMARY KEY,user_id INT,action VARCHAR(100) NOT NULL,details TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL)`);

  try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active TINYINT(1) DEFAULT 1'); } catch(e){}
  try { await pool.query('ALTER TABLE saved_queries ADD COLUMN IF NOT EXISTS visualization_type VARCHAR(30) DEFAULT "table"'); } catch(e){}

  const [u]=await pool.query('SELECT COUNT(*) c FROM users');
  if(u[0].c===0){
    const seed=[
      ['admin@nlquery.io','admin123','admin','Alex Admin'],
      ['manager@nlquery.io','mgr123','manager','Maya Manager'],
      ['analyst@nlquery.io','ana123','analyst','Ari Analyst'],
      ['viewer@nlquery.io','view123','viewer','Val Viewer']
    ];
    for(const [email,pw,role,name] of seed)
      await pool.query('INSERT INTO users(email,password_hash,role,name,avatar) VALUES(?,?,?,?,?)',[email,await bcrypt.hash(pw,12),role,name,avatar(name)]);
  }
  await seedDemoData();
}

async function seedDemoData(){
  const [existing]=await pool.query('SELECT COUNT(*) c FROM datasets');
  if(existing[0].c>0) return;
  const demos=[
    {name:'sales_data',cols:[['product','string'],['date','date'],['region','string'],['revenue','number'],['units','number'],['customer_id','number']],rows:[['Laptop Pro','2024-01-15','California',1299,1,101],['Wireless Mouse','2024-01-20','Texas',29,5,102],['Monitor 4K','2024-02-01','California',599,2,103],['Keyboard Mech','2024-02-15','New York',149,3,101],['Laptop Pro','2024-03-01','Texas',1299,1,104],['Webcam HD','2024-03-10','California',79,4,105],['Monitor 4K','2024-03-20','New York',599,1,102],['Laptop Pro','2024-04-01','California',1299,2,103],['Wireless Mouse','2024-04-15','California',29,10,106],['Keyboard Mech','2024-05-01','Texas',149,2,104]]},
    {name:'customer_data',cols:[['name','string'],['email','string'],['state','string'],['total_orders','number'],['lifetime_value','number']],rows:[['Acme Corp','acme@corp.com','California',15,8750],['Beta LLC','beta@llc.com','Texas',8,3200],['Gamma Inc','gamma@inc.com','California',22,15600],['Delta Co','delta@co.com','Texas',5,2100],['Epsilon Ltd','epsilon@ltd.com','New York',12,6800],['Zeta Corp','zeta@corp.com','California',30,21000]]},
    {name:'orders_data',cols:[['order_id','number'],['customer_id','number'],['product','string'],['amount','number'],['status','string'],['date','date']],rows:[[1001,101,'Laptop Pro',5196,'completed','2024-01-15'],[1002,102,'Wireless Mouse',145,'completed','2024-01-20'],[1003,103,'Monitor 4K',1198,'pending','2024-02-01'],[1004,104,'Keyboard Mech',298,'completed','2024-02-15'],[1005,105,'Laptop Pro',1299,'completed','2024-03-01'],[1006,106,'Webcam HD',316,'cancelled','2024-03-10']]}
  ];
  const conn=await pool.getConnection();
  try{ await conn.beginTransaction(); const ids={};
    for(const d of demos){
      const table=`data_${d.name}_${crypto.randomBytes(3).toString('hex')}`;
      const [r]=await conn.query('INSERT INTO datasets(name,table_name,original_filename,row_count,column_count,created_by) VALUES(?,?,?,?,?,1)',[d.name,table,`${d.name}.csv`,d.rows.length,d.cols.length]);
      ids[d.name]=r.insertId;
      const colDefs=d.cols.map(c=>`${qi(c[0])} ${c[1]==='number'?'DECIMAL(24,6) NULL':c[1]==='date'?'VARCHAR(64) NULL':'TEXT NULL'}`).join(',');
      await conn.query(`CREATE TABLE ${qi(table)} (__row_id BIGINT AUTO_INCREMENT PRIMARY KEY, ${colDefs})`);
      for(let i=0;i<d.cols.length;i++) await conn.query('INSERT INTO dataset_columns(dataset_id,name,data_type,position_no) VALUES(?,?,?,?)',[r.insertId,d.cols[i][0],d.cols[i][1],i]);
      for(const row of d.rows){
        const vals=row.map((v,i)=>coerce(v,d.cols[i][1]));
        await conn.query(`INSERT INTO ${qi(table)} (${d.cols.map(c=>qi(c[0])).join(',')}) VALUES (${d.cols.map(()=>'?').join(',')})`,vals);
      }
    }
    const charts=JSON.stringify([{type:'bar',xKey:'product',yKey:'revenue',title:'Revenue by Product'},{type:'pie',labelKey:'region',valueKey:'revenue',title:'Revenue by Region'}]);
    const [dr]=await conn.query('INSERT INTO dashboards(title,description,dataset_id,created_by,charts) VALUES(?,?,?,?,?)',['Sales Overview','Monthly sales performance breakdown',ids.sales_data,3,charts]);
    await conn.query('INSERT INTO dashboard_access(dashboard_id,user_id) VALUES (?,?),(?,?)',[dr.insertId,2,dr.insertId,4]);
    await conn.query('INSERT INTO dataset_requests(requested_by,description,status) VALUES(?,?,?),(?,?,?)',[2,'Upload Q2 sales dataset','pending',3,'Need customer churn data','pending']);
    await conn.commit();
  }catch(e){await conn.rollback(); throw e;}finally{conn.release();}
}


app.get('/api/health', async(req,res)=>{ try{await pool.query('SELECT 1'); res.json({ok:true,service:'NLQueryEngine API',database:'mysql'});}catch(e){res.status(503).json({ok:false,message:e.message});} });

app.post('/api/auth/login',async(req,res)=>{
  const {email,password}=req.body||{};
  const [rows]=await pool.query('SELECT id,email,password_hash,role,name,avatar,is_active FROM users WHERE email=? LIMIT 1',[email]);
  const u=rows[0];
  if(!u) return res.status(401).json({message:'Invalid credentials'});
  if(!u.is_active) return res.status(403).json({message:'Account is deactivated'});
  if(!(await bcrypt.compare(password||'',u.password_hash))) return res.status(401).json({message:'Invalid credentials'});
  await logAudit(pool,u.id,'login','User logged in');
  res.json({token:sign(u),user:{id:u.id,email:u.email,role:u.role,name:u.name,avatar:u.avatar}});
});

app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));

app.post('/api/auth/change-password',auth,async(req,res)=>{
  try{
    const {currentPassword,newPassword}=req.body||{};
    if(!currentPassword||!newPassword) return res.status(400).json({message:'Current and new password are required'});
    if(newPassword.length<6) return res.status(400).json({message:'New password must be at least 6 characters'});
    const [rows]=await pool.query('SELECT password_hash FROM users WHERE id=?',[req.user.id]);
    if(!rows[0]||!(await bcrypt.compare(currentPassword,rows[0].password_hash))) return res.status(400).json({message:'Current password is incorrect'});
    await pool.query('UPDATE users SET password_hash=? WHERE id=?',[await bcrypt.hash(newPassword,12),req.user.id]);
    await logAudit(pool,req.user.id,'password_change','User changed their password');
    res.json({message:'Password updated successfully'});
  }catch(e){res.status(500).json({message:e.message});}
});


async function datasetList(){
  const [ds]=await pool.query('SELECT * FROM datasets ORDER BY created_at DESC');
  const out={};
  for(const d of ds){
    const [cols]=await pool.query('SELECT name,data_type FROM dataset_columns WHERE dataset_id=? ORDER BY position_no',[d.id]);
    const names=cols.map(c=>c.name);
    try {
      const select=names.length?names.map(qi).join(','):'*';
      const [rows]=await pool.query(`SELECT ${select} FROM ${qi(d.table_name)} LIMIT 1000`);
      out[d.name]={id:d.id,name:d.name,columns:names,columnTypes:cols.map(c=>({name:c.name,type:c.data_type})),rows,rowCount:d.row_count,columnCount:d.column_count,originalFilename:d.original_filename,createdBy:d.created_by,createdAt:d.created_at};
    } catch(e) { console.error(`Dataset ${d.name} could not be loaded:`,e.message); }
  }
  return out;
}

app.get('/api/datasets',auth,async(req,res)=>{try{res.json({datasets:await datasetList()});}catch(e){res.status(500).json({message:e.message});}});

function parseCsvUpload(file){
  if(!file) throw Object.assign(new Error('No file was uploaded'),{status:400});
  if(!file.originalname.toLowerCase().endsWith('.csv')) throw Object.assign(new Error('Only CSV files are supported'),{status:400});
  let records;
  try{ records=parse(file.buffer.toString('utf8'),{columns:true,skip_empty_lines:true,trim:true,relax_column_count:true}); }
  catch(e){ throw Object.assign(new Error('Could not parse CSV file: '+e.message),{status:400}); }
  if(!records.length) throw Object.assign(new Error('CSV contains no data rows'),{status:400});
  const rawCols=Object.keys(records[0]);
  if(!rawCols.length) throw Object.assign(new Error('CSV has no columns'),{status:400});
  const columns=cleanColumns(rawCols,records);
  return {records,rawCols,columns};
}

app.post('/api/datasets/preview',auth,allow('admin'),upload.single('file'),async(req,res)=>{
  try{
    const {records,columns}=parseCsvUpload(req.file);
    const base=safeName(req.file.originalname);
    const sampleRows=records.slice(0,5).map(r=>{const row={}; for(const c of columns) row[c.name]=r[c.original]??''; return row;});
    const nullCounts={}; for(const c of columns){ nullCounts[c.name]=records.filter(r=>r[c.original]===''||r[c.original]==null).length; }
    res.json({fileName:req.file.originalname,datasetName:base,rowCount:records.length,columnCount:columns.length,columns:nullCounts,sampleRows,columnDetails:columns,nullCounts});
  }catch(e){res.status(e.status||400).json({message:e.message});}
});

app.post('/api/datasets/upload',auth,allow('admin'),upload.single('file'),async(req,res)=>{
  try{
    const {records,columns}=parseCsvUpload(req.file);
    const base=await uniqueDatasetName(safeName(req.file.originalname));
    const tableName=`data_${base}_${crypto.randomBytes(3).toString('hex')}`;
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      const [d]=await conn.query('INSERT INTO datasets(name,table_name,original_filename,row_count,column_count,created_by) VALUES(?,?,?,?,?,?)',[base,tableName,req.file.originalname,records.length,columns.length,req.user.id]);
      const defs=columns.map(c=>`${qi(c.name)} ${c.type==='number'?'DECIMAL(24,6) NULL':c.type==='date'?'VARCHAR(64) NULL':'TEXT NULL'}`).join(',');
      await conn.query(`CREATE TABLE ${qi(tableName)} (__row_id BIGINT AUTO_INCREMENT PRIMARY KEY, ${defs})`);
      for(let i=0;i<columns.length;i++) await conn.query('INSERT INTO dataset_columns(dataset_id,name,data_type,position_no) VALUES(?,?,?,?)',[d.insertId,columns[i].name,columns[i].type,i]);
      const names=columns.map(c=>c.name);
      const rows=records.map(r=>columns.map(c=>coerce(r[c.original],c.type)));
      await bulkInsertRows(conn,tableName,names,rows);
      await conn.commit();
      await logAudit(pool,req.user.id,'dataset_upload',`Uploaded dataset "${base}" with ${records.length} rows`);
      const [freshRows]=await pool.query(`SELECT ${names.map(qi).join(',')} FROM ${qi(tableName)} LIMIT 1000`);
      res.status(201).json({message:`Dataset "${base}" uploaded`,dataset:{id:d.insertId,name:base,columns:names,columnTypes:columns.map(c=>({name:c.name,type:c.type})),rows:freshRows,rowCount:records.length,columnCount:columns.length,originalFilename:req.file.originalname,createdBy:req.user.id}});
    }catch(e){await conn.rollback(); throw e;}finally{conn.release();}
  }catch(e){res.status(e.status||400).json({message:e.code==='ER_DUP_ENTRY'?'A dataset with this name already exists':e.message});}
});

app.get('/api/datasets/:id/profile',auth,async(req,res)=>{
  try{
    const [ds]=await pool.query('SELECT * FROM datasets WHERE id=?',[req.params.id]);
    if(!ds[0]) return res.status(404).json({message:'Dataset not found'});
    const d=ds[0];
    const [cols]=await pool.query('SELECT name,data_type FROM dataset_columns WHERE dataset_id=? ORDER BY position_no',[d.id]);
    const profile={name:d.name,tableName:d.table_name,rowCount:d.row_count,columnCount:d.column_count,columns:[]};
    for(const c of cols){
      const col={name:c.name,type:c.data_type,nullCount:0,distinctCount:0,min:null,max:null,avg:null,sampleValues:[]};
      try{
        const [nullRes]=await pool.query(`SELECT COUNT(*) c FROM ${qi(d.table_name)} WHERE ${qi(c.name)} IS NULL OR ${qi(c.name)}=''`);
        col.nullCount=nullRes[0].c;
        const [distinctRes]=await pool.query(`SELECT COUNT(DISTINCT ${qi(c.name)}) c FROM ${qi(d.table_name)}`);
        col.distinctCount=distinctRes[0].c;
        if(c.data_type==='number'){
          const [stats]=await pool.query(`SELECT MIN(${qi(c.name)}) mn, MAX(${qi(c.name)}) mx, AVG(${qi(c.name)}) av FROM ${qi(d.table_name)} WHERE ${qi(c.name)} IS NOT NULL`);
          col.min=stats[0].mn; col.max=stats[0].mx; col.avg=stats[0].av?Number(stats[0].av).toFixed(2):null;
        }
        const [samples]=await pool.query(`SELECT ${qi(c.name)} FROM ${qi(d.table_name)} WHERE ${qi(c.name)} IS NOT NULL AND ${qi(c.name)}!='' LIMIT 5`);
        col.sampleValues=samples.map(s=>s[c.name]);
      }catch(e){}
      profile.columns.push(col);
    }
    const [sampleRows]=await pool.query(`SELECT ${cols.map(c=>qi(c.name)).join(',')} FROM ${qi(d.table_name)} LIMIT 5`);
    profile.sampleRows=sampleRows;
    res.json({profile});
  }catch(e){res.status(500).json({message:e.message});}
});

app.delete('/api/datasets/:id',auth,allow('admin'),async(req,res)=>{
  try{
    const [ds]=await pool.query('SELECT * FROM datasets WHERE id=?',[req.params.id]);
    if(!ds[0]) return res.status(404).json({message:'Dataset not found'});
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      await conn.query(`DROP TABLE IF EXISTS ${qi(ds[0].table_name)}`);
      await conn.query('DELETE FROM datasets WHERE id=?',[req.params.id]);
      await conn.commit();
      await logAudit(pool,req.user.id,'dataset_delete',`Deleted dataset "${ds[0].name}"`);
      res.json({message:'Dataset deleted'});
    }catch(e){await conn.rollback(); throw e;}finally{conn.release();}
  }catch(e){res.status(500).json({message:e.message});}
});


function buildNLQuery(query,dataset,columns){
  const q=query.toLowerCase().replace(/\s+/g,' ').trim();
  const cols=columns.map(c=>c.name);
  const numCols=cols.filter(c=>columns.find(x=>x.name===c&&x.data_type==='number'));
  const strCols=cols.filter(c=>columns.find(x=>x.name===c&&x.data_type==='string'));

  const findCol=(words)=>cols.find(c=>words.some(w=>c.toLowerCase()===w||c.toLowerCase().includes(w)));
  const num=findCol(['revenue','amount','lifetime_value','total_orders','units','value','price','sales','count','total','quantity']);
  // Explicit "group by <column>" / "grouped by <column>" / "by <column>" phrasing takes
  // priority over the keyword-based guess below, so "sum of revenue by region" groups by
  // region even though "region" isn't in the generic keyword list.
  const dateCol=findCol(['date','created_at','order_date','timestamp']);
  const explicitGroupM=q.match(/(?:group(?:ed)?\s+by|\bby)\s+([a-z0-9_ ]+?)(?:\s*$|\s+and\b|\s+or\b|\s+for\b)/);
  const explicitGroup=explicitGroupM && cols.find(c=>c.toLowerCase()===explicitGroupM[1].trim()||explicitGroupM[1].trim().includes(c.toLowerCase()));
  const group=explicitGroup||findCol(['product','region','state','status','category','customer','name','type','department']);

  let select='*', explanation='Showing matching rows.';

  if(/top\s+\d+|first\s+\d+|highest\s+\d+/.test(q)){
    const topN=(q.match(/(?:top|first|highest)\s+(\d+)/)||[])[1]||10;
    if(group&&num){select=`${qi(group)}, SUM(${qi(num)}) AS total_${num}`; explanation=`Top ${topN} ${group} values by total ${num}.`;}
    else if(num){select=`${qi(num)}`; explanation=`Top ${topN} values of ${num}.`;}
  } else if(/average|avg|mean/.test(q)&&num){select=`AVG(${qi(num)}) AS average_${num}`; explanation=`Average ${num}.`;}
  else if(/\bsum\b|total\b/.test(q)&&num){select=`SUM(${qi(num)}) AS total_${num}`; explanation=`Total ${num}.`;}
  else if(/count|how many|number of/.test(q)){select=`COUNT(*) AS count`; explanation='Count of matching rows.';}
  else if(/minimum|min\b|lowest|smallest/.test(q)&&num){select=`MIN(${qi(num)}) AS min_${num}`; explanation=`Minimum ${num}.`;}
  else if(/maximum|max\b|highest|largest/.test(q)&&num){select=`MAX(${qi(num)}) AS max_${num}`; explanation=`Maximum ${num}.`;}

  let where=[];
  for(const c of cols){
    const lc=c.toLowerCase().replace(/_/g,' ');
    const escVal=(v)=>{ if(/^\d+(\.\d+)?$/.test(v)) return Number(v); return mysql.escape(v.trim()); };
    const eqM=q.match(new RegExp(`(?:${lc}|${c.toLowerCase()})\\s*(?:is|=|equals?|equal to)\\s*["']?([^"'\n]+?)["']?(?:\\s+and\\s+|\\s+or\\s+|$)`));
    if(eqM&&eqM[1]) where.push(`${qi(c)} = ${escVal(eqM[1])}`);
    const gtM=q.match(new RegExp(`(?:${lc}|${c.toLowerCase()})\\s*(?:greater than|above|over|>)\\s*(\\d+(?:\\.\\d+)?)`));
    if(gtM) where.push(`${qi(c)} > ${Number(gtM[1])}`);
    const ltM=q.match(new RegExp(`(?:${lc}|${c.toLowerCase()})\\s*(?:less than|below|under|<)\\s*(\\d+(?:\\.\\d+)?)`));
    if(ltM) where.push(`${qi(c)} < ${Number(ltM[1])}`);
    const btM=q.match(new RegExp(`(?:${lc}|${c.toLowerCase()})\\s+between\\s+(\\d+(?:\\.\\d+)?)\\s+and\\s+(\\d+(?:\\.\\d+)?)`));
    if(btM) where.push(`${qi(c)} BETWEEN ${Number(btM[1])} AND ${Number(btM[2])}`);
    if(strCols.includes(c)){
      const lkM=q.match(new RegExp(`(?:${lc}|${c.toLowerCase()})\\s*(?:contains?|like|includes)\\s*["']([^"']+)["']`));
      if(lkM) where.push(`${qi(c)} LIKE ${mysql.escape('%'+lkM[1]+'%')}`);
    }
  }
  for(const c of ['state','region']){
    if(cols.map(x=>x.toLowerCase()).includes(c)){
      const m=q.match(new RegExp(`(?:from|in)\\s+([a-z][a-z0-9 _-]+?)(?:\\s*$|\\s+and|\\s+or)`));
      if(m&&m[1]&&!/dataset|table|data|result|show|get|find|all|the/.test(m[1]))
        where.push(`${qi(c)} = ${mysql.escape(m[1].trim())}`);
    }
  }
  if(/completed/.test(q)&&cols.includes('status')) where.push(`${qi('status')} = 'completed'`);
  if(/\bpending\b/.test(q)&&cols.includes('status')) where.push(`${qi('status')} = 'pending'`);
  if(/cancelled|canceled/.test(q)&&cols.includes('status')) where.push(`${qi('status')} = 'cancelled'`);

  // Date filters: "in 2024", "after 2024-01-01", "before March 2024", "since 2024-01-01"
  if(dateCol){
    const yearM=q.match(/\bin\s+(19|20)\d{2}\b/);
    if(yearM) where.push(`${qi(dateCol)} LIKE ${mysql.escape(yearM[0].replace(/^in\s+/,'')+'%')}`);
    const afterM=q.match(/(?:after|since)\s+(\d{4}-\d{2}-\d{2})/);
    if(afterM) where.push(`${qi(dateCol)} >= ${mysql.escape(afterM[1])}`);
    const beforeM=q.match(/before\s+(\d{4}-\d{2}-\d{2})/);
    if(beforeM) where.push(`${qi(dateCol)} <= ${mysql.escape(beforeM[1])}`);
  }

  let sql=`SELECT ${select} FROM ${qi(dataset.table_name)}`;
  if(where.length) sql+=` WHERE ${where.join(' AND ')}`;
  if(select.includes('SUM(')&&group) sql+=` GROUP BY ${qi(group)} ORDER BY total_${num} DESC`;
  else if(num&&/highest|largest|most|top|best/.test(q)) sql+=` ORDER BY ${qi(num)} DESC`;
  else if(num&&/lowest|least|worst|bottom/.test(q)) sql+=` ORDER BY ${qi(num)} ASC`;
  if(/top\s+\d+|first\s+\d+|highest\s+\d+/.test(q)){
    const topN=Number((q.match(/(?:top|first|highest)\s+(\d+)/)||[])[1]||10);
    sql+=` LIMIT ${Math.min(topN,100)}`;
  } else if(!/count|average|avg|mean|sum|total|minimum|min|max|maximum/.test(q)) sql+=' LIMIT 100';

  return {sql,explanation};
}

function isSafeSelect(sql){
  if(!/^\s*SELECT\b/i.test(sql)) return false;
  if(/[;]\s*\S|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT|REVOKE|CALL|LOAD|OUTFILE|INFILE)\b/i.test(sql)) return false;
  return true;
}

// A SELECT can be syntactically "safe" (no destructive keywords) and still leak data it has
// no business leaking — e.g. `SELECT password_hash FROM users`. Only allow SELECTs whose
// FROM/JOIN targets are actual user dataset tables, never internal tables like users/audit_logs.
async function referencesOnlyDatasetTables(sql){
  const [ds]=await pool.query('SELECT table_name FROM datasets');
  const allowed=new Set(ds.map(d=>d.table_name));
  const refs=[...sql.matchAll(/\b(?:FROM|JOIN)\s+`?([a-zA-Z0-9_]+)`?/gi)].map(m=>m[1]);
  if(!refs.length) return false;
  return refs.every(t=>allowed.has(t));
}

app.post('/api/query',auth,allow('admin','manager','analyst'),async(req,res)=>{
  try{
    const {query,dataset}=req.body||{};
    if(!query?.trim()||!dataset) return res.status(400).json({message:'Query and dataset are required'});
    const [dsRows]=await pool.query('SELECT * FROM datasets WHERE name=? LIMIT 1',[dataset]);
    const ds=dsRows[0];
    if(!ds) return res.status(404).json({message:'Dataset not found'});
    const [cols]=await pool.query('SELECT name,data_type FROM dataset_columns WHERE dataset_id=? ORDER BY position_no',[ds.id]);
    const built=buildNLQuery(query,ds,cols);
    if(!isSafeSelect(built.sql)) return res.status(400).json({message:'Generated query was blocked for safety'});
    const [rows]=await pool.query(built.sql);
    await pool.query('INSERT INTO query_history(user_id,dataset_id,natural_query,sql_text,row_count) VALUES(?,?,?,?,?)',[req.user.id,ds.id,query,built.sql,rows.length]);
    await logAudit(pool,req.user.id,'query_execution',`Query on "${dataset}": "${query}"`);
    res.json({sql:built.sql,explanation:built.explanation,rows,rowCount:rows.length,createdAt:new Date().toISOString()});
  }catch(e){res.status(400).json({message:e.message});}
});

app.get('/api/query-history',auth,allow('admin','manager','analyst'),async(req,res)=>{
  const [rows]=await pool.query('SELECT q.id,q.natural_query AS query_text,q.sql_text AS sql_text,q.row_count AS row_count,d.name AS dataset,q.created_at AS ts FROM query_history q JOIN datasets d ON d.id=q.dataset_id WHERE q.user_id=? ORDER BY q.created_at DESC LIMIT 50',[req.user.id]);
  res.json({history:rows});
});


app.get('/api/saved-queries',auth,async(req,res)=>{
  const [rows]=await pool.query('SELECT sq.*,d.name AS dataset_name FROM saved_queries sq JOIN datasets d ON d.id=sq.dataset_id WHERE sq.created_by=? ORDER BY sq.created_at DESC',[req.user.id]);
  res.json({savedQueries:rows});
});

app.post('/api/saved-queries',auth,allow('admin','manager','analyst'),async(req,res)=>{
  try{
    const {name,naturalQuery,dataset,sql:sqlText,visualizationType='table'}=req.body||{};
    if(!name?.trim()||!naturalQuery?.trim()||!dataset||!sqlText) return res.status(400).json({message:'Name, query, dataset, and SQL are required'});
    const [ds]=await pool.query('SELECT id FROM datasets WHERE name=?',[dataset]);
    if(!ds[0]) return res.status(404).json({message:'Dataset not found'});
    const [r]=await pool.query('INSERT INTO saved_queries(name,natural_query,dataset_id,sql_text,visualization_type,created_by) VALUES(?,?,?,?,?,?)',[name.trim(),naturalQuery,ds[0].id,sqlText,visualizationType,req.user.id]);
    await logAudit(pool,req.user.id,'saved_query',`Saved query "${name}"`);
    res.status(201).json({id:r.insertId,message:'Query saved'});
  }catch(e){res.status(400).json({message:e.message});}
});

app.delete('/api/saved-queries/:id',auth,async(req,res)=>{
  try{
    const [sq]=await pool.query('SELECT * FROM saved_queries WHERE id=?',[req.params.id]);
    if(!sq[0]) return res.status(404).json({message:'Saved query not found'});
    if(sq[0].created_by!==req.user.id&&req.user.role!=='admin') return res.status(403).json({message:'Access denied'});
    await pool.query('DELETE FROM saved_queries WHERE id=?',[req.params.id]);
    res.json({message:'Saved query deleted'});
  }catch(e){res.status(500).json({message:e.message});}
});


app.get('/api/users',auth,allow('admin'),async(req,res)=>{
  const [rows]=await pool.query('SELECT id,email,role,name,avatar,is_active,created_at FROM users ORDER BY id');
  res.json({users:rows});
});

app.post('/api/users',auth,allow('admin'),async(req,res)=>{
  try{
    const {email,password,role='viewer',name}=req.body;
    if(!email||!name||!password||!roles.includes(role)) return res.status(400).json({message:'Name, email, password and valid role are required'});
    if(password.length<6) return res.status(400).json({message:'Password must be at least 6 characters'});
    const [r]=await pool.query('INSERT INTO users(email,password_hash,role,name,avatar) VALUES(?,?,?,?,?)',[email,await bcrypt.hash(password,12),role,name,avatar(name)]);
    const [u]=await pool.query('SELECT id,email,role,name,avatar,is_active FROM users WHERE id=?',[r.insertId]);
    await logAudit(pool,req.user.id,'user_created',`Created user "${name}" (${email}) with role ${role}`);
    res.status(201).json({user:u[0]});
  }catch(e){res.status(400).json({message:e.code==='ER_DUP_ENTRY'?'Email already exists':e.message});}
});

app.patch('/api/users/:id/role',auth,allow('admin'),async(req,res)=>{
  try{
    const {role}=req.body;
    if(!roles.includes(role)) return res.status(400).json({message:'Invalid role'});
    const [existing]=await pool.query('SELECT role FROM users WHERE id=?',[req.params.id]);
    if(!existing[0]) return res.status(404).json({message:'User not found'});
    if(existing[0].role==='admin'&&role!=='admin'){
      const [adminCount]=await pool.query('SELECT COUNT(*) c FROM users WHERE role="admin"');
      if(adminCount[0].c<=1) return res.status(400).json({message:'Cannot remove the last admin'});
    }
    await pool.query('UPDATE users SET role=? WHERE id=?',[role,req.params.id]);
    await logAudit(pool,req.user.id,'user_role_change',`Changed user ${req.params.id} role to ${role}`);
    res.json({message:'Role updated'});
  }catch(e){res.status(500).json({message:e.message});}
});

app.patch('/api/users/:id/status',auth,allow('admin'),async(req,res)=>{
  try{
    if(Number(req.params.id)===req.user.id) return res.status(400).json({message:'Cannot deactivate your own account'});
    const {is_active}=req.body;
    const [existing]=await pool.query('SELECT role FROM users WHERE id=?',[req.params.id]);
    if(!existing[0]) return res.status(404).json({message:'User not found'});
    if(existing[0].role==='admin'&&!is_active){
      const [adminCount]=await pool.query('SELECT COUNT(*) c FROM users WHERE role="admin" AND is_active=1');
      if(adminCount[0].c<=1) return res.status(400).json({message:'Cannot deactivate the last active admin'});
    }
    await pool.query('UPDATE users SET is_active=? WHERE id=?',[is_active?1:0,req.params.id]);
    await logAudit(pool,req.user.id,'user_status_change',`User ${req.params.id} ${is_active?'activated':'deactivated'}`);
    res.json({message:is_active?'User activated':'User deactivated'});
  }catch(e){res.status(500).json({message:e.message});}
});

app.post('/api/users/:id/reset-password',auth,allow('admin'),async(req,res)=>{
  try{
    const {newPassword}=req.body||{};
    if(!newPassword||newPassword.length<6) return res.status(400).json({message:'Password must be at least 6 characters'});
    await pool.query('UPDATE users SET password_hash=? WHERE id=?',[await bcrypt.hash(newPassword,12),req.params.id]);
    await logAudit(pool,req.user.id,'password_reset',`Reset password for user ${req.params.id}`);
    res.json({message:'Password reset successfully'});
  }catch(e){res.status(500).json({message:e.message});}
});

app.delete('/api/users/:id',auth,allow('admin'),async(req,res)=>{
  try{
    if(Number(req.params.id)===req.user.id) return res.status(400).json({message:'You cannot remove your own account'});
    const [existing]=await pool.query('SELECT role FROM users WHERE id=?',[req.params.id]);
    if(!existing[0]) return res.status(404).json({message:'User not found'});
    if(existing[0].role==='admin'){
      const [adminCount]=await pool.query('SELECT COUNT(*) c FROM users WHERE role="admin"');
      if(adminCount[0].c<=1) return res.status(400).json({message:'Cannot delete the last admin'});
    }
    await pool.query('DELETE FROM users WHERE id=?',[req.params.id]);
    await logAudit(pool,req.user.id,'user_delete',`Deleted user ${req.params.id}`);
    res.json({message:'User removed'});
  }catch(e){res.status(500).json({message:e.message});}
});


app.get('/api/requests',auth,async(req,res)=>{
  const where=req.user.role==='admin'?'':'WHERE r.requested_by=?';
  const args=req.user.role==='admin'?[]:[req.user.id];
  const [rows]=await pool.query(`SELECT r.id,r.requested_by requestedBy,r.description,r.status,DATE_FORMAT(r.created_at,'%Y-%m-%d') date,u.name requester FROM dataset_requests r JOIN users u ON u.id=r.requested_by ${where} ORDER BY r.created_at DESC`,args);
  res.json({requests:rows});
});

app.post('/api/requests',auth,async(req,res)=>{
  try{
    const {description}=req.body;
    if(!description?.trim()) return res.status(400).json({message:'Description is required'});
    const [r]=await pool.query('INSERT INTO dataset_requests(requested_by,description) VALUES(?,?)',[req.user.id,description]);
    await logAudit(pool,req.user.id,'request_submit',`Submitted request: "${description.slice(0,50)}"`);
    res.status(201).json({id:r.insertId,message:'Request submitted successfully'});
  }catch(e){res.status(500).json({message:e.message});}
});

app.patch('/api/requests/:id/status',auth,allow('admin'),async(req,res)=>{
  try{
    if(!['approved','rejected','pending'].includes(req.body.status)) return res.status(400).json({message:'Invalid status'});
    await pool.query('UPDATE dataset_requests SET status=? WHERE id=?',[req.body.status,req.params.id]);
    await logAudit(pool,req.user.id,'request_status',`Request ${req.params.id} ${req.body.status}`);
    res.json({message:`Request ${req.body.status}`});
  }catch(e){res.status(500).json({message:e.message});}
});


app.get('/api/dashboards',auth,async(req,res)=>{
  const [ds]=await pool.query('SELECT id,name,table_name FROM datasets');
  const map=Object.fromEntries(ds.map(d=>[d.id,d]));
  const [rows]=await pool.query('SELECT * FROM dashboards ORDER BY created_at DESC');
  const out=[];
  for(const d of rows){
    const [access]=await pool.query('SELECT user_id FROM dashboard_access WHERE dashboard_id=?',[d.id]);
    const visible=req.user.role==='admin'||d.created_by===req.user.id||access.some(a=>a.user_id===req.user.id);
    if(visible) out.push({id:d.id,title:d.title,description:d.description,dataset:map[d.dataset_id]?.name,createdBy:d.created_by,charts:typeof d.charts==='string'?JSON.parse(d.charts):d.charts,access:access.map(a=>a.user_id),createdAt:d.created_at,updatedAt:d.updated_at});
  }
  res.json({dashboards:out});
});

app.post('/api/dashboards',auth,allow('analyst','admin'),async(req,res)=>{
  try{
    const {title,description='',dataset,charts=[],access=[]}=req.body;
    const [ds]=await pool.query('SELECT id FROM datasets WHERE name=?',[dataset]);
    if(!ds[0]) return res.status(404).json({message:'Dataset not found'});
    if(!title||!charts.length) return res.status(400).json({message:'Title and at least one chart are required'});
    const [r]=await pool.query('INSERT INTO dashboards(title,description,dataset_id,created_by,charts) VALUES(?,?,?,?,?)',[title,description,ds[0].id,req.user.id,JSON.stringify(charts)]);
    for(const uid of access) await pool.query('INSERT IGNORE INTO dashboard_access(dashboard_id,user_id) VALUES(?,?)',[r.insertId,uid]);
    await logAudit(pool,req.user.id,'dashboard_create',`Created dashboard "${title}"`);
    res.status(201).json({message:'Dashboard created',id:r.insertId});
  }catch(e){res.status(400).json({message:e.message});}
});

app.put('/api/dashboards/:id',auth,allow('analyst','admin'),async(req,res)=>{
  try{
    const {title,description='',dataset,charts=[],access=[]}=req.body;
    if(!title||!charts.length) return res.status(400).json({message:'Title and at least one chart are required'});
    const [d]=await pool.query('SELECT * FROM dashboards WHERE id=?',[req.params.id]);
    if(!d[0]) return res.status(404).json({message:'Dashboard not found'});
    if(d[0].created_by!==req.user.id&&req.user.role!=='admin') return res.status(403).json({message:'Access denied'});
    const [ds]=await pool.query('SELECT id FROM datasets WHERE name=?',[dataset]);
    if(!ds[0]) return res.status(404).json({message:'Dataset not found'});
    await pool.query('UPDATE dashboards SET title=?,description=?,dataset_id=?,charts=? WHERE id=?',[title,description,ds[0].id,JSON.stringify(charts),req.params.id]);
    await pool.query('DELETE FROM dashboard_access WHERE dashboard_id=?',[req.params.id]);
    for(const uid of access) await pool.query('INSERT IGNORE INTO dashboard_access(dashboard_id,user_id) VALUES(?,?)',[req.params.id,uid]);
    await logAudit(pool,req.user.id,'dashboard_update',`Updated dashboard "${title}"`);
    res.json({message:'Dashboard updated'});
  }catch(e){res.status(400).json({message:e.message});}
});

app.delete('/api/dashboards/:id',auth,async(req,res)=>{
  try{
    const [d]=await pool.query('SELECT * FROM dashboards WHERE id=?',[req.params.id]);
    if(!d[0]) return res.status(404).json({message:'Dashboard not found'});
    if(d[0].created_by!==req.user.id&&req.user.role!=='admin') return res.status(403).json({message:'Access denied'});
    await pool.query('DELETE FROM dashboards WHERE id=?',[req.params.id]);
    await logAudit(pool,req.user.id,'dashboard_delete',`Deleted dashboard "${d[0].title}"`);
    res.json({message:'Dashboard deleted'});
  }catch(e){res.status(500).json({message:e.message});}
});

app.get('/api/dashboard-templates',auth,async(req,res)=>{
  const templates=[
    {name:'Sales Dashboard',description:'Track revenue, orders, and sales performance',charts:[{type:'kpi',title:'Total Revenue',metric:'revenue',aggregation:'sum'},{type:'kpi',title:'Total Orders',metric:'order_count',aggregation:'count'},{type:'bar',title:'Revenue by Product',xKey:'product',yKey:'revenue'},{type:'pie',title:'Revenue by Region',labelKey:'region',valueKey:'revenue'},{type:'line',title:'Sales Trend',xKey:'date',yKey:'revenue'}]},
    {name:'Customer Dashboard',description:'Monitor customer metrics and distribution',charts:[{type:'kpi',title:'Total Customers',metric:'customer_count',aggregation:'count'},{type:'kpi',title:'Avg Lifetime Value',metric:'lifetime_value',aggregation:'avg'},{type:'bar',title:'Customers by State',xKey:'state',yKey:'total_orders'},{type:'table',title:'Top Customers',xKey:'name',yKey:'lifetime_value'}]},
    {name:'Operations Dashboard',description:'Track order status and fulfillment',charts:[{type:'kpi',title:'Total Orders',metric:'order_count',aggregation:'count'},{type:'kpi',title:'Completed',metric:'completed_count',aggregation:'count'},{type:'pie',title:'Order Status Distribution',labelKey:'status',valueKey:'amount'},{type:'bar',title:'Amount by Product',xKey:'product',yKey:'amount'}]}
  ];
  res.json({templates});
});


app.get('/api/export/:format',auth,allow('admin','manager','analyst'),async(req,res)=>{
  try{
    const {format}=req.params;
    const {sql:sqlText}=req.query;
    if(!sqlText) return res.status(400).json({message:'SQL query is required'});
    if(!isSafeSelect(sqlText)) return res.status(400).json({message:'Only SELECT queries can be exported'});
    if(!(await referencesOnlyDatasetTables(sqlText))) return res.status(400).json({message:'Query does not reference a valid dataset'});
    const [rows]=await pool.query(sqlText);
    if(format==='csv'){
      if(!rows.length){ res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename=export.csv'); return res.send('No data'); }
      const headers=Object.keys(rows[0]);
      const csv=[headers.join(','),...rows.map(r=>headers.map(h=>csvEscape(r[h])).join(','))].join('\n');
      res.setHeader('Content-Type','text/csv');
      res.setHeader('Content-Disposition','attachment; filename=export.csv');
      res.send(csv);
    } else if(format==='json'){
      res.setHeader('Content-Type','application/json');
      res.setHeader('Content-Disposition','attachment; filename=export.json');
      res.json(rows);
    } else { res.status(400).json({message:'Format must be csv or json'}); }
  }catch(e){res.status(500).json({message:e.message});}
});


app.get('/api/audit-logs',auth,allow('admin'),async(req,res)=>{
  try{
    const limit=Math.min(Number(req.query.limit)||50,200);
    const [rows]=await pool.query('SELECT a.id,a.user_id,a.action,a.details,DATE_FORMAT(a.created_at,\'%Y-%m-%d %H:%i:%s\') as created_at,u.name as user_name,u.email as user_email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT ?',[limit]);
    res.json({logs:rows});
  }catch(e){res.status(500).json({message:e.message});}
});


app.get('/api/bootstrap',auth,async(req,res)=>{
  try {
    const datasets=await datasetList();
    const [users]=req.user.role==='admin'
      ? await pool.query('SELECT id,email,role,name,avatar,is_active FROM users ORDER BY id')
      : [[]];
    const requestSql=`SELECT r.id,r.requested_by AS requestedBy,r.description,r.status,DATE_FORMAT(r.created_at,'%Y-%m-%d') AS date,u.name AS requester FROM dataset_requests r JOIN users u ON u.id=r.requested_by ${req.user.role==='admin'?'':'WHERE r.requested_by=?'} ORDER BY r.created_at DESC`;
    const [requests]=await pool.query(requestSql,req.user.role==='admin'?[]:[req.user.id]);
    const [dash]=await pool.query('SELECT id,title,description,dataset_id,created_by,charts,created_at,updated_at FROM dashboards');
    const [dss]=await pool.query('SELECT id,name FROM datasets');
    const names=Object.fromEntries(dss.map(d=>[d.id,d.name]));
    const dashboards=[];
    for(const d of dash){
      const [a]=await pool.query('SELECT user_id FROM dashboard_access WHERE dashboard_id=?',[d.id]);
      if(req.user.role==='admin'||d.created_by===req.user.id||a.some(x=>x.user_id===req.user.id)){
        dashboards.push({id:d.id,title:d.title,description:d.description,dataset:names[d.dataset_id],createdBy:d.created_by,charts:typeof d.charts==='string'?JSON.parse(d.charts):d.charts,access:a.map(x=>x.user_id),createdAt:d.created_at,updatedAt:d.updated_at});
      }
    }
    const [hist]=await pool.query("SELECT q.id, q.natural_query AS query_text, q.sql_text AS sql_text, q.row_count AS row_count, d.name AS dataset, DATE_FORMAT(q.created_at,'%H:%i:%s') AS ts FROM query_history q JOIN datasets d ON d.id=q.dataset_id WHERE q.user_id=? ORDER BY q.created_at DESC LIMIT 20",[req.user.id]);
    const [sq]=await pool.query('SELECT sq.*,d.name AS dataset_name FROM saved_queries sq JOIN datasets d ON d.id=sq.dataset_id WHERE sq.created_by=? ORDER BY sq.created_at DESC',[req.user.id]);
    res.json({datasets,users,requests,dashboards,queryHistory:hist,savedQueries:sq});
  }catch(e){
    console.error('Bootstrap failed:',e);
    res.status(500).json({message:e.message});
  }
});

// 404 for unknown API routes (keeps responses JSON instead of Express's default HTML page).
app.use('/api',(req,res)=>res.status(404).json({message:'Not found'}));

// Central error handler — catches multer errors (e.g. file too large) and anything else
// thrown/passed to next(), and always responds with JSON so the frontend's api() helper
// can parse it instead of falling back to a generic "Request failed" message.
app.use((err,req,res,next)=>{
  if(err && err.name==='MulterError'){
    const msg = err.code==='LIMIT_FILE_SIZE' ? 'File is too large. Maximum upload size is 25MB.' : `Upload error: ${err.message}`;
    return res.status(400).json({message:msg});
  }
  if(err && err.message==='CORS blocked'){
    return res.status(403).json({message:'Request blocked by CORS policy'});
  }
  console.error('Unhandled error:',err);
  res.status(err?.status||500).json({message:err?.message||'Internal server error'});
});

const port=Number(process.env.PORT||4000);
ensureDatabase().then(init).then(()=>app.listen(port,()=>console.log(`NLQueryEngine API running on :${port}`))).catch(e=>{console.error('Startup failed:',e);process.exit(1)});
