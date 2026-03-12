// ============================================================
// HumanInjector — Content Script side
// Types into LinkedIn's editor like a human.
// LinkedIn watches the Input Stack — paste detection = instant ban.
// We synthesize KeyboardEvents, InputEvents, and backspace typos.
// This file is injected into the LinkedIn tab by the background.
// ============================================================

(function HumanInjector() {

  // ---- Timing profiles (ms per keystroke) ----
  const TYPING_PROFILES = {
    normal: { min: 45, max: 140, pauseChance: 0.08, pauseDuration: [300, 1200] },
    fast:   { min: 25, max: 80,  pauseChance: 0.05, pauseDuration: [200, 600] },
    slow:   { min: 80, max: 220, pauseChance: 0.15, pauseDuration: [500, 2500] }
  };

  // ---- Common typo pairs (key proximity on QWERTY) ----
  const TYPO_MAP = {
    'a': 's', 's': 'a', 'e': 'r', 'r': 'e', 'i': 'o', 'o': 'i',
    'n': 'm', 'm': 'n', 't': 'y', 'y': 't', 'h': 'j', 'j': 'h',
    'l': 'k', 'k': 'l', 'u': 'i', 'c': 'v', 'v': 'c', 'b': 'n'
  };

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // ---- Find LinkedIn's post editor ----
  function findEditor(selectors) {
    const candidates = selectors || [
      '.ql-editor[contenteditable="true"]',
      '.editor-content[contenteditable="true"]',
      '[contenteditable="true"][data-placeholder]',
      '.share-creation-state__content [contenteditable="true"]'
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // ---- Find the "Start a post" button ----
  function findStartPostButton() {
    const candidates = [
      'button[class*="share-box-feed-entry__trigger"]',
      'button[aria-label*="Start a post"]',
      '.share-box-feed-entry__top-bar button',
      '[data-control-name="share.sharebox_placeholder"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // ---- Find the Post submit button ----
  function findSubmitButton() {
    const candidates = [
      'button[class*="share-actions__primary-action"]',
      'button[class*="share-box-send"]',
      'button[aria-label="Post"]',
      '.share-box-footer__main-actions button.artdeco-button--primary'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && !el.disabled) return el;
    }
    return null;
  }

  // ---- Synthesize a real keystroke into a contenteditable ----
  function typeCharacter(el, char) {
    // 1. keydown
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: char, code: `Key${char.toUpperCase()}`,
      bubbles: true, cancelable: true, composed: true
    }));

    // 2. keypress (older LinkedIn listeners)
    el.dispatchEvent(new KeyboardEvent('keypress', {
      key: char, charCode: char.charCodeAt(0),
      bubbles: true, cancelable: true, composed: true
    }));

    // 3. beforeinput (modern React synthetic events)
    el.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: char,
      bubbles: true, cancelable: true, composed: true
    }));

    // 4. Actual DOM insertion (only if the above didn't do it)
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(char);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // 5. input event (React re-render trigger)
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText',
      data: char,
      bubbles: true, composed: true
    }));

    // 6. keyup
    el.dispatchEvent(new KeyboardEvent('keyup', {
      key: char, bubbles: true, composed: true
    }));
  }

  // ---- Synthesize a backspace ----
  function typeBackspace(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', code: 'Backspace',
      bubbles: true, cancelable: true, composed: true
    }));

    el.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true, cancelable: true
    }));

    // Remove last character from DOM
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (range.startOffset > 0) {
        range.setStart(range.startContainer, range.startOffset - 1);
        range.deleteContents();
      }
    }

    el.dispatchEvent(new InputEvent('input', {
      inputType: 'deleteContentBackward',
      bubbles: true
    }));

    el.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Backspace', bubbles: true
    }));
  }

  // ---- Main: type a full text into an element ----
  async function typeText(el, text, profileName = 'normal') {
    const profile = TYPING_PROFILES[profileName];
    let charsSinceTypo = 0;
    const typoInterval = rand(150, 300); // make a typo every N chars

    el.focus();
    await sleep(rand(200, 500));

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // Random thinking pause
      if (Math.random() < profile.pauseChance) {
        await sleep(rand(...profile.pauseDuration));
      }

      // Should we make a typo here?
      const shouldTypo = charsSinceTypo >= typoInterval &&
                         char.match(/[a-z]/) &&
                         TYPO_MAP[char] &&
                         Math.random() < 0.4; // 40% of eligible chars get typo'd

      if (shouldTypo) {
        // Type wrong character
        const wrongChar = TYPO_MAP[char];
        typeCharacter(el, wrongChar);
        await sleep(rand(60, 200));

        // Realize mistake and backspace
        typeBackspace(el);
        await sleep(rand(120, 400));
        charsSinceTypo = 0;
      }

      // Type the correct character
      if (char === '\n') {
        // Line break
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertParagraph', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      } else {
        typeCharacter(el, char);
      }

      charsSinceTypo++;
      await sleep(rand(profile.min, profile.max));
    }

    // Final review pause (humans re-read before posting)
    await sleep(rand(1500, 4000));
  }

  // ---- Open the "Start a post" modal ----
  async function openPostModal() {
    const btn = findStartPostButton();
    if (!btn) throw new Error('START_POST_BTN_NOT_FOUND');

    btn.click();
    await sleep(rand(800, 1500));

    // Wait for editor to appear
    for (let i = 0; i < 20; i++) {
      const editor = findEditor();
      if (editor) return editor;
      await sleep(300);
    }

    throw new Error('EDITOR_NOT_FOUND_AFTER_OPEN');
  }

  // ---- Submit the post ----
  async function submitPost() {
    const btn = findSubmitButton();
    if (!btn) throw new Error('SUBMIT_BTN_NOT_FOUND');

    // One more hover before clicking
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(rand(200, 600));

    btn.click();
    await sleep(rand(1000, 2000));

    return true;
  }

  // ---- Full flow: open modal → type → submit ----
  async function postToLinkedIn(text, options = {}) {
    try {
      console.log('[HumanInjector] Opening post modal...');
      const editor = await openPostModal();

      console.log('[HumanInjector] Typing post...');
      await typeText(editor, text, options.typingProfile || 'normal');

      if (options.dryRun) {
        console.log('[HumanInjector] DRY RUN — not submitting.');
        return { success: true, dryRun: true };
      }

      console.log('[HumanInjector] Submitting...');
      await submitPost();

      console.log('[HumanInjector] Post submitted successfully.');
      return { success: true };

    } catch (err) {
      console.error('[HumanInjector] Failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ---- Comment flow ----
  async function postComment(postElement, commentText, selectors) {
    try {
      // Find comment box within the post
      const commentBoxSelectors = selectors?.commentBox || [
        '.comments-comment-box__form [contenteditable="true"]',
        '.comments-comment-texteditor__content',
        '[contenteditable="true"][role="textbox"]'
      ];

      let commentBox = null;
      for (const sel of commentBoxSelectors) {
        commentBox = postElement?.querySelector(sel) || document.querySelector(sel);
        if (commentBox) break;
      }

      if (!commentBox) {
        // Try clicking the comment button first
        const commentBtn = postElement?.querySelector('button[aria-label*="comment"], button[data-control-name*="comment"]');
        if (commentBtn) {
          commentBtn.click();
          await sleep(rand(600, 1200));

          for (const sel of commentBoxSelectors) {
            commentBox = document.querySelector(sel);
            if (commentBox) break;
          }
        }
      }

      if (!commentBox) throw new Error('COMMENT_BOX_NOT_FOUND');

      commentBox.focus();
      await sleep(rand(300, 700));

      await typeText(commentBox, commentText, 'normal');

      // Find and click submit
      const submitSelectors = selectors?.commentSubmit || [
        'button.comments-comment-box__submit-button',
        'button[type="submit"].comments-comment-box__submit-button--cr'
      ];

      let submitBtn = null;
      for (const sel of submitSelectors) {
        submitBtn = document.querySelector(sel);
        if (submitBtn && !submitBtn.disabled) break;
      }

      if (!submitBtn) throw new Error('COMMENT_SUBMIT_NOT_FOUND');

      submitBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(rand(200, 500));
      submitBtn.click();

      await sleep(rand(800, 1500));
      return { success: true };

    } catch (err) {
      console.error('[HumanInjector] Comment failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ---- Expose to background via message ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'INJECT_POST') {
      postToLinkedIn(msg.text, msg.options || {}).then(sendResponse);
      return true;
    }

    if (msg.type === 'INJECT_COMMENT') {
      const postEl = msg.postUrn
        ? document.querySelector(`[data-urn="${msg.postUrn}"]`)
        : null;
      postComment(postEl, msg.text, msg.selectors).then(sendResponse);
      return true;
    }
  });

  console.log('[HumanInjector] Ready.');
})();
