'use strict';

/**
 * src/slaEngine.js
 * ---------------------------------------------------------------------------
 * Core SLA evaluation, escalation planning and payload building for the
 * n8n-hubspot-ticket-sla-escalation-router.
 *
 * Pipeline (all pure functions, no I/O):
 *
 *   HubSpot search pages ──► extractTicketsFromResponses()
 *                              │
 *                              ▼
 *                         processTickets() ──► evaluateTicket() per ticket
 *                              │                  ├─ resolveTier()
 *                              │                  ├─ elapsedHours() (calendar or business hours)
 *                              │                  ├─ classify()       (OK / WARNING / BREACHED / CRITICAL)
 *                              │                  └─ decideNotification() (cooldown + level changes)
 *                              ▼
 *                         planActions() ──► ticket updates, HubSpot tasks,
 *                              │            Slack digest, email digest
 *                              ▼
 *                         toN8nItems() ──► items routed by the n8n Switch node
 *
 * Constraints
 *  - Zero dependencies, no require(): inlined into n8n Code nodes at build time.
 *  - Never throws for bad ticket data: tickets are skipped with a reason code.
 *  - Telemetry is sanitized: no ticket subjects, emails or tokens are logged.
 *  - Cross-realm safe (n8n runs Code nodes in a separate VM context), so Date
 *    and Array checks avoid `instanceof`.
 * ---------------------------------------------------------------------------
 */

const ENGINE_VERSION = '1.0.0';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Upper bound on day iterations in business-hours maths (~10 years). */
const MAX_BUSINESS_DAY_ITERATIONS = 3660;
/** Slack allows 50 blocks per message; we reserve some for header/footer. */
const SLACK_MAX_TICKET_BLOCKS = 40;
const SLACK_SECTION_MAX_CHARS = 2900;
const SUBJECT_MAX_CHARS = 140;

const LEVELS = Object.freeze({ NONE: 0, WARNING: 1, BREACHED: 2, CRITICAL: 3 });
const LEVEL_NAMES = Object.freeze(['NONE', 'WARNING', 'BREACHED', 'CRITICAL']);
const LEVEL_EMOJI = Object.freeze(['✅', '⚠️', '🔴', '🚨']);

const STATUS = Object.freeze({
  OK: 'OK',
  WARNING: 'WARNING',
  BREACHED: 'BREACHED',
  CRITICAL: 'CRITICAL',
  MET: 'MET',
  MET_LATE: 'MET_LATE',
});

const SKIP_REASONS = Object.freeze({
  INVALID_TICKET: 'INVALID_TICKET',
  MISSING_ID: 'MISSING_ID',
  MISSING_CREATEDATE: 'MISSING_CREATEDATE',
  TICKET_CLOSED: 'TICKET_CLOSED',
  DUPLICATE: 'DUPLICATE',
  RUN_LIMIT_REACHED: 'RUN_LIMIT_REACHED',
});

/** Properties requested from the HubSpot search API (custom ones are appended from config). */
const BASE_TICKET_PROPERTIES = Object.freeze([
  'hs_object_id',
  'subject',
  'hs_ticket_priority',
  'hs_pipeline',
  'hs_pipeline_stage',
  'createdate',
  'closed_date',
  'hubspot_owner_id',
  'hs_lastmodifieddate',
]);

class SlaEngineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SlaEngineError';
    this.code = code || 'SLA_ENGINE_ERROR';
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isDate(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function round(value, decimals) {
  const factor = Math.pow(10, decimals === undefined ? 2 : decimals);
  return Math.round(value * factor) / factor;
}

function assertConfig(config) {
  if (!isPlainObject(config) || !isPlainObject(config.sla) || !isPlainObject(config.sla.tiers)) {
    throw new SlaEngineError('A configuration object from config.loadConfig() is required', 'CONFIG_REQUIRED');
  }
}

/**
 * Parse a HubSpot date value. HubSpot returns ISO-8601 strings from the v3
 * search API but epoch-millisecond strings in some legacy payloads.
 * @returns {Date|null}
 */
function parseHubSpotDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (isDate(value)) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? new Date(value) : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{10}$/.test(trimmed)) return new Date(Number(trimmed) * 1000); // epoch seconds
    if (/^\d{12,13}$/.test(trimmed)) return new Date(Number(trimmed)); // epoch millis
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

/** Remove anything resembling an email address, bearer token or webhook URL. */
function redact(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/https:\/\/hooks\.slack\.com\/\S+/gi, '[redacted-webhook]')
    .replace(/\b(xox[abposr]-[A-Za-z0-9-]+)/g, '[redacted-token]')
    .replace(/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted-token]');
}

