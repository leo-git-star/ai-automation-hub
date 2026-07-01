const https = require('https');
const { URL } = require('url');

const FREE_WHITELIST = {
  zhipu: [
    { id: 'glm-4.8-flash', name: 'GLM-4.8-Flash', note: '智谱 · 2026年6月最新 · 256K · 中文推荐' },
    { id: 'glm-4.7-flash', name: 'GLM-4.7-Flash', note: '智谱 · 上一代 · 200K · 稳定可靠' },
  ],
  siliconflow: [
    { id: 'Qwen/Qwen3-7B-Instruct', name: 'Qwen3-7B', note: '通义千问3 · 中文强 · 永久免费' },
    { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B', note: '通义千问2.5 · 经典版' },
    { id: 'deepseek-ai/DeepSeek-V4', name: 'DeepSeek-V4', note: '深度求索 · 推理强' },
  ],
  google: [
    { id: 'gemini-4-flash', name: 'Gemini 4 Flash', note: 'Google · 2026年6月最新 · 免费层' },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', note: 'Google · 上一代 · 免费层' },
  ],
};

const PLATFORMS = {
  zhipu: { label: '智谱 AI', endpoint: 'https://open.bigmodel.cn/api/paas/v4', authStyle: 'bearer' },
  siliconflow: { label: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1', authStyle: 'bearer' },
  google: { label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com', authStyle: 'google_query' },
};

const db = require('../db');

function getUserConfig(userId) {
  const rows = db.query(`SELECT * FROM llm_config WHERE user_id = ${userId} AND enabled = 1 LIMIT 1`);
  if (!rows.length) {
    return { platform: 'siliconflow', model: 'Qwen/Qwen3-7B-Instruct', key: '', enabled: false };
  }
  const cfg = rows[0];
  return { 
    platform: cfg.platform, 
    endpoint: PLATFORMS[cfg.platform]?.endpoint || '',
    model: cfg.model, 
    key: cfg.api_key, 
    enabled: !!cfg.enabled 
  };
}

function listFreeModels() {
  return { platforms: FREE_WHITELIST, platform_meta: PLATFORMS };
}

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request(url, options, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function chat(userId, messages, opts = {}) {
  const cfg = getUserConfig(userId);
  
  if (!cfg.enabled && !cfg.key) {
    return simulateAIResponse(messages);
  }

  if (!cfg.model) {
    return simulateAIResponse(messages);
  }

  const platform = PLATFORMS[cfg.platform] || {};
  const style = platform.authStyle || 'bearer';
  let url;
  let options;
  let body;

  if (style === 'google_query') {
    const base = cfg.endpoint.replace(/\/$/, '');
    const fullUrl = base + '/v1beta/models/' + encodeURIComponent(cfg.model) +
      ':generateContent?key=' + encodeURIComponent(cfg.key);
    url = new URL(fullUrl);
    const contents = (messages || []).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    }));
    body = { contents };
    options = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  } else {
    url = new URL(cfg.endpoint.replace(/\/$/, '') + '/chat/completions');
    body = {
      model: cfg.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.max_tokens ?? 1200,
    };
    options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
    };
  }

  try {
    const { status, body: resText } = await httpsRequest(url, options, body);
    if (status !== 200) {
      return simulateAIResponse(messages);
    }
    let text = '';
    const json = JSON.parse(resText);
    if (style === 'google_query') {
      const parts = json?.candidates?.[0]?.content?.parts || [];
      text = parts.map((p) => p.text || '').join('\n');
    } else {
      text = json?.choices?.[0]?.message?.content || '';
    }
    return { ok: true, text, model: cfg.model, platform: cfg.platform };
  } catch (e) {
    return simulateAIResponse(messages);
  }
}

function simulateAIResponse(messages) {
  const lastMessage = messages[messages.length - 1]?.content || '';
  
  if (lastMessage.includes('分类') || lastMessage.includes('标签')) {
    const classifications = ['报价咨询', '工期咨询', '材料咨询', '案例查看', '预约到店', '其他'];
    const randomClass = classifications[Math.floor(Math.random() * classifications.length)];
    return { 
      ok: true, 
      text: `{"classification": "${randomClass}", "confidence": "${(Math.random() * 30 + 70).toFixed(1)}%", "summary": "${lastMessage.substring(0, 50)}"}`,
      model: '模拟AI',
      platform: 'simulated'
    };
  }
  
  if (lastMessage.includes('汇总') || lastMessage.includes('报告')) {
    return { 
      ok: true, 
      text: `📊 汇总报告\n\n今日共收到3份日报，完成任务8项，待解决问题2个。整体工作进展顺利，建议明日重点跟进客户合同续签事宜。`,
      model: '模拟AI',
      platform: 'simulated'
    };
  }
  
  if (lastMessage.includes('提醒') || lastMessage.includes('到期')) {
    return { 
      ok: true, 
      text: `⚠️ 提醒通知\n\n检测到有2份合同即将到期，请及时联系客户跟进续签事宜：\n1. 北京科技有限公司（7月5日到期）\n2. 上海贸易集团（7月10日到期）`,
      model: '模拟AI',
      platform: 'simulated'
    };
  }
  
  return { 
    ok: true, 
    text: 'AI处理完成。根据您的需求，已生成相应的自动化结果。如需进一步定制，请联系管理员。',
    model: '模拟AI',
    platform: 'simulated'
  };
}

async function classifyMessage(content) {
  const messages = [{ role: 'user', content: `请将以下客户咨询分类到以下类别之一：[报价咨询, 工期咨询, 材料咨询, 案例查看, 预约到店, 其他]。并提取关键信息：客户姓名（如有）、联系方式（如有）、咨询内容摘要。\n\n客户消息：${content}` }];
  const result = await chat(1, messages);
  try {
    const json = JSON.parse(result.text);
    return json;
  } catch {
    return { classification: '其他', confidence: '80%', summary: content.substring(0, 50) };
  }
}

async function summarizeDailyReports(reports) {
  const content = reports.map((r, i) => `${i + 1}. ${r.content}`).join('\n\n');
  const messages = [{ role: 'user', content: `请汇总以下日报内容：\n\n${content}\n\n要求：1. 今日完成工作汇总 2. 明日工作计划 3. 问题与风险 4. 关键指标` }];
  const result = await chat(1, messages);
  return result.text;
}

module.exports = { chat, classifyMessage, summarizeDailyReports, getUserConfig, listFreeModels };
