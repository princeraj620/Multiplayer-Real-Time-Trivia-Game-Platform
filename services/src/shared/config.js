// Every setting comes from an environment variable, with a default that works for local development.
// See .env.example in the repository root for what each one does.
const env = process.env;
const num = (key, def) => (env[key] !== undefined && env[key] !== '' ? Number(env[key]) : def);
const bool = (key, def) => (env[key] === undefined || env[key] === '' ? def : ['1', 'true', 'yes', 'on'].includes(String(env[key]).toLowerCase()));
const list = (key, def) => (env[key] ? env[key].split(',').map((s) => s.trim()).filter(Boolean) : def);

export const config = {
  service: env.SERVICE || 'unknown',
  instanceId: env.INSTANCE_ID || `${env.SERVICE || 'svc'}-${process.pid}`,
  port: num('PORT', 3000),
  logLevel: env.LOG_LEVEL || 'info',

  redisUrl: env.REDIS_URL || 'redis://:buzzarena@localhost:6383',
  pgPrimaryUrl: env.PG_PRIMARY_URL || 'postgres://buzzarena:buzzarena@localhost:5438/buzzarena',
  pgReplicaUrl: env.PG_REPLICA_URL || env.PG_PRIMARY_URL || 'postgres://buzzarena:buzzarena@localhost:5439/buzzarena',
  etcdEndpoints: list('ETCD_ENDPOINTS', ['http://localhost:2379', 'http://localhost:2479', 'http://localhost:2579']),

  // Authentication
  jwtIssuer: 'buzzarena-auth',
  jwtAudience: 'buzzarena',
  accessTokenTtlSec: num('ACCESS_TOKEN_TTL_SEC', 900),
  refreshTokenTtlSec: num('REFRESH_TOKEN_TTL_SEC', 7 * 24 * 3600),
  wsTicketTtlSec: num('WS_TICKET_TTL_SEC', 30),
  authJwksUrl: env.AUTH_JWKS_URL || 'http://localhost:3101/api/auth/.well-known/jwks.json',
  cookieSecure: bool('COOKIE_SECURE', true),
  allowedOrigins: list('ALLOWED_ORIGINS', ['https://localhost:8443', 'http://localhost:8080', 'http://localhost:5173']),
  loadtestMode: bool('LOADTEST_MODE', false),
  loadtestSecret: env.LOADTEST_SECRET || '',

  // Encryption at rest. "kid:base64key,kid2:base64key2". The active key encrypts; any listed key decrypts.
  dataKeys: env.DATA_KEYS || 'k1:0Ghvzq4sVdEkVSe0lX1U2F1cmWgC4Xl9d0ZyH2uX9R4=',
  dataKeyActive: env.DATA_KEY_ACTIVE || 'k1',

  // The game
  countdownSec: num('COUNTDOWN_SEC', 5),
  questionSec: num('QUESTION_SEC', 10),
  revealSec: num('REVEAL_SEC', 4),
  leaderboardSec: num('LEADERBOARD_SEC', 4),
  answerGraceMs: num('ANSWER_GRACE_MS', 300),
  leaseTtlSec: num('LEADER_LEASE_TTL_SEC', 5),
  // Self-fencing: stop acting as leader as soon as the lease cannot be proven alive. Turn it off
  // (SELF_FENCING=false) to watch the second line of defence, the fencing token, catch a stale leader.
  selfFencing: bool('SELF_FENCING', true),
  campaignDelayPerGameMs: num('CAMPAIGN_DELAY_PER_GAME_MS', 250),

  // Gateways
  heartbeatSec: num('WS_HEARTBEAT_SEC', 25),
  slowSocketDropBytes: num('WS_SLOW_DROP_BYTES', 1_000_000),
  slowSocketCloseBytes: num('WS_SLOW_CLOSE_BYTES', 4_000_000),
  answerBurst: num('ANSWER_RATE_BURST', 5),
  answerPerSec: num('ANSWER_RATE_PER_SEC', 1),
  resumeLogSize: num('RESUME_LOG_SIZE', 500),

  // Rate limits (HTTP)
  loginBurst: num('LOGIN_RATE_BURST', 10),
  loginPerSec: num('LOGIN_RATE_PER_SEC', 0.2),

  // Observability
  otlpUrl: env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
  traceSampleRatio: num('TRACE_SAMPLE_RATIO', 1),
  lokiUrl: env.LOKI_URL || '',
  prometheusUrl: env.PROMETHEUS_URL || 'http://localhost:9090',
  prometheusUiUrl: env.PROMETHEUS_UI_URL || 'http://localhost:9090',
  alertmanagerUrl: env.ALERTMANAGER_URL || 'http://localhost:9093',
  jaegerUiUrl: env.JAEGER_UI_URL || 'http://localhost:16686',
  grafanaUrl: env.GRAFANA_URL || 'http://localhost:3000',
};
