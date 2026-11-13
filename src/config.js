'use strict';

/**
 * src/config.js
 * ---------------------------------------------------------------------------
 * Environment variable parser and validator for the
 * n8n-hubspot-ticket-sla-escalation-router.
 *
 * Design rules
 *  - Zero dependencies and no `require()` calls: this file is inlined verbatim
 *    into n8n Code nodes by scripts/build-workflow.js, where `require` is
 *    usually unavailable.
 *  - Fail fast: every problem found is collected and thrown together in a
 *    single ConfigError, before any API call or notification can happen.
 *  - Placeholders (values beginning with YOUR_ / your- / REPLACE_) are treated
 *    as "not configured". In SANDBOX_MODE they only produce warnings; in live
 *    mode they are fatal for every setting a live run depends on.
 *  - No secrets are read here. HubSpot / Slack / SMTP credentials live in the
 *    n8n credential store, never in environment variables or workflow JSON.
 * ---------------------------------------------------------------------------
 */

/** Every environment key the router understands (used to read n8n's $env safely). */
const ENV_KEYS = Object.freeze([
  'SANDBOX_MODE',
  // HubSpot
  'HUBSPOT_PORTAL_ID',
  'HUBSPOT_PIPELINE_ID',
  'HUBSPOT_APP_BASE_URL',
  'HUBSPOT_FALLBACK_OWNER_ID',
  'HUBSPOT_TASK_TICKET_ASSOCIATION_TYPE_ID',
  'HUBSPOT_FIRST_RESPONSE_PROPERTY',
  'HUBSPOT_SEARCH_PAGE_SIZE',
  'MAX_TICKETS_PER_RUN',
  // SLA tiers
  'SLA_P1_FIRST_RESPONSE_HOURS',
  'SLA_P1_RESOLUTION_HOURS',
  'SLA_P2_FIRST_RESPONSE_HOURS',
  'SLA_P2_RESOLUTION_HOURS',
  'SLA_P3_FIRST_RESPONSE_HOURS',
  'SLA_P3_RESOLUTION_HOURS',
  'SLA_DEFAULT_TIER',
  'SLA_PRIORITY_MAP',
  'SLA_WARNING_THRESHOLD_PCT',
  'SLA_CRITICAL_THRESHOLD_PCT',
  // Business hours
  'SLA_BUSINESS_HOURS_ONLY',
  'BUSINESS_HOURS_START',
  'BUSINESS_HOURS_END',
  'BUSINESS_DAYS',
  'BUSINESS_TZ_OFFSET_MINUTES',
  // Escalation policy
  'ESCALATION_COOLDOWN_HOURS',
  'ESCALATION_SLACK_MIN_LEVEL',
  'ESCALATION_EMAIL_MIN_LEVEL',
  'ESCALATION_TASK_MIN_LEVEL',
  'ESCALATION_TASK_DUE_HOURS',
  'INCLUDE_TICKET_SUBJECT',
  // Channels
  'ENABLE_SLACK',
  'SLACK_CHANNEL',
  'SLACK_SENIOR_MENTION',
  'ENABLE_EMAIL',
  'ESCALATION_EMAIL_FROM',
  'ESCALATION_EMAIL_TO',
  'SENIOR_MANAGER_EMAILS',
  'ENABLE_HUBSPOT_TASKS',
  'ENABLE_TICKET_UPDATES',
  // Custom HubSpot ticket properties written back by the router
  'PROP_ESCALATION_LEVEL',
  'PROP_LAST_ESCALATED_AT',
  'PROP_SLA_STATUS',
]);

