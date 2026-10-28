// Active Agent leases and maintenance count as activity, even without VNC viewers.
export function watchdogDecision(memory: number, soft: number, hard: number, active: boolean): 'hard' | 'soft' | 'skip' {
  if (hard > 0 && memory >= hard) return 'hard';
  if (soft > 0 && memory >= soft && !active) return 'soft';
  return 'skip';
}
