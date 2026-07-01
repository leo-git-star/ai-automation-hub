const db = require('../db');
const llm = require('./llm');

const TRIGGER_TYPES = ['event', 'cron', 'due', 'tagged'];
const ACTION_TYPES = ['send_notification', 'create_task', 'update_task', 'add_tag', 'run_ai'];

function escapeSql(value) {
  if (typeof value === 'string') {
    return value.replace(/'/g, "''");
  }
  return value;
}

async function getAutomations(userId) {
  const rows = db.query(`SELECT * FROM automations WHERE user_id = ${userId} ORDER BY created_at DESC`);
  return rows.map(r => ({
    ...r,
    trigger_config: JSON.parse(r.trigger_config || '{}'),
    action_config: JSON.parse(r.action_config || '{}')
  }));
}

async function createAutomation(userId, data) {
  const { name, trigger_type, trigger_config, action_type, action_config, enabled = 1 } = data;
  
  if (!TRIGGER_TYPES.includes(trigger_type)) {
    return { error: '无效的触发器类型' };
  }
  if (!ACTION_TYPES.includes(action_type)) {
    return { error: '无效的动作类型' };
  }
  
  const result = db.run(
    `INSERT INTO automations (user_id, name, trigger_type, trigger_config, action_type, action_config, enabled) VALUES (${userId}, '${escapeSql(name)}', '${escapeSql(trigger_type)}', '${escapeSql(JSON.stringify(trigger_config))}', '${escapeSql(action_type)}', '${escapeSql(JSON.stringify(action_config))}', ${enabled})`
  );
  
  return { id: result.lastInsertRowid };
}

async function updateAutomation(userId, id, data) {
  const { name, trigger_type, trigger_config, action_type, action_config, enabled } = data;
  
  const updates = [];
  
  if (name !== undefined) { updates.push(`name = '${escapeSql(name)}'`); }
  if (trigger_type !== undefined) { updates.push(`trigger_type = '${escapeSql(trigger_type)}'`); }
  if (trigger_config !== undefined) { updates.push(`trigger_config = '${escapeSql(JSON.stringify(trigger_config))}'`); }
  if (action_type !== undefined) { updates.push(`action_type = '${escapeSql(action_type)}'`); }
  if (action_config !== undefined) { updates.push(`action_config = '${escapeSql(JSON.stringify(action_config))}'`); }
  if (enabled !== undefined) { updates.push(`enabled = ${enabled ? 1 : 0}`); }
  
  if (updates.length === 0) {
    return { error: '没有需要更新的字段' };
  }
  
  db.run(`UPDATE automations SET ${updates.join(', ')} WHERE id = ${id} AND user_id = ${userId}`);
  
  return { updated: true };
}

async function deleteAutomation(userId, id) {
  db.run(`DELETE FROM automations WHERE id = ${id} AND user_id = ${userId}`);
  return { deleted: true };
}

async function toggleAutomation(userId, id) {
  const rows = db.query(`SELECT enabled FROM automations WHERE id = ${id} AND user_id = ${userId}`);
  if (!rows.length) {
    return { error: '规则不存在' };
  }
  const newEnabled = rows[0].enabled ? 0 : 1;
  db.run(`UPDATE automations SET enabled = ${newEnabled} WHERE id = ${id} AND user_id = ${userId}`);
  return { enabled: newEnabled === 1 };
}

async function executeRule(rule, ctx = {}) {
  const actionCfg = typeof rule.action_config === 'string' ? JSON.parse(rule.action_config) : rule.action_config;
  const userId = rule.user_id;
  
  switch (rule.action_type) {
    case 'send_notification': {
      const message = (actionCfg.message || '自动化通知').replace(/{title}/g, ctx.title || '');
      db.run(
        `INSERT INTO notifications (user_id, message, type, channel) VALUES (${userId}, '${escapeSql(message)}', '${escapeSql(actionCfg.type || 'info')}', '${escapeSql(actionCfg.channel || 'in_app')}')`
      );
      return { type: 'notification', channel: actionCfg.channel || 'in_app', message };
    }
    
    case 'create_task': {
      const title = `${actionCfg.title_prefix || ''}${actionCfg.title || '新任务'}`;
      const result = db.run(
        `INSERT INTO tasks (user_id, title, description, priority, status, due_date) VALUES (${userId}, '${escapeSql(title)}', '${escapeSql(actionCfg.description || '')}', ${actionCfg.priority || 3}, 'pending', '${escapeSql(actionCfg.due_date || '')}')`
      );
      return { type: 'create_task', id: result.lastInsertRowid, title };
    }
    
    case 'update_task': {
      if (ctx.task_id) {
        db.run(`UPDATE tasks SET priority = ${actionCfg.priority || 1}, status = '${escapeSql(actionCfg.status || 'pending')}' WHERE id = ${ctx.task_id} AND user_id = ${userId}`);
      }
      return { type: 'update_task', task_id: ctx.task_id, priority: actionCfg.priority };
    }
    
    case 'add_tag': {
      return { type: 'add_tag', tag: actionCfg.tag || '待处理', task_id: ctx.task_id };
    }
    
    case 'run_ai': {
      const prompt = actionCfg.prompt || '处理任务';
      const filledPrompt = prompt.replace(/{title}/g, ctx.title || '').replace(/{content}/g, ctx.content || '');
      const messages = [{ role: 'user', content: filledPrompt }];
      const result = await llm.chat(userId, messages);
      return { type: 'run_ai', op: actionCfg.op, result: result.text };
    }
    
    default:
      return { type: 'noop', reason: '未知动作类型' };
  }
}

async function triggerEvent(userId, eventName, payload = {}) {
  const rules = await getAutomations(userId);
  const executed = [];
  
  for (const rule of rules) {
    if (!rule.enabled) continue;
    
    const trigCfg = rule.trigger_config;
    let matched = false;
    
    if (rule.trigger_type === 'event' && (trigCfg.event === eventName || eventName === 'custom')) {
      matched = true;
    } else if (rule.trigger_type === 'tagged' && Array.isArray(payload.tags) && payload.tags.includes(trigCfg.tag)) {
      matched = true;
    }
    
    if (matched) {
      const result = await executeRule(rule, payload);
      executed.push({ id: rule.id, name: rule.name, result });
      db.run(`UPDATE automations SET last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ${rule.id}`);
    }
  }
  
  return { event: eventName, triggered_count: executed.length, executed };
}

async function checkDueDate(userId) {
  const today = new Date().toISOString().split('T')[0];
  const rules = await getAutomations(userId);
  const executed = [];
  
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger_type !== 'due') continue;
    
    const trigCfg = rule.trigger_config;
    const daysBefore = trigCfg.days_before || 0;
    const daysAfter = trigCfg.days_after || 0;
    
    let checkDate;
    if (daysBefore > 0) {
      const d = new Date();
      d.setDate(d.getDate() + daysBefore);
      checkDate = d.toISOString().split('T')[0];
    } else if (daysAfter > 0) {
      const d = new Date();
      d.setDate(d.getDate() - daysAfter);
      checkDate = d.toISOString().split('T')[0];
    } else {
      checkDate = today;
    }
    
    const contracts = db.query(`SELECT * FROM contracts WHERE user_id = ${userId} AND end_date = '${escapeSql(checkDate)}'`);
    
    if (contracts.length > 0) {
      for (const contract of contracts) {
        const result = await executeRule(rule, { 
          title: contract.customer_name, 
          contract_no: contract.contract_no,
          customer_name: contract.customer_name,
          customer_phone: contract.customer_phone
        });
        executed.push({ id: rule.id, name: rule.name, contract_id: contract.id, result });
      }
      db.run(`UPDATE automations SET last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ${rule.id}`);
    }
  }
  
  return { date: today, triggered_count: executed.length, executed };
}

async function runCronJobs(userId) {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  
  const rules = await getAutomations(userId);
  const executed = [];
  
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger_type !== 'cron') continue;
    
    const trigCfg = rule.trigger_config;
    if (trigCfg.time === timeStr) {
      const result = await executeRule(rule);
      executed.push({ id: rule.id, name: rule.name, result });
      db.run(`UPDATE automations SET last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ${rule.id}`);
    }
  }
  
  return { time: timeStr, triggered_count: executed.length, executed };
}

module.exports = {
  getAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  toggleAutomation,
  executeRule,
  triggerEvent,
  checkDueDate,
  runCronJobs
};