/** Safe defaults. SANDBOX_MODE defaults to true so a fresh install can never send anything. */
const DEFAULTS = Object.freeze({
  SANDBOX_MODE: 'true',
  HUBSPOT_PORTAL_ID: '',
  HUBSPOT_PIPELINE_ID: '',
  HUBSPOT_APP_BASE_URL: 'https://app.hubspot.com',
  HUBSPOT_FALLBACK_OWNER_ID: '',
  HUBSPOT_TASK_TICKET_ASSOCIATION_TYPE_ID: '230',
  HUBSPOT_FIRST_RESPONSE_PROPERTY: 'first_agent_reply_date',
  HUBSPOT_SEARCH_PAGE_SIZE: '100',
  MAX_TICKETS_PER_RUN: '500',
  SLA_P1_FIRST_RESPONSE_HOURS: '1',
  SLA_P1_RESOLUTION_HOURS: '8',
  SLA_P2_FIRST_RESPONSE_HOURS: '4',
  SLA_P2_RESOLUTION_HOURS: '24',
  SLA_P3_FIRST_RESPONSE_HOURS: '8',
  SLA_P3_RESOLUTION_HOURS: '72',
  SLA_DEFAULT_TIER: 'P3',
  SLA_PRIORITY_MAP: 'URGENT:P1,HIGH:P1,MEDIUM:P2,LOW:P3',
  SLA_WARNING_THRESHOLD_PCT: '80',
  SLA_CRITICAL_THRESHOLD_PCT: '150',
  SLA_BUSINESS_HOURS_ONLY: 'false',
  BUSINESS_HOURS_START: '9',
  BUSINESS_HOURS_END: '17',
  BUSINESS_DAYS: '1,2,3,4,5',
  BUSINESS_TZ_OFFSET_MINUTES: '0',
  ESCALATION_COOLDOWN_HOURS: '4',
  ESCALATION_SLACK_MIN_LEVEL: '1',
  ESCALATION_EMAIL_MIN_LEVEL: '3',
  ESCALATION_TASK_MIN_LEVEL: '2',
  ESCALATION_TASK_DUE_HOURS: '2',
  INCLUDE_TICKET_SUBJECT: 'true',
  ENABLE_SLACK: 'true',
  SLACK_CHANNEL: '#support-escalations',
  SLACK_SENIOR_MENTION: '',
  ENABLE_EMAIL: 'true',
  ESCALATION_EMAIL_FROM: '',
  ESCALATION_EMAIL_TO: '',
  SENIOR_MANAGER_EMAILS: '',
  ENABLE_HUBSPOT_TASKS: 'true',
  ENABLE_TICKET_UPDATES: 'true',
  PROP_ESCALATION_LEVEL: 'sla_escalation_level',
  PROP_LAST_ESCALATED_AT: 'sla_last_escalated_at',
  PROP_SLA_STATUS: 'sla_status',
});

const TIERS = Object.freeze(['P1', 'P2', 'P3']);
const PLACEHOLDER_PATTERN = /^<?(your[-_]|YOUR_|REPLACE_)/;
const EMAIL_PATTERN = /^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[A-Za-z]{2,}$/;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/** Thrown when configuration is invalid. `problems` lists every individual issue. */
class ConfigError extends Error {
  constructor(problems) {
    super('Invalid SLA router configuration:\n  - ' + problems.join('\n  - '));
    this.name = 'ConfigError';
    this.problems = problems.slice();
  }
}

/** True when a value is a template placeholder rather than a real setting. */
function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER_PATTERN.test(value.trim());
}

/**
 * Build a small reader around the raw env object that records problems
 * instead of throwing on the first one.
 */
