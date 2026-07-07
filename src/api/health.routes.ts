/** Health check payload (design §12 api/health). Wire to an HTTP server as needed. */
export interface HealthStatus {
  status: 'ok';
  uptime_s: number;
  ts: string;
}

export function healthCheck(): HealthStatus {
  return { status: 'ok', uptime_s: Math.round(process.uptime()), ts: new Date().toISOString() };
}
