// ============================================================
// Ghost Scroller — Content Script
// Runs on linkedin.com. Generates real browser telemetry:
// scroll events, mouse moves, dwell time.
// LinkedIn's fraud engine reads these from the page context.
// A background fetch with zero scroll events = instant flag.
// ============================================================

(function GhostScroller() {
  let isActive = false;
  let sessionDwellStart = Date.now();

  // ---- Biometric simulation parameters ----
  const HUMAN_SCROLL_SPEED = { min: 80, max: 220 }; // px per event
  const SCROLL_PAUSE = { min: 800, max: 3200 };       // ms between scrolls
  const READ_DWELL = { min: 2000, max: 8000 };         // ms "reading" a post
  const MOUSE_JITTER = { min: 3, max: 18 };            // px deviation

  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ---- Synthesize a human scroll event ----
  function dispatchScroll(deltaY) {
    const wheelEvent = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      deltaMode: 0
    });
    document.dispatchEvent(wheelEvent);
    window.scrollBy({ top: deltaY, behavior: 'smooth' });
  }

  // ---- Synthesize realistic mouse movement ----
  function ghostMouseMove(x, y) {
    const steps = rand(3, 8);
    const startX = x - rand(20, 60);
    const startY = y - rand(10, 30);

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      // Cubic easing — humans don't move in straight lines
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;

      const curX = Math.round(startX + (x - startX) * eased + rand(-MOUSE_JITTER.min, MOUSE_JITTER.max));
      const curY = Math.round(startY + (y - startY) * eased + rand(-MOUSE_JITTER.min, MOUSE_JITTER.max));

      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: curX,
        clientY: curY,
        screenX: curX + window.screenX,
        screenY: curY + window.screenY
      }));
    }
  }

  // ---- "Read" a post: hover, dwell, simulate attention ----
  async function dwellOnPost(postElement) {
    if (!postElement) return;

    const rect = postElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 3;

    ghostMouseMove(centerX + rand(-30, 30), centerY + rand(-20, 20));
    await sleep(rand(READ_DWELL.min, READ_DWELL.max));

    // Simulate partial scroll within post (reading to bottom)
    dispatchScroll(rand(40, 120));
    await sleep(rand(400, 900));
  }

  // ---- Main ghost scroll session ----
  async function runGhostSession(targetPostCount = 10) {
    if (isActive) return;
    isActive = true;

    console.log('[Ghost] Starting biometric session for', targetPostCount, 'posts');

    try {
      let postsProcessed = 0;
      let lastScrollPosition = window.scrollY;

      // Phase 1: Initial page load dwell (human reads above-fold first)
      await sleep(rand(1500, 3500));

      while (postsProcessed < targetPostCount) {
        // Find visible posts
        const posts = document.querySelectorAll(
          '.feed-shared-update-v2, [data-urn*="activity"], .occludable-update'
        );

        const visiblePosts = Array.from(posts).filter(p => {
          const rect = p.getBoundingClientRect();
          return rect.top >= 0 && rect.top < window.innerHeight;
        });

        for (const post of visiblePosts.slice(0, 2)) {
          await dwellOnPost(post);
          postsProcessed++;

          if (postsProcessed >= targetPostCount) break;
        }

        // Scroll down like a human — variable speed, occasional pause
        const scrollAmount = rand(HUMAN_SCROLL_SPEED.min, HUMAN_SCROLL_SPEED.max);
        dispatchScroll(scrollAmount);
        await sleep(rand(SCROLL_PAUSE.min, SCROLL_PAUSE.max));

        // Occasionally scroll back up a bit (humans do this)
        if (Math.random() < 0.15) {
          dispatchScroll(-rand(30, 80));
          await sleep(rand(600, 1200));
        }

        // Break if page isn't growing
        if (window.scrollY === lastScrollPosition) break;
        lastScrollPosition = window.scrollY;
      }

      console.log('[Ghost] Session complete. Posts dwelt:', postsProcessed);
      isActive = false;
      return { success: true, dwelt: postsProcessed };

    } catch (err) {
      console.error('[Ghost] Session error:', err);
      isActive = false;
      return { success: false, error: err.message };
    }
  }

  // ---- Extract post data from DOM after ghost scroll ----
  function extractVisiblePosts() {
    const posts = document.querySelectorAll(
      '.feed-shared-update-v2, [data-urn*="activity"]'
    );

    return Array.from(posts).slice(0, 15).map(post => {
      const textEl = post.querySelector('.feed-shared-text, .break-words');
      const authorEl = post.querySelector('.feed-shared-actor__name, .update-components-actor__name');
      const urnAttr = post.getAttribute('data-urn') ||
        post.querySelector('[data-urn]')?.getAttribute('data-urn') || '';

      return {
        urn: urnAttr,
        text: textEl?.innerText?.trim() || '',
        author: authorEl?.innerText?.trim() || 'Unknown',
        element: post
      };
    }).filter(p => p.text.length > 50);
  }

  // ---- Message listener from background ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GHOST_SCROLL_START') {
      runGhostSession(msg.count || 10)
        .then(result => {
          const posts = extractVisiblePosts();
          sendResponse({ ...result, posts: posts.map(p => ({
            urn: p.urn,
            text: p.text,
            author: p.author
          }))});
        });
      return true; // async
    }

    if (msg.type === 'GET_DWELL_STATS') {
      sendResponse({
        sessionDuration: Date.now() - sessionDwellStart,
        isActive
      });
    }
  });

  // Passive telemetry: report dwell to background every 30s
  setInterval(() => {
    chrome.runtime.sendMessage({
      type: 'DWELL_PING',
      duration: Date.now() - sessionDwellStart
    }).catch(() => {});
  }, 30000);

})();
