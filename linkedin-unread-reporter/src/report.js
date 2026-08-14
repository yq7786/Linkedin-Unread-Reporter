function escapeSlackText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function groupConversationNames(conversations) {
  const counts = new Map();
  for (const conversation of conversations) {
    const name = String(conversation.name);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].map(([name, count]) => (
    count === 1 ? name : `${name} — ${count} conversations`
  ));
}

function formatTime(date, timezone) {
  const value = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  return value.toLocaleLowerCase('en-AU').replace(/\s+(am|pm)$/, '$1');
}

export function formatSlackReport({
  conversations,
  truncated,
  scannedAt,
  timezone,
  inboxUrl,
}) {
  const count = conversations.length;
  const headingCount = truncated ? `${count}+` : String(count);
  const lines = [
    `LinkedIn unread message: ${headingCount}`,
    `Scanned: ${formatTime(scannedAt, timezone)} ${timezone}`,
  ];

  const groupedNames = groupConversationNames(conversations);
  if (groupedNames.length) {
    lines.push('', ...groupedNames.map((name) => `• ${escapeSlackText(name)}`));
  }
  if (truncated) {
    lines.push('', `Showing the first ${count} unread conversations.`);
  }
  lines.push('', `<${inboxUrl}|Open LinkedIn Unread Inbox>`);
  return lines.join('\n');
}
