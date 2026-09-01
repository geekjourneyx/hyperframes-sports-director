(() => {
  const tabs = [...document.querySelectorAll('[data-candidate-tab]')];
  const stages = [...document.querySelectorAll('[data-candidate-stage]')];
  let selectedCandidateId = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.candidateTab;

  function select(candidateId) {
    selectedCandidateId = candidateId;
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.candidateTab === candidateId));
    for (const stage of stages) stage.classList.toggle('is-active', stage.dataset.candidateStage === candidateId);
    const button = document.querySelector('[data-approve]');
    if (button) button.textContent = `Approve ${tabs.find((tab) => tab.dataset.candidateTab === candidateId)?.querySelector('strong')?.textContent ?? 'this direction'}`;
  }

  for (const tab of tabs) tab.addEventListener('click', () => select(tab.dataset.candidateTab));
  const button = document.querySelector('[data-approve]');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    const result = document.querySelector('[data-approval-result]');
    try {
      const displayedArtifactDigests = JSON.parse(document.querySelector('[data-displayed-digests]').textContent);
      const response = await fetch('approval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          selectedCandidateId,
          displayedArtifactDigests,
          workbenchDigest: document.body.dataset.workbenchDigest,
          sessionId: document.querySelector('meta[name="hf-session-id"]').content,
          csrfToken: document.querySelector('meta[name="hf-csrf-token"]').content,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? 'Approval failed');
      result.textContent = 'Approval recorded. Direction lock remains a separate transaction.';
      result.style.color = 'var(--hf-accent)';
    } catch (error) {
      result.textContent = error.message;
      button.disabled = false;
    }
  });
})();
