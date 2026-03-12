// ============================================================
// CircuitBreaker — 3-state machine: CLOSED → OPEN → HALF-OPEN
// With Identity Pivot: 999 doesn't mean quit, means PIVOT.
// ============================================================

import { db } from './db.js';

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };
const RECOVERY_MS = 24 * 60 * 60 * 1000;
const FAILURE_THRESHOLD = 3;
const FALSE_POSITIVE_CODES = new Set([503, 502]); // network blips, not bans

export class CircuitBreaker {
  constructor() {
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.pivotActions = null;
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return;
    const saved = await db.getCircuit();
    if (saved) {
      this.state = saved.state || STATES.CLOSED;
      this.failureCount = saved.failureCount || 0;
      this.lastFailureTime = saved.lastFailureTime || null;
    }
    this._loaded = true;
  }

  async persist() {
    await db.setCircuit({
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    });
  }

  async getStatus() {
    await this.load();
    if (this.state === STATES.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      const remaining = Math.max(0, RECOVERY_MS - elapsed);
      return {
        state: this.state,
        hoursRemaining: Math.ceil(remaining / 3600000),
        pivotRequired: true,
        pivotActions: this._generatePivotActions()
      };
    }
    return { state: this.state, failureCount: this.failureCount };
  }

  // ---- IDENTITY PIVOT: 3 specific human actions to reset trust score ----
  _generatePivotActions() {
    const actions = [
      {
        id: 'like_post',
        label: '👍 Like 3 posts manually',
        description: 'Go to your feed. Like 3 posts from people you actually know. No auto-like.',
        why: 'Resets your "engagement pattern" fingerprint to human baseline',
        url: 'https://www.linkedin.com/feed/'
      },
      {
        id: 'message_friend',
        label: '💬 Send 1 genuine message',
        description: 'Open LinkedIn. Find a connection. Send a real message — even just "Hey, how are things?"',
        why: 'Human-to-human messaging has the highest trust signal weight',
        url: 'https://www.linkedin.com/messaging/'
      },
      {
        id: 'update_skill',
        label: '🛠️ Update your profile',
        description: 'Add or reorder one skill on your profile. Even moving "Python" up one slot counts.',
        why: 'Profile edits signal active account maintenance, not bot activity',
        url: 'https://www.linkedin.com/in/me/'
      },
      {
        id: 'view_profiles',
        label: '👤 View 5 profiles organically',
        description: 'Browse 5 profiles of people in your industry. Spend 10-15 seconds on each.',
        why: 'Dwell time on profiles resets scroll velocity suspicion scores',
        url: 'https://www.linkedin.com/search/results/people/'
      }
    ];

    // Randomize which 3 we pick — don't always suggest the same pattern
    return actions.sort(() => Math.random() - 0.5).slice(0, 3);
  }

  async call(fn) {
    await this.load();

    if (this.state === STATES.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;

      // Check if user completed pivot actions
      const pivotDone = await this._checkPivotCompleted();

      if (pivotDone) {
        console.log('[Circuit] Pivot actions detected. Moving to HALF-OPEN.');
        this.state = STATES.HALF_OPEN;
        await this.persist();
      } else if (elapsed < RECOVERY_MS) {
        const err = new Error('CIRCUIT_OPEN');
        err.circuitData = await this.getStatus();
        throw err;
      } else {
        this.state = STATES.HALF_OPEN;
        await this.persist();
      }
    }

    try {
      const result = await fn();
      await this._onSuccess();
      return result;
    } catch (err) {
      await this._onFailure(err);
      throw err;
    }
  }

  async _onSuccess() {
    if (this.state === STATES.HALF_OPEN) {
      console.log('[Circuit] HALF-OPEN probe succeeded. Closing circuit.');
    }
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    await this.persist();
  }

  async _onFailure(err) {
    // Don't trip on network blips
    if (FALSE_POSITIVE_CODES.has(err.status)) {
      console.log(`[Circuit] Status ${err.status} is a false positive. Not counting.`);
      return;
    }

    const isLinkedInBlock = [429, 999, 403].includes(err.status);
    if (!isLinkedInBlock) return;

    this.failureCount++;
    this.lastFailureTime = Date.now();

    const immediate = err.status === 999 || this.failureCount >= FAILURE_THRESHOLD;

    if (immediate) {
      this.state = STATES.OPEN;
      await this.persist();

      const pivotActions = this._generatePivotActions();

      // Notify with Identity Pivot instructions
      chrome.notifications.create('circuit-open', {
        type: 'basic',
        iconUrl: '../icons/icon48.png',
        title: '🔴 Ghost Engine — Account Protection Active',
        message: `LinkedIn flagged activity (${err.status}). Auto-paused. Check extension for recovery steps.`
      });

      // Store pivot actions for popup to display
      await db.setCircuit({
        state: this.state,
        failureCount: this.failureCount,
        lastFailureTime: this.lastFailureTime,
        pivotActions
      });
    }
  }

  // Heuristic: check if recent activity suggests human actions were taken
  async _checkPivotCompleted() {
    const saved = await db.getCircuit();
    return saved && saved.pivotCompleted === true;
  }

  async markPivotCompleted() {
    const saved = await db.getCircuit();
    if (saved) {
      await db.setCircuit({ ...saved, pivotCompleted: true });
    }
  }
}

export const breaker = new CircuitBreaker();
