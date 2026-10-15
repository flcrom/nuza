/** Times, the way a person would say them. */

/** "just now", "5m ago", "3h ago", "2d ago". */
export function agoFor(then: number, now = Date.now()): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** How long something took, the way a person would say it. */
export function tookFor(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** Which day a time falls on, for grouping a list: "Today", "Yesterday" or "Earlier". */
export function dayFor(then: number, now = Date.now()): "Today" | "Yesterday" | "Earlier" {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (then >= midnight.getTime()) return "Today";
  midnight.setDate(midnight.getDate() - 1);
  return then >= midnight.getTime() ? "Yesterday" : "Earlier";
}
