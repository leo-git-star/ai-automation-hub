const express = require('express');
const router = express.Router();
const db = require('../db');
const llm = require('../services/llm');
const automation = require('../services/automation');

router.get('/dashboard', async (req, res) => {
  const userId = 1;
  
  const contracts = db.query('SELECT * FROM contracts WHERE user_id = ? AND status = "active"', [userId]);
  const messages = db.query('SELECT * FROM customer_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [userId]);
  const tasks = db.query('SELECT * FROM tasks WHERE user_id = ? AND status = "pending"', [userId]);
  const notifications = db.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [userId]);
  const automations = await automation.getAutomations(userId);
  
  const expiringContracts = contracts.filter(c => {
    const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return daysLeft >= 0 && daysLeft <= 30;
  });
  
  res.json({
    success: true,
    data: {
      stats: {
        totalContracts: contracts.length,
        pendingTasks: tasks.length,
        recentMessages: messages.length,
        activeAutomations: automations.filter(a => a.enabled).length,
        expiringContracts: expiringContracts.length
      },
      expiringContracts,
      recentMessages,
      pendingTasks,
      notifications,
      automations
    }
  });
});

router.post('/messages', async (req, res) => {
  const userId = 1;
  const { content, customer_name, customer_phone } = req.body;
  
  if (!content) {
    return res.json({ success: false, error: '消息内容不能为空' });
  }
  
  const classificationResult = await llm.classifyMessage(content);
  
  const result = db.run(
    'INSERT INTO customer_messages (user_id, content, classification, customer_name, customer_phone) VALUES (?, ?, ?, ?, ?)',
    [userId, content, classificationResult.classification, customer_name || '', customer_phone || '']
  );
  
  await automation.triggerEvent(userId, 'message_received', {
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
});

router.get('/messages', (req, res) => {
  const userId = 1;
  const { classification } = req.query;
  
  let query = 'SELECT * FROM customer_messages WHERE user_id = ? ORDER BY created_at DESC';
  const params = [userId];
  
  if (classification) {
    query += ' AND classification = ?';
    params.push(classification);
  }
  
  const messages = db.query(query, params);
  res.json({ success: true, data: messages });
});

router.post('/contracts', (req, res) => {
  const userId = 1;
  const { customer_name, customer_phone, contract_no, amount, start_date, end_date } = req.body;
  
  if (!customer_name || !contract_no || !end_date) {
    return res.json({ success: false, error: '缺少必填字段' });
  }
  
  try {
    const result = db.run(
      'INSERT INTO contracts (user_id, customer_name, customer_phone, contract_no, amount, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, customer_name, customer_phone || '', contract_no, amount || 0, start_date || null, end_date]
    );
    
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (e) {
    res.json({ success: false, error: '合同编号已存在' });
  }
});

router.get('/contracts', (req, res) => {
  const userId = 1;
  const { status } = req.query;
  
  let query = 'SELECT * FROM contracts WHERE user_id = ? ORDER BY end_date ASC';
  const params = [userId];
  
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  
  const contracts = db.query(query, params);
  
  const enriched = contracts.map(c => {
    const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return { ...c, daysLeft };
  });
  
  res.json({ success: true, data: enriched });
});

router.get('/contracts/expiring', (req, res) => {
  const userId = 1;
  const { days } = req.query;
  const daysLimit = parseInt(days) || 30;
  
  const contracts = db.query('SELECT * FROM contracts WHERE user_id = ? AND status = "active" ORDER BY end_date ASC', [userId]);
  
  const expiring = contracts.filter(c => {
    const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return daysLeft >= 0 && daysLeft <= daysLimit;
  }).map(c => {
    const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24));
    return { ...c, daysLeft };
  });
  
  res.json({ success: true, data: expiring });
});

router.post('/check-due', async (req, res) => {
  const userId = 1;
  const result = await automation.checkDueDate(userId);
  res.json({ success: true, data: result });
});

router.post('/daily-reports', (req, res) => {
  const userId = 1;
  const { content, date } = req.body;
  
  if (!content) {
    return res.json({ success: false, error: '日报内容不能为空' });
  }
  
  const reportDate = date || new Date().toISOString().split('T')[0];
  
  const result = db.run(
    'INSERT INTO daily_reports (user_id, content, date) VALUES (?, ?, ?)',
    [userId, content, reportDate]
  );
  
  res.json({ success: true, data: { id: result.lastInsertRowid, date: reportDate } });
});

router.get('/daily-reports', (req, res) => {
  const userId = 1;
  const { date, start_date, end_date } = req.query;
  
  let query = 'SELECT * FROM daily_reports WHERE user_id = ?';
  const params = [userId];
  
  if (date) {
    query += ' AND date = ?';
    params.push(date);
  } else if (start_date && end_date) {
    query += ' AND date BETWEEN ? AND ?';
    params.push(start_date, end_date);
  }
  
  query += ' ORDER BY date DESC';
  
  const reports = db.query(query, params);
  res.json({ success: true, data: reports });
});

router.post('/summarize-reports', async (req, res) => {
  const userId = 1;
  const { start_date, end_date } = req.body;
  
  let query = 'SELECT * FROM daily_reports WHERE user_id = ?';
  const params = [userId];
  
  if (start_date && end_date) {
    query += ' AND date BETWEEN ? AND ?';
    params.push(start_date, end_date);
  } else {
    query += ' ORDER BY date DESC LIMIT 7';
  }
  
  const reports = db.query(query, params);
  
  if (reports.length === 0) {
    return res.json({ success: false, error: '没有找到日报数据' });
  }
  
  const summary = await llm.summarizeDailyReports(reports);
  
  res.json({ success: true, data: { summary, reportCount: reports.length } });
});

router.get('/automations', async (req, res) => {
  const userId = 1;
  const automations = await automation.getAutomations(userId);
  res.json({ success: true, data: automations });
});

router.post('/automations', async (req, res) => {
  const userId = 1;
  const result = await automation.createAutomation(userId, req.body);
  
  if (result.error) {
    return res.json({ success: false, error: result.error });
  }
  
  res.json({ success: true, data: result });
});

router.put('/automations/:id', async (req, res) => {
  const userId = 1;
  const id = parseInt(req.params.id);
  const result = await automation.updateAutomation(userId, id, req.body);
  
  if (result.error) {
    return res.json({ success: false, error: result.error });
  }
  
  res.json({ success: true, data: result });
});

router.delete('/automations/:id', async (req, res) => {
  const userId = 1;
  const id = parseInt(req.params.id);
  const result = await automation.deleteAutomation(userId, id);
  res.json({ success: true, data: result });
});

router.post('/automations/:id/toggle', async (req, res) => {
  const userId = 1;
  const id = parseInt(req.params.id);
  const result = await automation.toggleAutomation(userId, id);
  
  if (result.error) {
    return res.json({ success: false, error: result.error });
  }
  
  res.json({ success: true, data: result });
});

router.post('/automations/:id/run', async (req, res) => {
  const userId = 1;
  const id = parseInt(req.params.id);
  const automations = await automation.getAutomations(userId);
  const rule = automations.find(a => a.id === id);
  
  if (!rule) {
    return res.json({ success: false, error: '规则不存在' });
  }
  
  const result = await automation.executeRule(rule, req.body || {});
  res.json({ success: true, data: result });
});

router.get('/notifications', (req, res) => {
  const userId = 1;
  const notifications = db.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  res.json({ success: true, data: notifications });
});

router.post('/notifications/:id/read', (req, res) => {
  const userId = 1;
  const id = parseInt(req.params.id);
  db.run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', [id, userId]);
  res.json({ success: true, data: { read: true } });
});

router.get('/tasks', (req, res) => {
  const userId = 1;
  const { status } = req.query;
  
  let query = 'SELECT * FROM tasks WHERE user_id = ? ORDER BY priority ASC, created_at DESC';
  const params = [userId];
  
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  
  const tasks = db.query(query, params);
  res.json({ success: true, data: tasks });
});

router.post('/tasks', (req, res) => {
  const userId = 1;
  const { title, description, priority, due_date } = req.body;
  
  if (!title) {
    return res.json({ success: false, error: '任务标题不能为空' });
  }
  
  const result = db.run(
    'INSERT INTO tasks (user_id, title, description, priority, due_date) VALUES (?, ?, ?, ?, ?)',
    [userId, title, description || '', priority || 3, due_date || null]
  );
  
  res.json({ success: true, data: { id: result.lastInsertRowid } });
});

router.put('/tasks/:id', (req, res) => {
  const userId = 1;
  const id = parseInt(req.params.id);
  const { title, description, priority, status, due_date } = req.body;
  
  const updates = [];
  const params = [];
  
  if (title !== undefined) { updates.push('title = ?'); params.push(title); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (due_date !== undefined) { updates.push('due_date = ?'); params.push(due_date); }
  
  if (updates.length === 0) {
    return res.json({ success: false, error: '没有需要更新的字段' });
  }
  
  params.push(id, userId);
  db.run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
  
  res.json({ success: true, data: { updated: true } });
});

router.delete('/tasks/:id', (req, res) => {
  const userId = 1;
  const id = parseInt(req.params.id);
  db.run('DELETE FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);
  res.json({ success: true, data: { deleted: true } });
});

router.get('/llm/models', (req, res) => {
  const models = llm.listFreeModels();
  res.json({ success: true, data: models });
});

router.post('/llm/config', (req, res) => {
  const userId = 1;
  const { platform, api_key, model } = req.body;
  
  db.run('DELETE FROM llm_config WHERE user_id = ?', [userId]);
  
  const result = db.run(
    'INSERT INTO llm_config (user_id, platform, api_key, model, enabled) VALUES (?, ?, ?, ?, 1)',
    [userId, platform, api_key || '', model || '']
  );
  
  res.json({ success: true, data: { id: result.lastInsertRowid } });
});

router.get('/llm/config', (req, res) => {
  const userId = 1;
  const config = llm.getUserConfig(userId);
  res.json({ success: true, data: config });
});

module.exports = router;
