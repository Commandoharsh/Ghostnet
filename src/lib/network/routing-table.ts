/**
 * Phase 4 — Routing Table
 *
 * Maintains a set of route entries toward known destinations and selects the
 * best available route based on hop count and signal quality.  Pure
 * TypeScript; no browser or framework dependencies.
 */

import type { RouteEntry, RouteMetric } from "./mesh-types";

export class RoutingTable {
  /**
   * Map from destinationId → list of RouteEntry objects (one per possible
   * next hop).  Multiple routes to the same destination are kept so that
   * alternative routes survive a primary route failure.
   */
  private readonly routes = new Map<string, RouteEntry[]>();

  // ---------------------------------------------------------------------------
  // Mutation
  // ---------------------------------------------------------------------------

  /**
   * Add or update a route.  If a route with the same (destinationId,
   * nextHopId, adapterId) tuple already exists it is updated in place;
   * otherwise a new entry is appended.
   */
  upsert(
    destinationId: string,
    nextHopId: string,
    adapterId: string,
    metric: RouteMetric,
  ): void {
    if (!destinationId || !nextHopId || !adapterId) return;

    const existing = this.routes.get(destinationId) ?? [];
    const idx = existing.findIndex(
      r => r.nextHopId === nextHopId && r.adapterId === adapterId,
    );

    if (idx >= 0) {
      existing[idx] = {
        ...existing[idx],
        metric,
        active: true,
      };
    } else {
      existing.push({
        destinationId,
        nextHopId,
        adapterId,
        metric,
        active: true,
      });
    }

    this.routes.set(destinationId, existing);
  }

  /**
   * Mark a specific route as inactive (e.g. after a forwarding failure).
   * The entry is kept so that it can be repaired without full rediscovery.
   */
  markFailed(destinationId: string, nextHopId: string): void {
    const entries = this.routes.get(destinationId);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.nextHopId === nextHopId) {
        entry.active = false;
      }
    }
  }

  /**
   * Re-activate a route that was previously marked failed.
   */
  markRecovered(destinationId: string, nextHopId: string): void {
    const entries = this.routes.get(destinationId);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.nextHopId === nextHopId) {
        entry.active = true;
      }
    }
  }

  /** Remove all routes toward a destination. */
  remove(destinationId: string): void {
    this.routes.delete(destinationId);
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  /**
   * Select the best active route to destinationId.
   *
   * Selection criteria (in order):
   *   1. Active routes only.
   *   2. Fewest hops.
   *   3. Highest signal quality as tiebreaker.
   *
   * Returns undefined if no active route exists.
   */
  bestRoute(destinationId: string): RouteEntry | undefined {
    const entries = this.routes.get(destinationId);
    if (!entries) return undefined;

    const active = entries.filter(r => r.active);
    if (active.length === 0) return undefined;

    return active.reduce((best, candidate) => {
      if (candidate.metric.hopCount < best.metric.hopCount) return candidate;
      if (candidate.metric.hopCount === best.metric.hopCount) {
        return candidate.metric.signalQuality > best.metric.signalQuality
          ? candidate
          : best;
      }
      return best;
    });
  }

  /**
   * Return all active routes for a destination, sorted best-first.
   * Useful for alternate route fallback.
   */
  activeRoutes(destinationId: string): RouteEntry[] {
    const entries = this.routes.get(destinationId);
    if (!entries) return [];
    return entries
      .filter(r => r.active)
      .sort((a, b) => {
        const hopDiff = a.metric.hopCount - b.metric.hopCount;
        if (hopDiff !== 0) return hopDiff;
        return b.metric.signalQuality - a.metric.signalQuality;
      })
      .map(r => ({ ...r }));
  }

  /**
   * Return the best alternative route that is NOT via excludeNextHopId.
   * Used to recover after a primary route failure without rediscovery.
   */
  alternativeRoute(
    destinationId: string,
    excludeNextHopId: string,
  ): RouteEntry | undefined {
    const entries = this.routes.get(destinationId);
    if (!entries) return undefined;

    const candidates = entries.filter(
      r => r.active && r.nextHopId !== excludeNextHopId,
    );
    if (candidates.length === 0) return undefined;

    return candidates.reduce((best, candidate) => {
      if (candidate.metric.hopCount < best.metric.hopCount) return candidate;
      if (candidate.metric.hopCount === best.metric.hopCount) {
        return candidate.metric.signalQuality > best.metric.signalQuality
          ? candidate
          : best;
      }
      return best;
    });
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /** Returns all route entries for every known destination. */
  allRoutes(): RouteEntry[] {
    const result: RouteEntry[] = [];
    for (const entries of this.routes.values()) {
      result.push(...entries.map(r => ({ ...r })));
    }
    return result;
  }

  /** Returns true if any active route exists for destinationId. */
  hasRoute(destinationId: string): boolean {
    return this.bestRoute(destinationId) !== undefined;
  }

  /** Number of distinct destination entries in the table. */
  size(): number {
    return this.routes.size;
  }
}