/** Escape text for Slack mrkdwn (&, <, > are control characters). */
function escapeSlack(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape text for HTML email bodies. */
function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value, max) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function formatHours(hours) {
  if (!Number.isFinite(hours)) return 'n/a';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${round(hours, 1)}h`;
  return `${round(hours / 24, 1)}d`;
}

// ---------------------------------------------------------------------------
// SLA maths
// ---------------------------------------------------------------------------

/**
 * Hours of business time between two instants.
 * Business windows are evaluated in a fixed UTC offset (BUSINESS_TZ_OFFSET_MINUTES).
 * Fixed offsets avoid shipping a timezone database inside the Code node; adjust the
 * offset at DST changes if your support desk follows daylight saving time.
 */
function businessHoursBetween(start, end, businessHours) {
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (!(endMs > startMs)) return 0;

  const offsetMs = (businessHours.tzOffsetMinutes || 0) * 60 * 1000;
  const localStart = startMs + offsetMs;
  const localEnd = endMs + offsetMs;
  const workDays = businessHours.days;
  let totalMs = 0;
  let iterations = 0;

  for (let dayStart = Math.floor(localStart / DAY_MS) * DAY_MS; dayStart < localEnd; dayStart += DAY_MS) {
    if (++iterations > MAX_BUSINESS_DAY_ITERATIONS) break;
    const weekday = new Date(dayStart).getUTCDay();
    if (workDays.indexOf(weekday) === -1) continue;
    const windowStart = dayStart + businessHours.startHour * HOUR_MS;
    const windowEnd = dayStart + businessHours.endHour * HOUR_MS;
    const overlapStart = Math.max(windowStart, localStart);
    const overlapEnd = Math.min(windowEnd, localEnd);
    if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
  }
  return totalMs / HOUR_MS;
}

/** Elapsed SLA hours between two instants (calendar or business hours, never negative). */
function elapsedHours(start, end, config) {
  if (!isDate(start) || !isDate(end)) return 0;
  if (config.businessHours && config.businessHours.enabled) {
    return businessHoursBetween(start, end, config.businessHours);
  }
  return Math.max(0, (end.getTime() - start.getTime()) / HOUR_MS);
}

/** Map a raw HubSpot priority to an SLA tier, falling back to the default tier. */
function resolveTier(rawPriority, config) {
  const normalized = String(rawPriority === undefined || rawPriority === null ? '' : rawPriority)
    .trim()
    .toUpperCase();
  const mapped = normalized ? config.sla.priorityMap[normalized] : undefined;
  const tier = mapped || config.sla.defaultTier;
  return {
    tier,
    source: mapped ? 'PRIORITY_MAP' : 'DEFAULT_TIER',
    rawPriority: normalized || null,
    targets: config.sla.tiers[tier],
  };
}

/** Convert elapsed/target into a percentage and an escalation level. */
function classify(elapsed, targetHours, config) {
  const pctConsumed = targetHours > 0 ? (elapsed / targetHours) * 100 : 0;
  let level = LEVELS.NONE;
  if (pctConsumed >= config.sla.criticalPct) level = LEVELS.CRITICAL;
  else if (pctConsumed >= 100) level = LEVELS.BREACHED;
  else if (pctConsumed >= config.sla.warningPct) level = LEVELS.WARNING;
  const status = [STATUS.OK, STATUS.WARNING, STATUS.BREACHED, STATUS.CRITICAL][level];
  return {
    status,
    level,
    elapsedHours: round(elapsed),
    targetHours,
    pctConsumed: round(pctConsumed, 1),
    remainingHours: round(Math.max(0, targetHours - elapsed)),
  };
}

/** Which notification channels a given level qualifies for under current config. */
function channelsForLevel(level, config) {
  const channels = [];
  if (level <= LEVELS.NONE) return channels;
  const e = config.escalation;
  const c = config.channels;
  if (c.slackEnabled && level >= e.slackMinLevel) channels.push('slack');
  if (c.emailEnabled && level >= e.emailMinLevel) channels.push('email');
  if (c.tasksEnabled && level >= e.taskMinLevel) channels.push('task');
  return channels;
}

/**
 * Decide whether a ticket should notify on this run.
 * Rules (in order):
 *   1. Level NONE never notifies.
 *   2. No channel configured for the level → no notification.
 *   3. Level increased since the last recorded escalation → notify immediately.
 *   4. No previous escalation timestamp → notify.
 *   5. Cooldown elapsed since the last escalation → re-notify (reminder).
 *   6. Otherwise suppress (cooldown active).
 */
function decideNotification(level, previousLevel, lastEscalatedAt, config, now) {
  if (level <= LEVELS.NONE) {
    return { shouldNotify: false, reason: previousLevel > LEVELS.NONE ? 'DEESCALATED' : 'WITHIN_SLA', channels: [] };
  }
  const channels = channelsForLevel(level, config);
  if (channels.length === 0) return { shouldNotify: false, reason: 'NO_CHANNEL_FOR_LEVEL', channels };
  if (level > previousLevel) return { shouldNotify: true, reason: 'LEVEL_INCREASED', channels };
  if (!lastEscalatedAt) return { shouldNotify: true, reason: 'NO_PRIOR_ESCALATION_RECORD', channels };
  const hoursSince = (now.getTime() - lastEscalatedAt.getTime()) / HOUR_MS;
  if (hoursSince >= config.escalation.cooldownHours) return { shouldNotify: true, reason: 'COOLDOWN_ELAPSED', channels };
  return { shouldNotify: false, reason: 'COOLDOWN_ACTIVE', channels };
}

function ticketUrl(ticketId, config) {
  if (!config.hubspot || !config.hubspot.portalId) return null;
  return `${config.hubspot.appBaseUrl}/contacts/${config.hubspot.portalId}/ticket/${encodeURIComponent(ticketId)}`;
}

function skipped(ticketId, reason) {
  return { skipped: true, ticketId: ticketId || null, reason };
}

/**
 * Evaluate one HubSpot ticket against its SLA tier.
 * @param {object} rawTicket HubSpot CRM object ({ id, properties }).
 * @param {object} config Output of loadConfig().
 * @param {Date} now Evaluation instant.
 * @returns {object} Evaluation, or { skipped: true, reason } for unusable tickets.
 */
function evaluateTicket(rawTicket, config, now) {
  assertConfig(config);
  const at = parseHubSpotDate(now) || new Date();
  if (!isPlainObject(rawTicket)) return skipped(null, SKIP_REASONS.INVALID_TICKET);

  const props = isPlainObject(rawTicket.properties) ? rawTicket.properties : {};
  const ticketId = String(rawTicket.id || props.hs_object_id || '').trim();
  if (!ticketId) return skipped(null, SKIP_REASONS.MISSING_ID);

  const createdAt = parseHubSpotDate(props.createdate || rawTicket.createdAt);
  if (!createdAt) return skipped(ticketId, SKIP_REASONS.MISSING_CREATEDATE);
  if (parseHubSpotDate(props.closed_date)) return skipped(ticketId, SKIP_REASONS.TICKET_CLOSED);

  const tierInfo = resolveTier(props.hs_ticket_priority, config);
  const targets = tierInfo.targets;

  // First response: measured to the first agent reply if one exists, otherwise to now.
  const firstReplyAt = parseHubSpotDate(props[config.hubspot.firstResponseProperty]);
  let firstResponse;
  if (firstReplyAt) {
    const took = elapsedHours(createdAt, firstReplyAt, config);
    firstResponse = {
      status: took > targets.firstResponseHours ? STATUS.MET_LATE : STATUS.MET,
      level: LEVELS.NONE, // a completed first response can no longer escalate
      elapsedHours: round(took),
      targetHours: targets.firstResponseHours,
      pctConsumed: round((took / targets.firstResponseHours) * 100, 1),
      remainingHours: 0,
      respondedAt: firstReplyAt.toISOString(),
    };
  } else {
    firstResponse = classify(elapsedHours(createdAt, at, config), targets.firstResponseHours, config);
  }

  // Resolution: open tickets only (closed tickets were skipped above).
  const resolution = classify(elapsedHours(createdAt, at, config), targets.resolutionHours, config);

  const level = Math.max(firstResponse.level, resolution.level);
  const previousLevelRaw = parseInt(props[config.properties.escalationLevel], 10);
  const previousLevel = Number.isFinite(previousLevelRaw) ? Math.min(Math.max(previousLevelRaw, 0), 3) : 0;
  const lastEscalatedAt = parseHubSpotDate(props[config.properties.lastEscalatedAt]);
  const notify = decideNotification(level, previousLevel, lastEscalatedAt, config, at);

  const ownerId = props.hubspot_owner_id ? String(props.hubspot_owner_id).trim() : '';
  const breachedClocks = [];
  if (firstResponse.level > LEVELS.NONE) breachedClocks.push('FIRST_RESPONSE');
  if (resolution.level > LEVELS.NONE) breachedClocks.push('RESOLUTION');

  return {
    skipped: false,
    ticketId,
    subject: truncate(props.subject || '(no subject)', SUBJECT_MAX_CHARS),
    tier: tierInfo.tier,
    tierSource: tierInfo.source,
    rawPriority: tierInfo.rawPriority,
    pipelineId: props.hs_pipeline || null,
    stageId: props.hs_pipeline_stage || null,
    ownerId: ownerId || null,
    ownerMissing: !ownerId,
    createdAt: createdAt.toISOString(),
    firstResponse,
    resolution,
    level,
    levelName: LEVEL_NAMES[level],
    previousLevel,
    lastEscalatedAt: lastEscalatedAt ? lastEscalatedAt.toISOString() : null,
    breachedClocks,
    notify,
    needsPropertySync: notify.shouldNotify || level !== previousLevel,
    hubspotUrl: ticketUrl(ticketId, config),
  };
}

// ---------------------------------------------------------------------------
// HubSpot request / response helpers
// ---------------------------------------------------------------------------

/** Build the body for POST /crm/v3/objects/tickets/search (open tickets only). */
function buildSearchRequest(config) {
  assertConfig(config);
  const filters = [{ propertyName: 'closed_date', operator: 'NOT_HAS_PROPERTY' }];
  if (config.hubspot.pipelineId) {
    filters.push({ propertyName: 'hs_pipeline', operator: 'EQ', value: String(config.hubspot.pipelineId) });
  }
  const properties = BASE_TICKET_PROPERTIES.concat([
    config.hubspot.firstResponseProperty,
    config.properties.escalationLevel,
    config.properties.lastEscalatedAt,
    config.properties.status,
  ]).filter((p, i, all) => all.indexOf(p) === i);

  return {
    filterGroups: [{ filters }],
    sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
    properties,
    limit: config.hubspot.searchPageSize,
  };
}

function describeFetchError(errorValue) {
  const err = isPlainObject(errorValue) ? errorValue : { message: String(errorValue) };
  const status = Number(err.httpCode || err.statusCode || err.status || (err.cause && err.cause.status)) || null;
  const message = redact(truncate(err.message || err.description || 'Unknown HubSpot error', 300));
  const rateLimited = status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message);
  return { status, message, rateLimited };
}

/**
 * Flatten n8n input items into ticket objects.
 * Accepts HubSpot search pages ({ results, paging }), single ticket objects,
 * and error items produced by "On Error → Continue" HTTP nodes.
 */
function extractTicketsFromResponses(items) {
  const tickets = [];
  const errors = [];
  const list = Array.isArray(items) ? items : [];
  for (const raw of list) {
    const item = isPlainObject(raw) && isPlainObject(raw.json) ? raw.json : raw;
    if (!isPlainObject(item)) continue;
    if (item.error) {
      errors.push(describeFetchError(item.error));
      continue;
    }
    if (Array.isArray(item.results)) {
      item.results.forEach((t) => isPlainObject(t) && tickets.push(t));
    } else if (item.id && isPlainObject(item.properties)) {
      tickets.push(item);
    }
  }
  return { tickets, errors, rateLimited: errors.some((e) => e.rateLimited) };
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

/** PATCH body for /crm/v3/objects/tickets/{id}. */
function buildTicketUpdatePayload(evaluation, config, now) {
  const properties = {
    [config.properties.escalationLevel]: String(evaluation.level),
    [config.properties.status]: evaluation.levelName,
  };
  if (evaluation.notify.shouldNotify) properties[config.properties.lastEscalatedAt] = now.toISOString();
  return { properties };
}

function describeClock(label, clock) {
  if (clock.status === STATUS.MET || clock.status === STATUS.MET_LATE) {
    return `${label}: ${clock.status} in ${formatHours(clock.elapsedHours)} (target ${formatHours(clock.targetHours)})`;
  }
  return `${label}: ${clock.status} ${clock.pctConsumed}% of ${formatHours(clock.targetHours)} (elapsed ${formatHours(clock.elapsedHours)})`;
}

/** POST body for /crm/v3/objects/tasks, associated to the ticket. */
function buildTaskPayload(evaluation, config, now) {
  const due = new Date(now.getTime() + config.escalation.taskDueHours * HOUR_MS);
  const ownerId = evaluation.ownerId || config.hubspot.fallbackOwnerId || null;
  const lines = [
    `SLA ${evaluation.levelName} on ticket #${evaluation.ticketId} (tier ${evaluation.tier}).`,
    describeClock('First response', evaluation.firstResponse),
    describeClock('Resolution', evaluation.resolution),
  ];
  if (config.escalation.includeSubject) lines.splice(1, 0, `Subject: ${evaluation.subject}`);
  if (evaluation.ownerMissing) lines.push('Ticket has no owner: assign one as part of this task.');
  lines.push('Created automatically by the SLA escalation router.');

  const properties = {
    hs_timestamp: due.toISOString(),
    hs_task_subject: `[SLA ${evaluation.levelName}] Ticket #${evaluation.ticketId} (${evaluation.tier})`,
    hs_task_body: lines.join('\n'),
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: evaluation.level >= LEVELS.CRITICAL ? 'HIGH' : 'MEDIUM',
    hs_task_type: 'TODO',
  };
  if (ownerId) properties.hubspot_owner_id = String(ownerId);

  return {
    properties,
    associations: [
      {
        to: { id: String(evaluation.ticketId) },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: config.hubspot.taskTicketAssociationTypeId }],
      },
    ],
  };
}

