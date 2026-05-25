function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildPromptProbes(prompts) {
  return (Array.isArray(prompts) ? prompts : [])
    .map(prompt => normalizeText(prompt))
    .filter(Boolean)
    .map(prompt => prompt.slice(0, Math.min(80, prompt.length)))
    .filter(prompt => prompt.length >= 16);
}

async function findSubmitCandidate(flowPage, promptProbes) {
  if (!flowPage || flowPage.isClosed()) return null;

  return flowPage.evaluate((probes) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 24
        && rect.height >= 24
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < window.innerWidth
        && rect.top < window.innerHeight;
    };

    const isEnabled = (el) => {
      return !el.disabled
        && el.getAttribute('aria-disabled') !== 'true'
        && !el.closest('[aria-disabled="true"]');
    };

    const findPromptIndexNearButton = (button) => {
      let parent = button;
      for (let depth = 0; depth < 10 && parent; depth++) {
        const text = normalize(parent.innerText || parent.textContent || '');
        const index = probes.findIndex(probe => probe && text.includes(probe));
        if (index >= 0) return index;
        parent = parent.parentElement;
      }
      return -1;
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(button => isVisible(button) && isEnabled(button));

    const candidates = [];
    for (const button of buttons) {
      const icon = button.querySelector('i.google-symbols, .google-symbols');
      const buttonText = normalize(button.textContent || '');
      const iconText = normalize(icon?.textContent || '');
      const isArrowSubmit = iconText === 'arrow_forward'
        || buttonText === 'arrow_forward'
        || buttonText.includes('arrow_forward');

      if (!isArrowSubmit) continue;

      const promptIndex = findPromptIndexNearButton(button);
      if (promptIndex < 0) continue;

      const rect = button.getBoundingClientRect();
      candidates.push({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        promptIndex,
        text: (button.textContent || '').trim().slice(0, 60),
      });
    }

    candidates.sort((a, b) => {
      if (Math.abs(a.top - b.top) > 8) return b.top - a.top;
      return b.left - a.left;
    });

    return candidates[0] || null;
  }, promptProbes);
}

function startTrustedSubmitWatchdog(flowPage, prompts, options = {}) {
  const promptProbes = buildPromptProbes(prompts);
  const label = options.label || 'FlowSubmitWatchdog';
  const intervalMs = Math.max(250, Number(options.intervalMs) || 700);
  const retryAfterMs = Math.max(1500, Number(options.retryAfterMs) || 6000);
  const candidateStableMs = Math.max(0, Number(options.candidateStableMs) || 4200);
  const clickedAtByPrompt = new Map();
  const firstSeenByPrompt = new Map();
  let stopped = false;
  let clickCount = 0;

  if (promptProbes.length === 0) {
    console.log(`[${label}] Disabled: no prompt probes available.`);
    return {
      stop() { stopped = true; },
      getClickCount() { return clickCount; },
    };
  }

  const loop = async () => {
    if (stopped) return;

    try {
      const candidate = await findSubmitCandidate(flowPage, promptProbes);
      if (candidate) {
        const now = Date.now();
        const firstSeenAt = firstSeenByPrompt.get(candidate.promptIndex) || now;
        firstSeenByPrompt.set(candidate.promptIndex, firstSeenAt);

        if (now - firstSeenAt < candidateStableMs) {
          if (!stopped) {
            setTimeout(loop, intervalMs);
          }
          return;
        }

        const lastClickAt = clickedAtByPrompt.get(candidate.promptIndex) || 0;
        if (now - lastClickAt >= retryAfterMs) {
          clickedAtByPrompt.set(candidate.promptIndex, now);
          clickCount += 1;
          console.log(
            `[${label}] Trusted click prompt ${candidate.promptIndex + 1} at (${Math.round(candidate.x)}, ${Math.round(candidate.y)}), ` +
            `button=${Math.round(candidate.width)}x${Math.round(candidate.height)} "${candidate.text}"`
          );
          await flowPage.bringToFront().catch(() => {});
          await flowPage.mouse.move(candidate.x, candidate.y).catch(() => {});
          await flowPage.mouse.down().catch(() => {});
          await flowPage.waitForTimeout(80).catch(() => {});
          await flowPage.mouse.up().catch(() => {});
        }
      } else {
        firstSeenByPrompt.clear();
      }
    } catch (error) {
      if (!stopped) {
        console.log(`[${label}] Warning: ${error.message}`);
      }
    }

    if (!stopped) {
      setTimeout(loop, intervalMs);
    }
  };

  setTimeout(loop, intervalMs);

  return {
    stop() { stopped = true; },
    getClickCount() { return clickCount; },
  };
}

module.exports = {
  buildPromptProbes,
  startTrustedSubmitWatchdog,
};
