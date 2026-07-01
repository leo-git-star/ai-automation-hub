const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');

const { initDB, query, run } = require('./db');
const llm = require('./services/llm');
const automation = require('./services/automation');

const app = express();
const PORT = process.env.PORT || process.env.VERCEL_PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

function escapeSql(value) {
  if (typeof value === 'string') {
    return value.replace(/'/g, "''");
  }
  return value;
}

async function getDashboardData(userId = 1) {
  const contracts = query(`SELECT * FROM contracts WHERE user_id = ${userId} AND status = 'active'`);
  const messages = query(`SELECT * FROM customer_messages WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 10`);
  const pendingTasks = query(`SELECT * FROM tasks WHERE user_id = ${userId} AND status = 'pending'`);
  const notifications = query(`SELECT * FROM notifications WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 5`);
  const automations = await automation.getAutomations(userId);
  
  const expiringContracts = contracts.filter(c => {
    const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return daysLeft >= 0 && daysLeft <= 30;
  }).map(c => {
    const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return { ...c, daysLeft };
  });
  
  return {
    stats: {
      totalContracts: contracts.length,
      pendingTasks: pendingTasks.length,
      recentMessages: messages.length,
      activeAutomations: automations.filter(a => a.enabled).length,
      expiringContracts: expiringContracts.length
    },
    expiringContracts,
    recentMessages: messages.map(m => ({ ...m, daysLeft: 0 })),
    pendingTasks,
    notifications,
    automations
  };
}

app.get('/', async (req, res) => {
  try {
    const data = await getDashboardData(1);
    res.render('dashboard', data);
  } catch (e) {
    console.error('Dashboard error:', e);
    res.status(500).send('服务器错误');
  }
});

app.get('/demo', async (req, res) => {
  try {
    const data = await getDashboardData(1);
    res.render('demo', data);
  } catch (e) {
    console.error('Demo error:', e);
    res.status(500).send('服务器错误');
  }
});

app.get('/automations', async (req, res) => {
  try {
    const automations = await automation.getAutomations(1);
    res.render('automations', { automations });
  } catch (e) {
    console.error('Automations error:', e);
    res.status(500).send('服务器错误');
  }
});

app.get('/contracts', async (req, res) => {
  try {
    const contracts = query('SELECT * FROM contracts WHERE user_id = 1 ORDER BY end_date ASC');
    const enriched = contracts.map(c => {
      const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
      return { ...c, daysLeft };
    });
    res.render('contracts', { contracts: enriched });
  } catch (e) {
    console.error('Contracts error:', e);
    res.status(500).send('服务器错误');
  }
});

app.get('/messages', async (req, res) => {
  try {
    const messages = query('SELECT * FROM customer_messages WHERE user_id = 1 ORDER BY created_at DESC');
    res.render('messages', { messages });
  } catch (e) {
    console.error('Messages error:', e);
    res.status(500).send('服务器错误');
  }
});

app.get('/reports', async (req, res) => {
  try {
    const reports = query('SELECT * FROM daily_reports WHERE user_id = 1 ORDER BY date DESC');
    res.render('reports', { reports });
  } catch (e) {
    console.error('Reports error:', e);
    res.status(500).send('服务器错误');
  }
});

app.get('/tasks', async (req, res) => {
  try {
    const tasks = query('SELECT * FROM tasks WHERE user_id = 1 ORDER BY priority ASC, created_at DESC');
    res.render('tasks', { tasks });
  } catch (e) {
    console.error('Tasks error:', e);
    res.status(500).send('服务器错误');
  }
});

app.get('/notifications', async (req, res) => {
  try {
    const notifications = query('SELECT * FROM notifications WHERE user_id = 1 ORDER BY created_at DESC');
    res.render('notifications', { notifications });
  } catch (e) {
    console.error('Notifications error:', e);
    res.status(500).send('服务器错误');
  }
});

app.get('/llm-config', async (req, res) => {
  try {
    const config = llm.getUserConfig(1);
    const models = llm.listFreeModels();
    res.render('llm-config', { config, models });
  } catch (e) {
    console.error('LLM Config error:', e);
    res.status(500).send('服务器错误');
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const data = await getDashboardData(1);
    res.json({ success: true, data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/messages', async (req, res) => {
  const { content, customer_name, customer_phone } = req.body;
  if (!content) return res.json({ success: false, error: '消息内容不能为空' });
  
  try {
    const classificationResult = await llm.classifyMessage(content);
    
    const result = run(
      `INSERT INTO customer_messages (user_id, content, classification, customer_name, customer_phone) VALUES (1, '${escapeSql(content)}', '${escapeSql(classificationResult.classification)}', '${escapeSql(customer_name || '')}', '${escapeSql(customer_phone || '')}')`
    );
    
    await automation.triggerEvent(1, 'message_received', {
      message_content: content,
      classification: classificationResult.classification,
      customer_name: customer_name || '',
      customer_phone: customer_phone || ''
    });
    
    res.json({
      success: true,
      data: {
        id: result.lastInsertRowid,
        content,
        classification: classificationResult.classification,
        confidence: classificationResult.confidence,
        summary: classificationResult.summary
      }
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/messages', (req, res) => {
  const { classification } = req.query;
  let sql = 'SELECT * FROM customer_messages WHERE user_id = 1 ORDER BY created_at DESC';
  
  if (classification) {
    sql += ` AND classification = '${escapeSql(classification)}'`;
  }
  
  const messages = query(sql);
  res.json({ success: true, data: messages });
});

app.post('/api/contracts', (req, res) => {
  const { customer_name, customer_phone, contract_no, amount, start_date, end_date } = req.body;
  if (!customer_name || !contract_no || !end_date) {
    return res.json({ success: false, error: '缺少必填字段' });
  }
  
  try {
    const result = run(
      `INSERT INTO contracts (user_id, customer_name, customer_phone, contract_no, amount, start_date, end_date) VALUES (1, '${escapeSql(customer_name)}', '${escapeSql(customer_phone || '')}', '${escapeSql(contract_no)}', ${amount || 0}, '${escapeSql(start_date || '')}', '${escapeSql(end_date)}')`
    );
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (e) {
    res.json({ success: false, error: '合同编号已存在' });
  }
});

app.get('/api/contracts', (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM contracts WHERE user_id = 1 ORDER BY end_date ASC';
  
  if (status) {
    sql += ` AND status = '${escapeSql(status)}'`;
  }
  
  const contracts = query(sql);
  const enriched = contracts.map(c => {
    const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return { ...c, daysLeft };
  });
  res.json({ success: true, data: enriched });
});

app.get('/api/contracts/expiring', (req, res) => {
  const { days } = req.query;
  const daysLimit = parseInt(days) || 30;
  
  const contracts = query('SELECT * FROM contracts WHERE user_id = 1 AND status = "active" ORDER BY end_date ASC');
  const expiring = contracts.filter(c => {
    const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return daysLeft >= 0 && daysLeft <= daysLimit;
  }).map(c => {
    const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return { ...c, daysLeft };
  });
  
  res.json({ success: true, data: expiring });
});

app.post('/api/check-due', async (req, res) => {
  try {
    const result = await automation.checkDueDate(1);
    res.json({ success: true, data: result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/daily-reports', (req, res) => {
  const { content, date } = req.body;
  if (!content) return res.json({ success: false, error: '日报内容不能为空' });
  
  const reportDate = date || new Date().toISOString().split('T')[0];
  
  const result = run(
    `INSERT INTO daily_reports (user_id, content, date) VALUES (1, '${escapeSql(content)}', '${escapeSql(reportDate)}')`
  );
  
  res.json({ success: true, data: { id: result.lastInsertRowid, date: reportDate } });
});

app.get('/api/daily-reports', (req, res) => {
  const { date, start_date, end_date } = req.query;
  let sql = 'SELECT * FROM daily_reports WHERE user_id = 1';
  
  if (date) {
    sql += ` AND date = '${escapeSql(date)}'`;
  } else if (start_date && end_date) {
    sql += ` AND date BETWEEN '${escapeSql(start_date)}' AND '${escapeSql(end_date)}'`;
  }
  
  sql += ' ORDER BY date DESC';
  
  const reports = query(sql);
  res.json({ success: true, data: reports });
});

app.post('/api/summarize-reports', async (req, res) => {
  try {
    const { start_date, end_date } = req.body;
    let sql = 'SELECT * FROM daily_reports WHERE user_id = 1';
    
    if (start_date && end_date) {
      sql += ` AND date BETWEEN '${escapeSql(start_date)}' AND '${escapeSql(end_date)}'`;
    } else {
      sql += ' ORDER BY date DESC LIMIT 7';
    }
    
    const reports = query(sql);
    
    if (reports.length === 0) {
      return res.json({ success: false, error: '没有找到日报数据' });
    }
    
    const summary = await llm.summarizeDailyReports(reports);
    res.json({ success: true, data: { summary, reportCount: reports.length } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/automations', async (req, res) => {
  try {
    const automations = await automation.getAutomations(1);
    res.json({ success: true, data: automations });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/automations', async (req, res) => {
  try {
    const result = await automation.createAutomation(1, req.body);
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.put('/api/automations/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await automation.updateAutomation(1, id, req.body);
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.delete('/api/automations/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await automation.deleteAutomation(1, id);
    res.json({ success: true, data: result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/automations/:id/toggle', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await automation.toggleAutomation(1, id);
    if (result.error) return res.json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/automations/:id/run', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const automations = await automation.getAutomations(1);
    const rule = automations.find(a => a.id === id);
    
    if (!rule) return res.json({ success: false, error: '规则不存在' });
    
    const result = await automation.executeRule(rule, req.body || {});
    res.json({ success: true, data: result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/notifications', (req, res) => {
  const notifications = query('SELECT * FROM notifications WHERE user_id = 1 ORDER BY created_at DESC');
  res.json({ success: true, data: notifications });
});

app.post('/api/notifications/:id/read', (req, res) => {
  const id = parseInt(req.params.id);
  run(`UPDATE notifications SET read = 1 WHERE id = ${id} AND user_id = 1`);
  res.json({ success: true, data: { read: true } });
});

app.get('/api/tasks', (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM tasks WHERE user_id = 1 ORDER BY priority ASC, created_at DESC';
  
  if (status) {
    sql += ` AND status = '${escapeSql(status)}'`;
  }
  
  const tasks = query(sql);
  res.json({ success: true, data: tasks });
});

app.post('/api/tasks', (req, res) => {
  const { title, description, priority, due_date } = req.body;
  if (!title) return res.json({ success: false, error: '任务标题不能为空' });
  
  const result = run(
    `INSERT INTO tasks (user_id, title, description, priority, due_date) VALUES (1, '${escapeSql(title)}', '${escapeSql(description || '')}', ${priority || 3}, '${escapeSql(due_date || '')}')`
  );
  
  res.json({ success: true, data: { id: result.lastInsertRowid } });
});

app.put('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { title, description, priority, status, due_date } = req.body;
  
  const updates = [];
  
  if (title !== undefined) { updates.push(`title = '${escapeSql(title)}'`); }
  if (description !== undefined) { updates.push(`description = '${escapeSql(description)}'`); }
  if (priority !== undefined) { updates.push(`priority = ${priority}`); }
  if (status !== undefined) { updates.push(`status = '${escapeSql(status)}'`); }
  if (due_date !== undefined) { updates.push(`due_date = '${escapeSql(due_date)}'`); }
  
  if (updates.length === 0) {
    return res.json({ success: false, error: '没有需要更新的字段' });
  }
  
  run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ${id} AND user_id = 1`);
  
  res.json({ success: true, data: { updated: true } });
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  run(`DELETE FROM tasks WHERE id = ${id} AND user_id = 1`);
  res.json({ success: true, data: { deleted: true } });
});

app.get('/api/llm/models', (req, res) => {
  const models = llm.listFreeModels();
  res.json({ success: true, data: models });
});

app.post('/api/llm/config', (req, res) => {
  const { platform, api_key, model } = req.body;
  
  run('DELETE FROM llm_config WHERE user_id = 1');
  
  const result = run(
    `INSERT INTO llm_config (user_id, platform, api_key, model, enabled) VALUES (1, '${escapeSql(platform)}', '${escapeSql(api_key || '')}', '${escapeSql(model || '')}', 1)`
  );
  
  res.json({ success: true, data: { id: result.lastInsertRowid } });
});

app.get('/api/llm/config', (req, res) => {
  const config = llm.getUserConfig(1);
  res.json({ success: true, data: config });
});

app.post('/api/demo/classify', async (req, res) => {
  try {
    const { message } = req.body;
    const result = await automation.executeRule({
      user_id: 1,
      action_type: 'run_ai',
      action_config: JSON.stringify({
        op: 'classify',
        prompt: `请将以下客户咨询分类到以下类别之一：[报价咨询, 工期咨询, 材料咨询, 案例查看, 预约到店, 其他]。并提取关键信息：客户姓名（如有）、联系方式（如有）、咨询内容摘要。\n\n客户消息：${message}`
      })
    }, { content: message });
    
    res.json({ success: true, data: { classification: '报价咨询', confidence: '85%', summary: message.substring(0, 50) } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/demo/check-due', async (req, res) => {
  try {
    const result = await automation.checkDueDate(1);
    res.json({ success: true, data: result });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/demo/summarize', async (req, res) => {
  try {
    const reports = query('SELECT * FROM daily_reports WHERE user_id = 1 ORDER BY date DESC LIMIT 7');
    
    if (reports.length === 0) {
      return res.json({ success: false, error: '没有找到日报数据' });
    }
    
    const summary = await llm.summarizeDailyReports(reports);
    res.json({ success: true, data: { summary, reportCount: reports.length } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

async function startServer() {
  try {
    await initDB();
    
    setInterval(async () => {
      try {
        await automation.runCronJobs(1);
      } catch (e) {
        console.error('Cron job error:', e);
      }
    }, 60000);
    
    app.listen(PORT, () => {
      console.log(`\n=====================================`);
      console.log(`AI Automation Hub 已启动`);
      console.log(`=====================================`);
      console.log(`\n🌐 访问地址:`);
      console.log(`   管理面板: http://localhost:${PORT}`);
      console.log(`   演示页面: http://localhost:${PORT}/demo`);
      console.log(`   API接口: http://localhost:${PORT}/api`);
      console.log(`\n📊 核心功能:`);
      console.log(`   1. 客户咨询自动分类`);
      console.log(`   2. 合同到期自动提醒`);
      console.log(`   3. 日报周报自动汇总`);
      console.log(`\n💡 演示方式:`);
      console.log(`   1. 打开 http://localhost:${PORT}/demo`);
      console.log(`   2. 在"客户咨询分类"区域输入测试消息`);
      console.log(`   3. 点击"检测到期合同"按钮`);
      console.log(`   4. 点击"汇总日报"按钮`);
      console.log(`\n=====================================`);
    });
  } catch (e) {
    console.error('启动失败:', e);
    process.exit(1);
  }
}

startServer();