/** Compact, notification-safe projection of an evaluation (used inside digest items). */
function toEscalationSummary(evaluation, config) {
  return {
    ticketId: evaluation.ticketId,
    subject: config.escalation.includeSubject ? evaluation.subject : null,
    tier: evaluation.tier,
    level: evaluation.level,
    levelName: evaluation.levelName,
    ownerId: evaluation.ownerId,
    ownerMissing: evaluation.ownerMissing,
    breachedClocks: evaluation.breachedClocks,
    firstResponse: evaluation.firstResponse,
    resolution: evaluation.resolution,
    reason: evaluation.notify.reason,
    hubspotUrl: evaluation.hubspotUrl,
  };
}

/**
 * Slack Block Kit message for a set of escalation summaries.
 * @returns {{ channel: string, text: string, blocks: object[] }}
 */
function buildSlackBlocks(summaries, config, meta) {
  const list = Array.isArray(summaries) ? summaries : [];
  const info = meta || {};
  const counts = [0, 0, 0, 0];
  list.forEach((s) => (counts[s.level] = (counts[s.level] || 0) + 1));
  const hasCritical = counts[LEVELS.CRITICAL] > 0;
  const modeLabel = config.sandboxMode ? 'SANDBOX (dry run)' : 'LIVE';

  const fallbackText = `SLA escalation: ${list.length} ticket(s) need attention (${counts[3]} critical, ${counts[2]} breached, ${counts[1]} warning).`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${hasCritical ? '🚨' : '⚠️'} SLA Escalation Digest: ${list.length} ticket(s)`, emoji: true } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Critical:* ${counts[3]}  ·  *Breached:* ${counts[2]}  ·  *Warning:* ${counts[1]}  ·  Mode: ${modeLabel}${info.runId ? `  ·  Run ${escapeSlack(info.runId)}` : ''}`,
        },
      ],
    },
  ];

  if (hasCritical && config.channels.slackSeniorMention) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${config.channels.slackSeniorMention} critical SLA breaches require senior review.` },
    });
  }
  blocks.push({ type: 'divider' });

  list.slice(0, SLACK_MAX_TICKET_BLOCKS).forEach((s) => {
    const title = s.subject ? `#${s.ticketId}: ${escapeSlack(s.subject)}` : `Ticket #${s.ticketId}`;
    const linked = s.hubspotUrl ? `<${s.hubspotUrl}|${title}>` : title;
    const owner = s.ownerMissing ? '*Unassigned*' : `Owner ID ${escapeSlack(s.ownerId)}`;
    const text = [
      `${LEVEL_EMOJI[s.level]} *${linked}*`,
      `Tier *${s.tier}* · Level *${s.levelName}* · ${owner}`,
      escapeSlack(describeClock('First response', s.firstResponse)),
      escapeSlack(describeClock('Resolution', s.resolution)),
    ].join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(text, SLACK_SECTION_MAX_CHARS) } });
  });

  if (list.length > SLACK_MAX_TICKET_BLOCKS) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `…and ${list.length - SLACK_MAX_TICKET_BLOCKS} more ticket(s). See the n8n execution log for the full list.` }],
    });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Generated by n8n-hubspot-ticket-sla-escalation-router v${ENGINE_VERSION}` }],
  });

  return { channel: config.channels.slackChannel, text: fallbackText, blocks };
}

/** Email digest (subject, plain text and HTML) for senior managers. */
function buildEmailPayload(summaries, config, meta) {
  const list = Array.isArray(summaries) ? summaries : [];
  const info = meta || {};
  const hasCritical = list.some((s) => s.level >= LEVELS.CRITICAL);
  const recipients = config.channels.emailTo.concat(hasCritical ? config.channels.seniorManagerEmails : []);
  const to = recipients.filter((addr, i) => recipients.indexOf(addr) === i);
  const prefix = config.sandboxMode ? '[SANDBOX] ' : '';
  const subject = `${prefix}[SLA ${hasCritical ? 'CRITICAL' : 'BREACH'}] ${list.length} support ticket(s) require escalation`;

  const textLines = [`${list.length} ticket(s) have breached or are about to breach their SLA.`, ''];
  const rows = list.map((s) => {
    textLines.push(
      `- #${s.ticketId}${s.subject ? ` ${s.subject}` : ''} | ${s.tier} | ${s.levelName} | ` +
        `${describeClock('First response', s.firstResponse)} | ${describeClock('Resolution', s.resolution)}` +
        `${s.ownerMissing ? ' | UNASSIGNED' : ''}${s.hubspotUrl ? ` | ${s.hubspotUrl}` : ''}`
    );
    const idCell = s.hubspotUrl ? `<a href="${escapeHtml(s.hubspotUrl)}">#${escapeHtml(s.ticketId)}</a>` : `#${escapeHtml(s.ticketId)}`;
    const color = s.level >= LEVELS.CRITICAL ? '#b42318' : s.level >= LEVELS.BREACHED ? '#c4320a' : '#b54708';
    return (
      '<tr>' +
      `<td style="padding:6px 10px;border-bottom:1px solid #e4e7ec">${idCell}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e4e7ec">${escapeHtml(s.subject || '')}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e4e7ec">${escapeHtml(s.tier)}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e4e7ec;color:${color};font-weight:600">${escapeHtml(s.levelName)}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e4e7ec">${escapeHtml(describeClock('First response', s.firstResponse))}<br>${escapeHtml(describeClock('Resolution', s.resolution))}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e4e7ec">${s.ownerMissing ? '<strong>Unassigned</strong>' : escapeHtml(s.ownerId)}</td>` +
      '</tr>'
    );
  });
  textLines.push('', `Run: ${info.runId || 'n/a'} · Generated by n8n-hubspot-ticket-sla-escalation-router v${ENGINE_VERSION}`);

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#101828">' +
    `<p><strong>${list.length}</strong> support ticket(s) have breached or are about to breach their SLA.</p>` +
    '<table style="border-collapse:collapse;width:100%">' +
    '<thead><tr style="background:#f2f4f7;text-align:left">' +
    '<th style="padding:6px 10px">Ticket</th><th style="padding:6px 10px">Subject</th><th style="padding:6px 10px">Tier</th>' +
    '<th style="padding:6px 10px">Level</th><th style="padding:6px 10px">SLA clocks</th><th style="padding:6px 10px">Owner</th>' +
    '</tr></thead>' +
    `<tbody>${rows.join('')}</tbody></table>` +
    `<p style="color:#667085;font-size:12px">Run ${escapeHtml(info.runId || 'n/a')} · n8n-hubspot-ticket-sla-escalation-router v${ENGINE_VERSION}</p>` +
    '</div>';

  return { from: config.channels.emailFrom, to, subject, text: textLines.join('\n'), html };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Turn evaluations into concrete, channel-specific actions. */
