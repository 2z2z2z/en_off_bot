'use strict';

function isTelegramPlatform(platform, telegramPlatform = 'telegram') {
  if (platform == null) {
    return false;
  }
  return String(platform) === String(telegramPlatform || 'telegram');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeHtmlForTelegram(html) {
  if (!html) {
    return '';
  }

  let text = String(html);

  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<\/?div[^>]*>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n• ');
  text = text.replace(/<\/li>/gi, '');
  text = text.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  text = text.replace(/<blockquote[^>]*>/gi, '\n');
  text = text.replace(/<\/blockquote>/gi, '\n');
  text = text.replace(/<h([1-6])[^>]*>/gi, '\n<b>');
  text = text.replace(/<\/h[1-6]>/gi, '</b>\n');

  const replacements = [
    { from: /<strong[^>]*>/gi, to: '<b>' },
    { from: /<\/strong>/gi, to: '</b>' },
    { from: /<em[^>]*>/gi, to: '<i>' },
    { from: /<\/em>/gi, to: '</i>' },
    { from: /<ins[^>]*>/gi, to: '<u>' },
    { from: /<\/ins>/gi, to: '</u>' },
    { from: /<u[^>]*>/gi, to: '<u>' },
    { from: /<\/u>/gi, to: '</u>' },
    { from: /<(?:strike|del)[^>]*>/gi, to: '<s>' },
    { from: /<\/(?:strike|del)>/gi, to: '</s>' },
    { from: /<span[^>]*>/gi, to: '' },
    { from: /<\/span>/gi, to: '' },
    { from: /<font[^>]*>/gi, to: '' },
    { from: /<\/font>/gi, to: '' },
    { from: /<pre[^>]*>/gi, to: '\n<pre>' },
    { from: /<\/pre>/gi, to: '</pre>\n' },
    { from: /<code[^>]*>/gi, to: '<code>' },
    { from: /<\/code>/gi, to: '</code>' }
  ];
  for (const { from, to } of replacements) {
    text = text.replace(from, to);
  }

  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi, '<a href="$1">');
  text = text.replace(/<\/a>/gi, '</a>');

  const allowedTags = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a']);
  text = text.replace(/<([^>]+)>/gi, (match, inner) => {
    const content = inner.trim();
    if (!content) {
      return '';
    }

    const isClosing = content.startsWith('/');
    let tagBody = isClosing ? content.slice(1).trim() : content;
    const isSelfClosing = tagBody.endsWith('/');
    if (isSelfClosing) {
      tagBody = tagBody.slice(0, -1).trim();
    }
    const tagNameMatch = tagBody.match(/^([a-z0-9]+)/i);
    if (!tagNameMatch) {
      return '';
    }
    const tagName = tagNameMatch[1].toLowerCase();

    if (tagName === 'br') {
      return '\n';
    }

    if (!allowedTags.has(tagName)) {
      return '';
    }

    if (isClosing) {
      return `</${tagName}>`;
    }

    if (tagName === 'a') {
      const hrefMatch = tagBody.match(/href\s*=\s*['"]([^'"]+)['"]/i);
      const href = hrefMatch ? hrefMatch[1] : null;
      if (!href) {
        return '';
      }
      return `<a href="${href}">`;
    }

    return `<${tagName}>`;
  });

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
    .replace(/&hellip;/gi, '...')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');

  text = text.replace(/\t+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function stripHtml(input) {
  if (!input) {
    return '';
  }

  let text = String(input);

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<li[^>]*>/gi, '\n• ');
  text = text.replace(/<\/li>/gi, '');
  text = text.replace(/<\/?ul[^>]*>/gi, '\n');
  text = text.replace(/<\/?ol[^>]*>/gi, '\n');
  text = text.replace(/<\/?blockquote[^>]*>/gi, '\n');
  text = text.replace(/<\/?strong[^>]*>/gi, '');
  text = text.replace(/<\/?em[^>]*>/gi, '');
  text = text.replace(/<\/?span[^>]*>/gi, '');
  text = text.replace(/<\/?div[^>]*>/gi, '\n');
  text = text.replace(/<\/?h\d[^>]*>/gi, '\n');
  text = text.replace(/<\/?table[^>]*>/gi, '\n');
  text = text.replace(/<\/?tr[^>]*>/gi, '\n');
  text = text.replace(/<\/?td[^>]*>/gi, '\t');
  text = text.replace(/<\/?th[^>]*>/gi, '\t');
  text = text.replace(/<[^>]+>/g, '');

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
    .replace(/&hellip;/gi, '...')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');

  text = text.replace(/\t+/g, ' ');
  text = text.replace(/\r/g, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function formatRemain(seconds) {
  const total = Number(seconds) || 0;
  if (total <= 0) return '';
  let s = Math.floor(total);
  const days = Math.floor(s / 86400);
  s %= 86400;
  const hours = Math.floor(s / 3600);
  s %= 3600;
  const minutes = Math.floor(s / 60);
  s %= 60;
  const parts = [];
  if (days > 0) parts.push(`${days}д`);
  if (hours > 0) parts.push(`${hours}ч`);
  if (minutes > 0) parts.push(`${minutes}м`);
  if (s > 0) parts.push(`${s}с`);
  return parts.join(' ');
}

function extractSectorAnswerText(rawAnswer) {
  if (rawAnswer == null) return '';
  if (typeof rawAnswer === 'string') return rawAnswer.trim();
  if (typeof rawAnswer === 'number' || typeof rawAnswer === 'boolean') return String(rawAnswer);
  if (Array.isArray(rawAnswer)) {
    const parts = rawAnswer
      .map(item => extractSectorAnswerText(item))
      .filter(v => v && v.trim().length > 0);
    return parts.join(', ');
  }
  const candidates = [
    rawAnswer.Value,
    rawAnswer.Text,
    rawAnswer.Answer,
    rawAnswer.Display,
    rawAnswer.StringValue,
    rawAnswer.Name,
    rawAnswer.Title,
    rawAnswer.Content
  ].filter(v => v != null);
  if (candidates.length > 0) {
    const first = candidates.find(v => typeof v === 'string') ?? candidates[0];
    return extractSectorAnswerText(first);
  }
  try {
    const flat = Object.values(rawAnswer)
      .map(v => (typeof v === 'string' || typeof v === 'number' ? String(v) : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    return flat;
  } catch (_) {
    return '';
  }
}

function formatSectorsMessage({
  platform,
  telegramPlatform = 'telegram',
  sectors,
  totalRequired,
  totalCount,
  passedCount,
  leftToClose
}) {
  const isTelegram = isTelegramPlatform(platform, telegramPlatform);
  const options = isTelegram ? { parse_mode: 'HTML', disable_web_page_preview: true } : {};

  if (!Array.isArray(sectors) || sectors.length === 0) {
    const header = isTelegram ? '<b>🗄 Секторы</b>' : '🗄 Секторы';
    const text = `${header}\n\nНет данных о секторах.`;
    return {
      text,
      header,
      body: '',
      options
    };
  }

  const lines = sectors.map(s => {
    const order = s?.Order ?? '';
    const nameRaw = s?.Name ?? '';
    const name = isTelegram ? escapeHtml(nameRaw) : nameRaw;
    const isAnswered = s?.IsAnswered === true;
    const answerTextRaw = s?.Answer;
    const answerText = extractSectorAnswerText(answerTextRaw);

    if (isTelegram) {
      const safeAnswer = answerText ? `<code>${escapeHtml(answerText)}</code>` : '<code>—</code>';
      const condition = isAnswered ? `${safeAnswer} ✅` : '<i>...</i>';
      return `#${order} (${name}) — ${condition}`;
    }

    const safeAnswer = answerText ? `«${answerText}»` : '—';
    const condition = isAnswered ? `${safeAnswer} ✅` : '…';
    return `#${order} (${name}) — ${condition}`;
  });

  const header = isTelegram
    ? `<b>🗄 Секторы (обязательных ${totalRequired} из ${totalCount})</b>`
    : `🗄 Секторы (обязательных ${totalRequired} из ${totalCount})`;

  const summary = isTelegram
    ? `Закрыто — <b>${passedCount}</b>, осталось — <b>${leftToClose}</b>`
    : `Закрыто — ${passedCount}, осталось — ${leftToClose}`;

  const body = lines.join('\n');
  const text = `${header}\n\n${summary}\n\n${body}`;

  return {
    text,
    header,
    body,
    options
  };
}

function collectTaskFragments(tasks, { formatted = false } = {}) {
  const fragments = [];
  const field = formatted ? 'TaskTextFormatted' : 'TaskText';

  const addFragment = rawValue => {
    if (rawValue == null) {
      return;
    }
    const raw = String(rawValue);
    const presenceCheck = stripHtml(raw).trim();
    if (presenceCheck.length === 0) {
      return;
    }
    fragments.push(formatted ? raw : raw.trim());
  };

  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      const rawValue = task?.[field] ?? task?.TaskText;
      addFragment(rawValue);
    }
  } else if (tasks && typeof tasks === 'object') {
    const rawValue = tasks[field] ?? tasks.TaskText;
    addFragment(rawValue);
  }

  return fragments;
}

function collectHelps(helps, { formatted = false } = {}) {
  const result = [];
  if (!Array.isArray(helps)) {
    return result;
  }

  const field = formatted ? 'HelpTextFormatted' : 'HelpText';

  for (const help of helps) {
    const rawValue = help?.[field] ?? help?.HelpText ?? '';
    const raw = String(rawValue);
    const trimmed = stripHtml(raw).trim();
    const remainSeconds = help?.RemainSeconds ?? null;

    if (trimmed.length === 0 && (remainSeconds == null || remainSeconds <= 0)) {
      continue;
    }

    result.push({
      number: help?.Number ?? '',
      text: formatted ? raw : raw.trim(),
      remainSeconds
    });
  }

  return result;
}

function buildTaskHeader({ isTelegram, levelNumber, levelName }) {
  const title = `📜 Задание уровня №${levelNumber}${levelName ? ` — ${levelName}` : ''}`;
  return isTelegram ? `<b>${title}</b>` : title;
}

function buildTimeoutLine({ isTelegram, timeoutRemain }) {
  if (!timeoutRemain) {
    return '';
  }

  return isTelegram
    ? `<i>До автоперехода осталось: ${escapeHtml(timeoutRemain)}</i>`
    : `До автоперехода осталось: ${timeoutRemain}`;
}

function renderTaskFragment({ formatted, isTelegram }, text) {
  if (formatted) {
    return isTelegram ? sanitizeHtmlForTelegram(text) : stripHtml(text);
  }

  return isTelegram ? escapeHtml(text) : text;
}

function buildTaskBody(context) {
  const { taskFragments, formatted, isTelegram } = context;

  if (taskFragments.length === 0) {
    if (formatted) {
      return isTelegram ? '<i>Текст задания недоступен.</i>' : 'Текст задания недоступен.';
    }

    return isTelegram
      ? '<blockquote>Текст задания недоступен.</blockquote>'
      : 'Текст задания недоступен.';
  }

  const rendered = taskFragments.map(fragment => renderTaskFragment(context, fragment));

  if (!formatted && isTelegram) {
    return rendered.map(fragment => `<blockquote>${fragment}</blockquote>`).join('\n\n');
  }

  return rendered.join('\n\n');
}

function buildHelpSection(context, help) {
  const { formatted, isTelegram } = context;
  const number = help.number;
  const label = number ? `💡 Подсказка ${number}` : '💡 Подсказка';
  const remainStr = formatRemain(help.remainSeconds);

  const helpContent = formatted
    ? isTelegram
      ? sanitizeHtmlForTelegram(help.text)
      : stripHtml(help.text)
    : isTelegram
      ? escapeHtml(help.text)
      : help.text;

  if (isTelegram) {
    const remainLine = remainStr
      ? `\n<i>До подсказки осталось: ${escapeHtml(remainStr)}</i>`
      : '';
    if (formatted) {
      return `<b>${label}</b>\n${helpContent}${remainLine}`;
    }
    return `<b>${label}</b>\n<blockquote>${helpContent}</blockquote>${remainLine}`;
  }

  let section = `${label}\n${helpContent}`;
  if (remainStr) {
    section += `\nДо подсказки осталось: ${remainStr}`;
  }
  return section;
}

function buildHelpsBlock(context) {
  const sections = context.helps.map(help => buildHelpSection(context, help));
  return sections.length > 0 ? sections.join('\n\n') : '';
}

function formatTaskMessage({
  platform,
  telegramPlatform = 'telegram',
  level,
  taskFragments,
  helps,
  timeoutRemain,
  formatted = false
}) {
  const isTelegram = isTelegramPlatform(platform, telegramPlatform);
  const normalizedHelps = Array.isArray(helps) ? helps : [];
  const options = isTelegram ? { parse_mode: 'HTML', disable_web_page_preview: true } : {};

  const levelNumber = level?.Number ?? '';
  const levelNameRaw = String(level?.Name || '').trim();
  const levelName = isTelegram ? escapeHtml(levelNameRaw) : levelNameRaw;
  const context = {
    isTelegram,
    formatted,
    taskFragments,
    helps: normalizedHelps,
    timeoutRemain,
    levelNumber,
    levelName
  };

  const header = buildTaskHeader(context);
  const timeoutLine = buildTimeoutLine(context);
  const bodyMain = buildTaskBody(context);
  const helpsBlock = buildHelpsBlock(context);

  const sections = [header];
  if (timeoutLine) sections.push(timeoutLine);
  if (bodyMain) sections.push(bodyMain);
  if (helpsBlock) sections.push(helpsBlock);

  const text = sections.join('\n\n');
  const body = sections.slice(1).join('\n\n');

  return {
    text,
    header,
    body,
    options
  };
}

function splitMessageBody(text, maxLength) {
  if (!text) {
    return [];
  }

  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

function formatBatchProgress({ progress, total, answer, statusText, levelNumber, sectorsText }) {
  const levelDisplay = levelNumber ?? '—';
  const safeAnswer = answer ?? '—';
  const lines = [
    `📤 Отправка пачки: ${progress}/${total}`,
    `💬 "${safeAnswer}": ${statusText}`,
    `🎯 Уровень: ${levelDisplay}`
  ];
  if (sectorsText && sectorsText !== '—') {
    lines.push(`📊 Сектора: ${sectorsText}`);
  }
  return lines.join('\n');
}

function formatStatusText(rawMessage) {
  const message = rawMessage || 'Отправлен';
  const lower = message.toLowerCase();
  const isNegative = lower.includes('невер') || lower.includes('ошиб');
  const emoji = isNegative ? '👎' : '👍';
  return `${emoji} ${message}`;
}

module.exports = {
  formatSectorsMessage,
  collectTaskFragments,
  collectHelps,
  formatTaskMessage,
  splitMessageBody,
  formatBatchProgress,
  formatStatusText,
  sanitizeHtmlForTelegram,
  stripHtml,
  escapeHtml,
  formatRemain,
  extractSectorAnswerText,
  isTelegramPlatform
};