function createReader(env, problems) {
  const source = env && typeof env === 'object' ? env : {};

  /** Raw string value with default applied; empty strings fall back to the default. */
  function raw(key) {
    let value;
    try {
      value = source[key];
    } catch (err) {
      value = undefined; // n8n can block $env access; treat as unset.
    }
    if (value === undefined || value === null || String(value).trim() === '') {
      return DEFAULTS[key] !== undefined ? DEFAULTS[key] : '';
    }
    return String(value).trim();
  }

  function str(key) {
    const value = raw(key);
    return isPlaceholder(value) ? '' : value;
  }

  function bool(key) {
    const value = raw(key).toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(value)) return true;
    if (['false', '0', 'no', 'off'].includes(value)) return false;
    problems.push(`${key} must be a boolean (true/false), received "${value}"`);
    return DEFAULTS[key] === 'true';
  }

  function num(key, opts) {
    const options = opts || {};
    const value = raw(key);
    const parsed = Number(value);
    if (value === '' || !Number.isFinite(parsed)) {
      problems.push(`${key} must be a number, received "${value}"`);
      return Number(DEFAULTS[key]) || 0;
    }
    if (options.integer && !Number.isInteger(parsed)) {
      problems.push(`${key} must be an integer, received "${value}"`);
    }
    if (options.min !== undefined && parsed < options.min) {
      problems.push(`${key} must be >= ${options.min}, received ${parsed}`);
    }
    if (options.max !== undefined && parsed > options.max) {
      problems.push(`${key} must be <= ${options.max}, received ${parsed}`);
    }
    if (options.exclusiveMin !== undefined && parsed <= options.exclusiveMin) {
      problems.push(`${key} must be > ${options.exclusiveMin}, received ${parsed}`);
    }
    return parsed;
  }

  function list(key) {
    return str(key)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !isPlaceholder(part));
  }

  return { raw, str, bool, num, list };
}

