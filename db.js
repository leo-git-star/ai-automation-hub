const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db;

async function initDB() {
  if (db) return db;
  
  const SQL = await initSqlJs({
    locateFile: file => `./node_modules/sql.js/dist/${file}`
  });
  
  const dbPath = path.join(__dirname, 'data', 'automation.db');
  const exists = fs.existsSync(dbPath);
  
  if (exists) {
    fs.unlinkSync(dbPath);
  }
  
  db = new SQL.Database();
  createTables();
  insertDemoData();
  saveDB();
  
  return db;
}

function createTables() {
  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE automations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_config TEXT,
    action_type TEXT NOT NULL,
    action_config TEXT,
    enabled INTEGER DEFAULT 1,
    run_count INTEGER DEFAULT 0,
    last_run_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    priority INTEGER DEFAULT 3,
    status TEXT DEFAULT 'pending',
    due_date TEXT,
    tags TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    contract_no TEXT UNIQUE,
    amount REAL,
    start_date TEXT,
    end_date TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    content TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'info',
    channel TEXT DEFAULT 'in_app',
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE customer_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    content TEXT NOT NULL,
    classification TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE llm_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    platform TEXT NOT NULL,
    api_key TEXT,
    model TEXT,
    enabled INTEGER DEFAULT 1
  )`);
}

function insertDemoData() {
  const stmt1 = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
  stmt1.run(['管理员', 'admin@example.com']);
  stmt1.free();
  
  const stmt2 = db.prepare('INSERT INTO contracts (user_id, customer_name, customer_phone, contract_no, amount, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  stmt2.run([1, '北京科技有限公司', '13800138001', 'HT2024001', 50000.00, '2024-01-01', '2026-07-05', 'active']);
  stmt2.run([1, '上海贸易集团', '13900139002', 'HT2024002', 80000.00, '2024-03-15', '2026-07-10', 'active']);
  stmt2.run([1, '广州实业公司', '13700137003', 'HT2024003', 120000.00, '2024-06-01', '2026-07-15', 'active']);
  stmt2.free();
  
  const stmt3 = db.prepare('INSERT INTO daily_reports (user_id, content, date) VALUES (?, ?, ?)');
  stmt3.run([1, '今日完成：1. 客户报价5份 2. 合同签订2份 3. 团队会议1次\n明日计划：1. 跟进3个潜在客户 2. 准备周报告', '2026-06-30']);
  stmt3.run([1, '今日完成：1. 网站改版上线 2. SEO优化完成 3. 客户回访5家\n明日计划：1. 数据分析报告 2. 新功能开发', '2026-06-29']);
  stmt3.run([1, '今日完成：1. 产品发布会筹备 2. 媒体沟通3家 3. 销售培训\n明日计划：1. 发布会执行 2. 后续跟进', '2026-06-28']);
  stmt3.free();
  
  const stmt4 = db.prepare('INSERT INTO customer_messages (user_id, content, classification, customer_name, customer_phone) VALUES (?, ?, ?, ?, ?)');
  stmt4.run([1, '您好，我想了解一下100平房子的装修报价', '报价咨询', '张总', '13812345678']);
  stmt4.run([1, '请问工期需要多久？', '工期咨询', '', '']);
  stmt4.run([1, '能发一些你们的装修案例看看吗？', '案例查看', '李女士', '13987654321']);
  stmt4.free();
  
  const stmt5 = db.prepare('INSERT INTO automations (user_id, name, trigger_type, trigger_config, action_type, action_config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)');
  stmt5.run([1, '客户咨询自动分类', 'event', '{"event":"message_received"}', 'run_ai', '{"op":"classify","prompt":"分类客户咨询"}', 1]);
  stmt5.run([1, '合同到期前7天提醒', 'due', '{"days_before":7}', 'send_notification', '{"channel":"wechat"}', 1]);
  stmt5.run([1, '每日18点汇总日报', 'cron', '{"time":"18:00"}', 'run_ai', '{"op":"summarize","prompt":"汇总日报"}', 1]);
  stmt5.free();
}

function saveDB() {
  const data = db.export();
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'automation.db'), Buffer.from(data));
}

function query(sql) {
  const stmt = db.prepare(sql);
  const rows = [];
  const columns = stmt.getColumnNames ? stmt.getColumnNames() : [];
  
  while (stmt.step()) {
    const row = {};
    const values = stmt.get();
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    rows.push(row);
  }
  
  stmt.free();
  
  if (rows.length > 0) return rows;
  
  const results = db.exec(sql);
  if (results.length === 0) return [];
  
  const execColumns = results[0].columns || [];
  const execValues = results[0].values || [];
  
  return execValues.map(row => {
    const obj = {};
    execColumns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

function run(sql) {
  db.exec(sql);
  saveDB();
  
  const lastIdResult = db.exec('SELECT last_insert_rowid() as id');
  const lastId = lastIdResult.length > 0 && lastIdResult[0].values.length > 0 
    ? lastIdResult[0].values[0][0] 
    : null;
  
  return { lastInsertRowid: lastId };
}

module.exports = { initDB, query, run, saveDB };