function planActions(evaluations, config, now) {
  const ticketUpdates = [];
  const tasks = [];
  const escalated = [];

  for (const ev of evaluations) {
    if (config.channels.ticketUpdatesEnabled && ev.needsPropertySync) {
      ticketUpdates.push({ ticketId: ev.ticketId, body: buildTicketUpdatePayload(ev, config, now) });
    }
    if (!ev.notify.shouldNotify) continue;
    escalated.push(ev);
    if (ev.notify.channels.indexOf('task') !== -1) {
      tasks.push({ ticketId: ev.ticketId, body: buildTaskPayload(ev, config, now) });
    }
  }

  escalated.sort(
    (a, b) =>
      b.level - a.level ||
      Math.max(b.firstResponse.pctConsumed, b.resolution.pctConsumed) - Math.max(a.firstResponse.pctConsumed, a.resolution.pctConsumed)
  );

  const slackSummaries = escalated.filter((ev) => ev.notify.channels.indexOf('slack') !== -1).map((ev) => toEscalationSummary(ev, config));
  const emailSummaries = escalated.filter((ev) => ev.notify.channels.indexOf('email') !== -1).map((ev) => toEscalationSummary(ev, config));

  return { ticketUpdates, tasks, slackSummaries, emailSummaries, escalatedIds: escalated.map((ev) => ev.ticketId) };
}

