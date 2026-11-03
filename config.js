import dotenv from 'dotenv';
dotenv.config();

export const config = {
  phoneNumber: (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, ''),
  // 7+ Free AI keys - add as many as you want, bot tries in order, never runs out
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  groqApiKey: process.env.GROQ_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  togetherApiKey: process.env.TOGETHER_API_KEY || '',
  cerebrasApiKey: process.env.CEREBRAS_API_KEY || '',
  githubToken: process.env.GITHUB_TOKEN || process.env.GH_MODELS_TOKEN || '',
  cohereApiKey: process.env.COHERE_API_KEY || '',
  hfApiKey: process.env.HF_API_KEY || process.env.HUGGINGFACE_API_KEY || '',
  mistralApiKey: process.env.MISTRAL_API_KEY || '',
  sambaNovaApiKey: process.env.SAMBANOVA_API_KEY || '',
  
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
  openrouterModel: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free',
  togetherModel: process.env.TOGETHER_MODEL || 'meta-llama/Meta-Llama-3.1-8b-Instruct-Turbo',
  cerebrasModel: process.env.CEREBRAS_MODEL || 'llama3.1-8b',
  githubModel: process.env.GITHUB_MODEL || 'openai/gpt-4o-mini',
  cohereModel: process.env.COHERE_MODEL || 'command-r-plus',
  hfModel: process.env.HF_MODEL || 'meta-llama/Meta-Llama-3-8B-Instruct',
  
  bankInfo: process.env.BANK_INFO || process.env.PAYMENT_INFO || '',
  // ===== YOUR IDENTITY (edit these in Render env vars, no code changes needed) =====
  ownerName: process.env.OWNER_NAME || 'Boss',                       // the real person (you)
  assistantName: process.env.ASSISTANT_NAME || 'Brim',               // the AI's own name
  persona: process.env.PERSONA || 'Friendly, sharp, warm and helpful. Talks like a real young Nigerian: relaxed, short sentences, light humour, never stiff or robotic.',
  languageStyle: process.env.LANGUAGE_STYLE || 'Match the contact: English, Nigerian Pidgin, or a mix, whichever they use. Keep it natural.',
  goals: process.env.GOALS || '1) Reply to every message quickly. 2) Be useful: answer questions, take messages, set up calls/meetings. 3) Pass anything urgent or important to the owner.',
  customRules: process.env.CUSTOM_RULES || '',
  adminKey: process.env.ADMIN_KEY || '',   // protects /import /agent /stats /clear-sessions
  fastReplies: (process.env.HUMAN_DELAYS || 'false').toLowerCase() !== 'true',  // set HUMAN_DELAYS=true for slow typing simulation
  maxHistory: parseInt(process.env.MAX_HISTORY || '20', 10),
  maxPerHour: parseInt(process.env.MAX_PER_HOUR || '60', 10),
  handoffMinutes: parseInt(process.env.HANDOFF_MINUTES || '30', 10),
  ownerTakeoverPauseMinutes: parseInt(process.env.OWNER_TAKEOVER_PAUSE_MINUTES || '5', 10),
  ignoreGroups: (process.env.IGNORE_GROUPS || 'true').toLowerCase() === 'true',
  replyDelayMin: parseInt(process.env.REPLY_DELAY_MIN || '1000', 10),
  replyDelayMax: parseInt(process.env.REPLY_DELAY_MAX || '4000', 10),
  port: parseInt(process.env.PORT || '10000', 10),
  ownerNumber: (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '')
};

export function validateConfig() {
  const errors = [];
  if (!config.phoneNumber) errors.push('PHONE_NUMBER required');
  const hasAnyAI = config.geminiApiKey || config.groqApiKey || config.openrouterApiKey || config.togetherApiKey || config.cerebrasApiKey || config.githubToken || config.cohereApiKey || config.hfApiKey || config.mistralApiKey;
  if (!hasAnyAI) errors.push('At least one AI key required');
  if (!config.upstashUrl || !config.upstashToken) console.warn('⚠️ UPSTASH not set');
  if (!config.adminKey) console.warn('⚠️ ADMIN_KEY not set - /import, /agent, /stats and /clear-sessions are DISABLED until you set it');
  if (errors.length) console.error('❌ Config errors:', errors);
  else {
    const keys = [];
    if (config.geminiApiKey) keys.push('Gemini');
    if (config.groqApiKey) keys.push('Groq');
    if (config.openrouterApiKey) keys.push('OpenRouter');
    if (config.cerebrasApiKey) keys.push('Cerebras');
    if (config.githubToken) keys.push('GitHub-Models');
    if (config.togetherApiKey) keys.push('Together');
    if (config.cohereApiKey) keys.push('Cohere');
    if (config.hfApiKey) keys.push('HF');
    if (config.mistralApiKey) keys.push('Mistral');
    console.log(`🔑 AI Chain (${keys.length}): ${keys.join(' → ')}`);
    console.log(`💡 Free no-card new: Cerebras (14k/day), GitHub Models (GPT-4o free), Cohere (1000/month) - get keys at cerebras.ai, github.com/marketplace/models`);
  }
  return errors.length === 0;
}