/** Parse "URGENT:P1,HIGH:P1,..." into a frozen { URGENT: 'P1', ... } map. */
function parsePriorityMap(value, problems) {
  const map = {};
  const pairs = String(value || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (pairs.length === 0) {
    problems.push('SLA_PRIORITY_MAP must contain at least one PRIORITY:TIER pair');
  }
  for (const pair of pairs) {
    const [rawPriority, rawTier] = pair.split(':').map((p) => (p || '').trim().toUpperCase());
    if (!rawPriority || !TIERS.includes(rawTier)) {
      problems.push(`SLA_PRIORITY_MAP entry "${pair}" must look like HIGH:P1 (tiers: ${TIERS.join(', ')})`);
      continue;
    }
    map[rawPriority] = rawTier;
  }
  return Object.freeze(map);
}

/** Recursively freeze a plain object so Code nodes cannot mutate shared config. */
function deepFreeze(obj) {
  Object.values(obj).forEach((value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  });
  return Object.freeze(obj);
}

/**
 * Parse and validate configuration.
 *
 * @param {Record<string, string|undefined>} [env] Environment map (process.env in Node, $env in n8n).
 * @returns {object} Deeply frozen configuration object.
 * @throws {ConfigError} When any setting is invalid.
 */
function loadConfig(env) {
  const sourceEnv = env !== undefined ? env : typeof process !== 'undefined' && process.env ? process.env : {};
  const problems = [];
  const warnings = [];
  const r = createReader(sourceEnv, problems);

  const sandboxMode = r.bool('SANDBOX_MODE');

  // --- SLA tiers -----------------------------------------------------------
  const tiers = {};
  for (const tier of TIERS) {
    const firstResponseHours = r.num(`SLA_${tier}_FIRST_RESPONSE_HOURS`, { exclusiveMin: 0, max: 8760 });
    const resolutionHours = r.num(`SLA_${tier}_RESOLUTION_HOURS`, { exclusiveMin: 0, max: 8760 });
    if (resolutionHours < firstResponseHours) {
      problems.push(`SLA_${tier}_RESOLUTION_HOURS (${resolutionHours}) must be >= SLA_${tier}_FIRST_RESPONSE_HOURS (${firstResponseHours})`);
    }
    tiers[tier] = { firstResponseHours, resolutionHours };
  }
  // Tiers should get stricter as priority rises; warn (not fail) if they do not.
  if (tiers.P1.resolutionHours > tiers.P2.resolutionHours || tiers.P2.resolutionHours > tiers.P3.resolutionHours) {
    warnings.push('Resolution targets are not ordered P1 <= P2 <= P3; confirm this is intentional.');
  }

  const defaultTier = r.raw('SLA_DEFAULT_TIER').toUpperCase();
  if (!TIERS.includes(defaultTier)) {
    problems.push(`SLA_DEFAULT_TIER must be one of ${TIERS.join(', ')}, received "${defaultTier}"`);
  }

  const priorityMap = parsePriorityMap(r.raw('SLA_PRIORITY_MAP'), problems);

  const warningPct = r.num('SLA_WARNING_THRESHOLD_PCT', { exclusiveMin: 0 });
  const criticalPct = r.num('SLA_CRITICAL_THRESHOLD_PCT', { max: 10000 });
  if (!(warningPct < 100)) problems.push('SLA_WARNING_THRESHOLD_PCT must be below 100');
  if (!(criticalPct > 100)) problems.push('SLA_CRITICAL_THRESHOLD_PCT must be above 100');

  // --- Business hours ------------------------------------------------------
  const businessHoursEnabled = r.bool('SLA_BUSINESS_HOURS_ONLY');
  const startHour = r.num('BUSINESS_HOURS_START', { min: 0, max: 24 });
  const endHour = r.num('BUSINESS_HOURS_END', { min: 0, max: 24 });
  if (!(startHour < endHour)) problems.push('BUSINESS_HOURS_START must be earlier than BUSINESS_HOURS_END');
  const days = r
    .list('BUSINESS_DAYS')
    .map(Number)
    .filter((d) => Number.isInteger(d));
  if (days.length === 0 || days.some((d) => d < 0 || d > 6)) {
    problems.push('BUSINESS_DAYS must be a comma-separated list of weekday numbers 0-6 (0 = Sunday)');
  }
  const tzOffsetMinutes = r.num('BUSINESS_TZ_OFFSET_MINUTES', { integer: true, min: -840, max: 840 });

  // --- Escalation policy ---------------------------------------------------
  const levelOpts = { integer: true, min: 1, max: 3 };
  const escalation = {
    cooldownHours: r.num('ESCALATION_COOLDOWN_HOURS', { min: 0, max: 720 }),
    slackMinLevel: r.num('ESCALATION_SLACK_MIN_LEVEL', levelOpts),
    emailMinLevel: r.num('ESCALATION_EMAIL_MIN_LEVEL', levelOpts),
    taskMinLevel: r.num('ESCALATION_TASK_MIN_LEVEL', levelOpts),
    taskDueHours: r.num('ESCALATION_TASK_DUE_HOURS', { min: 0, max: 720 }),
    includeSubject: r.bool('INCLUDE_TICKET_SUBJECT'),
  };

  // --- Channels ------------------------------------------------------------
  const channels = {
    slackEnabled: r.bool('ENABLE_SLACK'),
    slackChannel: r.str('SLACK_CHANNEL'),
    slackSeniorMention: r.str('SLACK_SENIOR_MENTION'),
    emailEnabled: r.bool('ENABLE_EMAIL'),
    emailFrom: r.str('ESCALATION_EMAIL_FROM'),
    emailTo: r.list('ESCALATION_EMAIL_TO'),
    seniorManagerEmails: r.list('SENIOR_MANAGER_EMAILS'),
    tasksEnabled: r.bool('ENABLE_HUBSPOT_TASKS'),
    ticketUpdatesEnabled: r.bool('ENABLE_TICKET_UPDATES'),
  };

  for (const address of [channels.emailFrom, ...channels.emailTo, ...channels.seniorManagerEmails]) {
    if (address && !EMAIL_PATTERN.test(address)) problems.push(`"${address}" is not a valid email address`);
  }

  // --- HubSpot -------------------------------------------------------------
  const portalId = r.str('HUBSPOT_PORTAL_ID');
  if (portalId && !/^\d+$/.test(portalId)) problems.push('HUBSPOT_PORTAL_ID must be numeric');
  const pipelineId = r.str('HUBSPOT_PIPELINE_ID');
  const fallbackOwnerId = r.str('HUBSPOT_FALLBACK_OWNER_ID');
  if (fallbackOwnerId && !/^\d+$/.test(fallbackOwnerId)) problems.push('HUBSPOT_FALLBACK_OWNER_ID must be numeric');
  const appBaseUrl = r.raw('HUBSPOT_APP_BASE_URL').replace(/\/+$/, '');
  if (!/^https:\/\/[^\s]+$/.test(appBaseUrl)) problems.push('HUBSPOT_APP_BASE_URL must be an https:// URL');

  const hubspot = {
    portalId,
    pipelineId,
    appBaseUrl,
    fallbackOwnerId,
    taskTicketAssociationTypeId: r.num('HUBSPOT_TASK_TICKET_ASSOCIATION_TYPE_ID', { integer: true, min: 1 }),
    firstResponseProperty: r.raw('HUBSPOT_FIRST_RESPONSE_PROPERTY'),
    searchPageSize: r.num('HUBSPOT_SEARCH_PAGE_SIZE', { integer: true, min: 1, max: 200 }),
    maxTicketsPerRun: r.num('MAX_TICKETS_PER_RUN', { integer: true, min: 1, max: 10000 }),
  };

  const properties = {
    escalationLevel: r.raw('PROP_ESCALATION_LEVEL'),
    lastEscalatedAt: r.raw('PROP_LAST_ESCALATED_AT'),
    status: r.raw('PROP_SLA_STATUS'),
  };
  for (const [label, name] of Object.entries({ ...properties, firstResponseProperty: hubspot.firstResponseProperty })) {
    if (!PROPERTY_NAME_PATTERN.test(name)) problems.push(`HubSpot property name for ${label} ("${name}") must be lowercase snake_case`);
  }

  // --- Live-mode requirements (fail fast) ----------------------------------
  const liveIssues = [];
  if (channels.slackEnabled && !channels.slackChannel) liveIssues.push('SLACK_CHANNEL is required when ENABLE_SLACK=true');
  if (channels.emailEnabled) {
    if (!channels.emailFrom) liveIssues.push('ESCALATION_EMAIL_FROM is required when ENABLE_EMAIL=true');
    if (channels.emailTo.length === 0 && channels.seniorManagerEmails.length === 0) {
      liveIssues.push('ESCALATION_EMAIL_TO or SENIOR_MANAGER_EMAILS is required when ENABLE_EMAIL=true');
    }
  }
  if (!portalId) liveIssues.push('HUBSPOT_PORTAL_ID is not set; ticket links will be omitted from notifications');

  if (sandboxMode) {
    liveIssues.forEach((issue) => warnings.push(`[sandbox] ${issue}`));
  } else {
    // Missing portal ID only degrades links; everything else blocks a live run.
    liveIssues.forEach((issue) => (issue.startsWith('HUBSPOT_PORTAL_ID') ? warnings.push(issue) : problems.push(issue)));
    const demoDomains = /@(example\.(com|org|net)|domain\.com)$/i;
    [channels.emailFrom, ...channels.emailTo, ...channels.seniorManagerEmails]
      .filter((a) => a && demoDomains.test(a))
      .forEach((a) => warnings.push(`Live mode is using a placeholder email address: ${a}`));
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return deepFreeze({
    sandboxMode,
    hubspot,
    sla: {
      tiers,
      defaultTier,
      priorityMap,
      warningPct,
      criticalPct,
    },
    businessHours: { enabled: businessHoursEnabled, startHour, endHour, days, tzOffsetMinutes },
    escalation,
    channels,
    properties,
    warnings,
  });
}

module.exports = {
  ENV_KEYS,
  DEFAULTS,
  TIERS,
  ConfigError,
  isPlaceholder,
  parsePriorityMap,
  loadConfig,
};