/** Sanitized run telemetry: counts and IDs only, never subjects or contact data. */
function buildTelemetry(result, config, meta) {
  const info = meta || {};
  const byLevel = { NONE: 0, WARNING: 0, BREACHED: 0, CRITICAL: 0 };
  const suppressed = {};
  result.evaluations.forEach((ev) => {
    byLevel[ev.levelName] += 1;
    if (!ev.notify.shouldNotify && ev.level > LEVELS.NONE) suppressed[ev.notify.reason] = (suppressed[ev.notify.reason] || 0) + 1;
  });
  const skippedByReason = {};
  result.skipped.forEach((s) => (skippedByReason[s.reason] = (skippedByReason[s.reason] || 0) + 1));

  return {
    engineVersion: ENGINE_VERSION,
    runId: info.runId || null,
    mode: config.sandboxMode ? 'SANDBOX' : 'LIVE',
    evaluatedAt: result.now.toISOString(),
    businessHoursOnly: Boolean(config.businessHours.enabled),
    totals: {
      received: result.received,
      evaluated: result.evaluations.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
      escalated: result.actions.escalatedIds.length,
      ticketUpdates: result.actions.ticketUpdates.length,
      tasks: result.actions.tasks.length,
      slackTickets: result.actions.slackSummaries.length,
      emailTickets: result.actions.emailSummaries.length,
    },
    byLevel,
    suppressed,
    skippedByReason,
    unassignedEscalations: result.evaluations.filter((ev) => ev.notify.shouldNotify && ev.ownerMissing).map((ev) => ev.ticketId),
    fetchErrors: (result.fetchErrors || []).map((e) => ({ status: e.status, rateLimited: e.rateLimited, message: redact(e.message) })),
    engineErrors: result.errors.map((e) => ({ ticketId: e.ticketId, message: redact(e.message) })),
    configWarnings: (config.warnings || []).map(redact),
    escalations: result.evaluations
      .filter((ev) => ev.level > LEVELS.NONE || ev.previousLevel > LEVELS.NONE)
      .map((ev) => ({
        ticketId: ev.ticketId,
        tier: ev.tier,
        level: ev.levelName,
        previousLevel: LEVEL_NAMES[ev.previousLevel],
        firstResponsePct: ev.firstResponse.pctConsumed,
        resolutionPct: ev.resolution.pctConsumed,
        notify: ev.notify.shouldNotify,
        reason: ev.notify.reason,
        channels: ev.notify.shouldNotify ? ev.notify.channels : [],
      })),
  };
}

/**
 * Evaluate a batch of tickets and plan every downstream action.
 * @param {object[]} rawTickets HubSpot ticket objects.
 * @param {object} config Output of loadConfig().
 * @param {Date|string|number} [nowInput] Evaluation instant (defaults to now).
 * @param {object} [meta] { runId, fetchErrors }
 */
function processTickets(rawTickets, config, nowInput, meta) {
  assertConfig(config);
  const info = meta || {};
  const now = parseHubSpotDate(nowInput) || new Date();
  const list = Array.isArray(rawTickets) ? rawTickets : [];
  const evaluations = [];
  const skippedList = [];
  const errors = [];
  const seen = {};

  for (const raw of list) {
    const id = isPlainObject(raw) ? String(raw.id || (raw.properties && raw.properties.hs_object_id) || '') : '';
    if (id && seen[id]) {
      skippedList.push(skipped(id, SKIP_REASONS.DUPLICATE));
      continue;
    }
    if (id) seen[id] = true;
    if (evaluations.length >= config.hubspot.maxTicketsPerRun) {
      skippedList.push(skipped(id, SKIP_REASONS.RUN_LIMIT_REACHED));
      continue;
    }
    try {
      const ev = evaluateTicket(raw, config, now);
      if (ev.skipped) skippedList.push(ev);
      else evaluations.push(ev);
    } catch (err) {
      errors.push({ ticketId: id || null, message: err && err.message ? err.message : String(err) });
    }
  }

  const actions = planActions(evaluations, config, now);
  const result = { now, received: list.length, evaluations, skipped: skippedList, errors, actions, fetchErrors: info.fetchErrors || [] };
  result.telemetry = buildTelemetry(result, config, info);
  return result;
}

/**
 * Convert a processTickets() result into n8n items.
 * Every item carries `kind` (used by the Switch node) and `sandbox` (used by the IF node).
 * The first item is always a `run_summary` with sanitized telemetry.
 */
function toN8nItems(result, config, meta) {
  const info = meta || {};
  const base = { sandbox: Boolean(config.sandboxMode), runId: info.runId || null };
  const items = [{ json: Object.assign({ kind: 'run_summary', status: 'OK' }, base, { telemetry: result.telemetry }) }];

  result.actions.ticketUpdates.forEach((u) => items.push({ json: Object.assign({ kind: 'ticket_update' }, base, u) }));
  result.actions.tasks.forEach((t) => items.push({ json: Object.assign({ kind: 'task_create' }, base, t) }));

  if (result.actions.slackSummaries.length > 0) {
    items.push({
      json: Object.assign({ kind: 'slack_digest' }, base, {
        channel: config.channels.slackChannel,
        escalations: result.actions.slackSummaries,
      }),
    });
  }
  if (result.actions.emailSummaries.length > 0) {
    const email = buildEmailPayload(result.actions.emailSummaries, config, info);
    if (email.to.length > 0) {
      items.push({
        json: Object.assign({ kind: 'email_digest' }, base, email, { ticketIds: result.actions.emailSummaries.map((s) => s.ticketId) }),
      });
    } else {
      // Explicit fallback: never emit an email item without recipients.
      items[0].json.warnings = ['Email escalation skipped: no recipients configured for this escalation level.'];
    }
  }
  return items;
}

/**
 * Summarize planned actions for the sandbox (dry-run) branch.
 * Accepts the raw item JSON produced by toN8nItems().
 */
function buildDryRunReport(itemJsons) {
  const list = (Array.isArray(itemJsons) ? itemJsons : []).filter(isPlainObject);
  const summary = list.find((i) => i.kind === 'run_summary') || null;
  const planned = { ticket_update: [], task_create: [], slack_digest: [], email_digest: [] };
  list.forEach((i) => {
    if (planned[i.kind]) planned[i.kind].push(i);
  });

  const slackTickets = planned.slack_digest.reduce((n, i) => n + (Array.isArray(i.escalations) ? i.escalations.length : 0), 0);
  const emailRecipients = planned.email_digest.reduce((n, i) => n + (Array.isArray(i.to) ? i.to.length : 0), 0);
  const t = summary && summary.telemetry ? summary.telemetry : null;

  const lines = [
    `[sla-router] DRY RUN ${summary && summary.runId ? `run=${summary.runId} ` : ''}status=${summary ? summary.status : 'NO_SUMMARY'}`,
    t
      ? `[sla-router] evaluated=${t.totals.evaluated} skipped=${t.totals.skipped} warning=${t.byLevel.WARNING} breached=${t.byLevel.BREACHED} critical=${t.byLevel.CRITICAL}`
      : '[sla-router] no telemetry available',
    `[sla-router] would PATCH ${planned.ticket_update.length} ticket(s), create ${planned.task_create.length} task(s), ` +
      `post ${planned.slack_digest.length} Slack digest(s) covering ${slackTickets} ticket(s), send ${planned.email_digest.length} email(s) to ${emailRecipients} recipient(s)`,
  ];
  if (t) {
    t.escalations.forEach((e) =>
      lines.push(`[sla-router]   ticket=${e.ticketId} tier=${e.tier} level=${e.level} fr=${e.firstResponsePct}% res=${e.resolutionPct}% notify=${e.notify} reason=${e.reason}`)
    );
    t.fetchErrors.forEach((e) => lines.push(`[sla-router]   fetch-error status=${e.status} rateLimited=${e.rateLimited} ${e.message}`));
  }

  return {
    kind: 'dry_run_report',
    mode: 'SANDBOX',
    status: summary ? summary.status : 'NO_SUMMARY',
    runId: summary ? summary.runId : null,
    planned: {
      ticketUpdates: planned.ticket_update.map((i) => i.ticketId),
      tasks: planned.task_create.map((i) => i.ticketId),
      slackDigests: planned.slack_digest.length,
      slackTickets,
      emailDigests: planned.email_digest.length,
      emailRecipients,
    },
    telemetry: t,
    lines: lines.map(redact),
  };
}

module.exports = {
  ENGINE_VERSION,
  LEVELS,
  LEVEL_NAMES,
  STATUS,
  SKIP_REASONS,
  BASE_TICKET_PROPERTIES,
  SlaEngineError,
  parseHubSpotDate,
  redact,
  escapeSlack,
  escapeHtml,
  businessHoursBetween,
  elapsedHours,
  resolveTier,
  classify,
  channelsForLevel,
  decideNotification,
  evaluateTicket,
  buildSearchRequest,
  extractTicketsFromResponses,
  buildTicketUpdatePayload,
  buildTaskPayload,
  toEscalationSummary,
  buildSlackBlocks,
  buildEmailPayload,
  planActions,
  buildTelemetry,
  processTickets,
  toN8nItems,
  buildDryRunReport,
};
